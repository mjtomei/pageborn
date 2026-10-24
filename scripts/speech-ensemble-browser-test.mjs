// Actual three-model browser inference. SDK storage/display and the agent are
// fixtures; no audio or questions go to a real agent. No physical phone claim.
import { chromium, webkit, expect } from '@playwright/test';
import express from 'express';
import { createApp } from '../server/app.js';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { showLibrary, backToReading, showSettings } from './ui-helpers.mjs';
import { AtomicPhoneValue } from '../src/phone-storage.js';
const useWebkit = process.argv.includes('--webkit');
const research = path.resolve(process.env.BROWSER_STT_RESEARCH || '../browser-stt');
const models = path.resolve(process.env.PAGEBORNE_TEST_MODEL_DIR || path.join(research, '.state/ensemble/models'));
const manifest = JSON.parse(await readFile('node_modules/@pageborne/browser-stt/vendor/stt/ensemble-models.json'));
const files = manifest.flatMap(m => m.files.filter(f => f.url).map(f => ({ ...f, path: path.join(models, m.directory, f.file) })));
const counters = { downloads: 0, bytes: 0 }, allowed = new Set(); let offline = false, failFirstDownload = true;
const moduleRequests = [];
const serve = async () => {
  const app = express();
  app.get('/models/:hash', (req, res) => {
    const file = files.find(f => f.sha256 === req.params.hash); if (!file || offline) { res.sendStatus(503); return; }
    if (failFirstDownload) { failFirstDownload = false; res.sendStatus(503); return; }
    counters.downloads++; counters.bytes += file.bytes; res.sendFile(file.path, { dotfiles: 'allow' });
  });
  // Reproduce a native localhost server that does not know the .mjs MIME type.
  // Sherpa must use its bundled source; ORT's typed-Blob loader must still work.
  app.use((req, res, next) => {
    if (!req.path.endsWith('.mjs')) return next();
    moduleRequests.push(req.path);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.sendFile(req.path, { root: path.resolve('dist') });
  });
  app.use(createApp({ distDir: path.resolve('dist') }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); allowed.add(`http://127.0.0.1:${server.address().port}`); return server;
};
const servers = [await serve()];
const browser = await (useWebkit ? webkit : chromium).launch({ headless: true, executablePath: useWebkit ? process.env.WEBKIT_PATH : '/usr/bin/google-chrome' });
const out = 'test-results/speech-ensemble'; await mkdir(out, { recursive: true });
const report = { engine: useWebkit ? 'webkit' : 'chromium', physicalPhone: false, moduleMime: 'application/octet-stream', passed: false, errors: [] };
const storage = new Map(), messages = [];
let page;
try {
  const context = await browser.newContext({ viewport: { width: 440, height: 806 } });
  await context.exposeFunction('__storage', ({ method, data }) => method === 'getLocalStorage' ? storage.get(data.key) || '' : (storage.set(data.key, data.value), true));
  await context.addInitScript(lookup => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, options) => originalFetch(lookup[typeof input === 'string' ? input : input.url] ? '/models/' + lookup[typeof input === 'string' ? input : input.url] : input, options);
    window.__setupFrames = []; let lastFrame = performance.now(); const frame = now => { if (document.querySelector('#speech-setup')?.open) { window.__setupFrames.push(now - lastFrame); for (const node of document.querySelectorAll('#speech-setup [data-stage=setup]')) window.__setupStages.add(node.textContent); } lastFrame = now; requestAnimationFrame(frame); }; requestAnimationFrame(frame);
    window.__setupStages = new Set();
    window.__calls = []; window.__speechWorkers = 0; window.__setupCheckpoints = [];
    const diagnosticWrites = new Map(), diagnosticKey = 'even-reader:phone:v1:diagnostics';
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options); this.checkpoints = new Set(); this.speech = String(url).includes('ensemble-worker'); if (this.speech) window.__speechWorkers++;
        this.addEventListener('message', event => {
          const data = event.data;
          if (data.progress) this.lastSetup = data.progress;
          if (data.cache?.action === 'checkpoint') this.checkpoints.add(data.cache.request);
          if (this.model === 'moonshine' && location.search.includes('setupFreeze=1')
            && data.progress?.file === 'onnx/encoder_model.onnx' && data.progress.fileLoadedBytes >= 33000000) {
            // A non-responsive worker models closing during unfinished setup.
            // It does not reproduce a physical iPhone/host freeze.
            this.frozen = true; window.__frozenSetup = { ...data.progress };
          }
          if (this.model === 'moonshine' && !window.__moonshineFailure && data.progress?.stage === 'initializing' && data.progress.component === 'decoder') {
            window.__moonshineFailure = true;
            // Deliver through the installed client handler: a terminated
            // native Worker cannot reliably dispatch a synthetic error reply.
            setTimeout(() => { this.terminate(); this.onmessage?.({ data: { id: data.id, error: 'Injected Moonshine initialization failure', errorName: 'RangeError', errorStack: 'injected-decoder-stack' } }); }, 0);
          }
        });
      }
      postMessage(data, ...args) {
        if (this.frozen && data.cacheReply) return;
        if (data.model) this.model = data.model.id;
        if (data.cacheReply && this.checkpoints.delete(data.request) && !data.error) {
          const setup = window.__savedDiagnostics?.speech?.models?.[this.model]?.setup, expected = this.lastSetup;
          window.__setupCheckpoints.push({ stage: expected.stage, component: expected.component, file: expected.file,
            savedBeforeProceeding: !!setup && ['stage', 'file', 'loadedBytes'].every(key => expected[key] === setup[key]) });
        }
        if (this.speech && !data.cacheReply) window.__calls.push({ operation: data.operation, id: data.model?.id, vocabulary: data.vocabulary });
        return super.postMessage(data, ...args);
      }
    };
    window.flutter_inappwebview = { async callHandler(_, payload) {
      const msg = JSON.parse(payload); if (msg.method === 'audioControl') window.__audioStarts = (window.__audioStarts || 0) + 1;
      if (msg.method.endsWith('LocalStorage')) {
        const result = await window.__storage(msg);
        if (msg.method === 'setLocalStorage' && msg.data.key.startsWith(diagnosticKey)) {
          diagnosticWrites.set(msg.data.key, msg.data.value);
          if (msg.data.key === diagnosticKey) {
            const head = JSON.parse(msg.data.value);
            window.__savedDiagnostics = JSON.parse(Array.from({ length: head.count }, (_, i) => diagnosticWrites.get(`${head.prefix}:${i}`)).join(''));
          }
        }
        return result;
      }
      return ['createStartUpPageContainer', 'updateImageRawData'].includes(msg.method) ? 0 : true;
    } };
  }, Object.fromEntries(files.map(f => [f.url, f.sha256])));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url()); if (allowed.has(url.origin) || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }, json = value => route.fulfill({ headers, json: value });
    if (route.request().method() === 'OPTIONS') return route.fulfill({ headers, status: 204 });
    if (url.pathname === '/api/info') return json({ provider: 'codex' });
    if (url.pathname === '/api/events') return route.fulfill({ headers, contentType: 'text/event-stream', body: ': ready\n\n' });
    if (url.pathname.endsWith('/history')) return json({ history: [] });
    if (url.pathname === '/api/messages') return json({ state: 'idle', messages });
    if (url.pathname === '/api/prompt') { messages.push({ id: 1, type: 'user_prompt', text: route.request().postDataJSON().text }, { id: 2, type: 'result', success: true, text: 'The ensemble question arrived.' }); return json({ sessionId: 'ensemble-fixture' }); }
    return route.abort();
  });
  page = await context.newPage(); page.on('pageerror', error => { report.errors.push(error.message); console.log('PAGEERROR', error.message); });
  await page.goto([...allowed][0]);
  await expect(page.locator('#speech-setup')).toBeVisible();
  await expect(page.locator('#speech-setup-retry')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#speech-setup [role=status]')).toContainText('503');
  await expect(page.locator('#import')).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(page.locator('#speech-setup')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { sysEvent: { eventType: 9 } } })));
  assert.equal(await page.evaluate(() => window.__audioStarts || 0), 0);
  await page.screenshot({ path: `${out}/${report.engine}-retry.png` });
  await page.locator('#speech-setup-retry').click();
  const setupMonitor = setInterval(() => page.locator('#speech-setup').innerText().then(text => console.log('SETUP', text.replaceAll('\n', ' · '))).catch(() => {}), 10000);
  try {
    await expect(page.locator('#speech-setup [data-model=moonshine] [data-stage=setup]')).toHaveText(/Loading|Starting|Initializing|Testing|Passed/, { timeout: 120000 });
    await page.screenshot({ path: `${out}/${report.engine}-setup.png` });
    await expect(page.locator('#speech-setup [role=status]')).toContainText('Injected Moonshine initialization failure', { timeout: 300000 });
    await page.locator('#speech-setup-export').click();
    await expect(page.locator('#debug-dialog')).toBeVisible();
    const dump = JSON.parse(await page.locator('#debug-text').inputValue());
    assert.equal(dump.speech.models.moonshine.setup.component, 'decoder');
    assert(dump.errors.some(e => e.error.stack === 'injected-decoder-stack'));
    await page.locator('#debug-close').click();
    await expect(page.locator('#speech-setup')).toBeVisible();
    await page.locator('#speech-setup-retry').click();
    await expect(page.locator('#speech-setup')).not.toBeVisible({ timeout: 300000 });
  } finally { clearInterval(setupMonitor); }
  await expect(page.locator('#import')).toBeEnabled();
  report.setup = await page.evaluate(() => ({ stages: [...__setupStages], animationFrames: __setupFrames.length, longestFrameMs: Math.max(...__setupFrames), checkpoints: __setupCheckpoints }));
  assert(report.setup.checkpoints.some(c => c.stage === 'initializing' && c.component === 'encoder'));
  assert(report.setup.checkpoints.some(c => c.stage === 'initializing' && c.component === 'decoder'));
  assert(report.setup.checkpoints.every(c => c.savedBeforeProceeding), 'Each major phase must be durable before its worker continues');
  assert(report.setup.stages.includes('Testing transcription'));
  assert(report.setup.animationFrames > 10);
  assert(report.setup.longestFrameMs < 3000, 'Setup must not freeze the browser event loop for seconds');
  report.setup.retryAfterNetworkFailure = true;
  report.setup.retryAfterMoonshineInitializationFailure = true;
  report.setup.exportWhileBlocked = true;
  assert(report.setup.stages.includes('Initializing encoder'));
  assert(report.setup.stages.includes('Initializing decoder'));

  await page.locator('#file-picker').setInputFiles({ name: 'speech-test.md', mimeType: 'text/markdown', buffer: Buffer.from('# Local voice\n\nMr. Quilter is the apostle of the middle classes.') });
  await showLibrary(page); await page.locator('[data-document-id="speech-test.md"] .document-card').click();
  await page.locator('#ask-open').click();
  const monitor = setInterval(() => page.locator('#ask-voice-models').textContent().then(console.log).catch(() => {}), 10000);
  try { await expect(page.locator('#ask-voice-models')).toHaveText(/Conformer.*ready.*Zipformer.*ready.*Moonshine.*ready/, { timeout: 240000 }); } finally { clearInterval(monitor); }
  assert.equal(await page.evaluate(() => __speechWorkers), 4);
  const event = type => page.evaluate(eventType => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { sysEvent: { eventType } } })), type);
  const wave = await readFile('node_modules/@pageborne/browser-stt/vendor/stt/phone-benchmark/1272-128104-0000.wav');
  await event(9); await expect(page.locator('#ask-status')).toContainText('Listening');
  await page.evaluate(encoded => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { audioEvent: { audioPcm: Uint8Array.from(atob(encoded), c => c.charCodeAt(0)), source: 'glasses' } } })), wave.subarray(44).toString('base64'));
  await expect(page.locator('#ask-question')).toHaveValue(/quilter|apostle|middle/i, { timeout: 30000 });
  await event(10);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('even-reader:diagnostics:v1')).ask.completionPending), { timeout: 30000 }).toBe(false);
  await expect(page.locator('#ask-question')).toHaveValue(/welcome his gospel/i, { timeout: 30000 });
  report.transcript = await page.locator('#ask-question').inputValue(); assert.match(report.transcript, /welcome his gospel/i); assert.equal(messages.length, 0);
  const calls = await page.evaluate(() => __calls); assert.equal(calls.filter(c => c.operation === 'prepare').length, 4); assert(calls.filter(c => c.operation === 'transcribe').every(c => c.vocabulary?.includes('Quilter')));
  await page.locator('#ask-send').click(); await expect(page.locator('#ask-answer')).toHaveText('The ensemble question arrived.', { timeout: 30000 });
  await backToReading(page);
  await event(9); await expect(page.locator('#ask-status')).toContainText('Listening'); await event(10);
  await expect(page.locator('#ask-panel')).toBeHidden({ timeout: 10000 }); assert.equal(messages.length, 2);
  // The new localhost origin simulates Even's changing port on app upgrades.
  offline = true; const downloaded = counters.downloads; servers.push(await serve());
  // Reopen without re-injecting the initialization fault.
  await context.addInitScript(() => { window.__moonshineFailure = true; });
  await page.goto([...allowed][1] + '/?setupFreeze=1');
  await expect.poll(() => page.evaluate(() => window.__frozenSetup?.fileLoadedBytes || 0), { timeout: 300000 }).toBeGreaterThanOrEqual(33000000);
  const checkpoint = () => new AtomicPhoneValue({ get: async key => storage.get(key) || '' }, 'diagnostics').read();
  await expect.poll(async () => (await checkpoint())?.speech?.models?.moonshine?.setup?.fileLoadedBytes || 0, { timeout: 30000 }).toBeGreaterThanOrEqual(33000000);
  const stopped = await checkpoint(); const stoppedRun = stopped.startedAt;
  const lastBytes = stopped.speech.models.moonshine.setup.fileLoadedBytes;
  await page.close();
  for (let reopen = 0; reopen < 2; reopen++) {
    servers.push(await serve());
    page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
    await page.goto([...allowed].at(-1));
    await expect(page.locator('#speech-setup [role=status]')).toContainText('Previous voice setup did not finish', { timeout: 30000 });
    assert.equal(await page.evaluate(() => __speechWorkers), 0, 'restore/export must happen before any model worker starts');
    await page.locator('#speech-setup-export').click();
    const saved = JSON.parse(await page.locator('#debug-text').inputValue());
    const attempt = saved.unfinishedSetups.find(entry => entry.model === 'moonshine' && entry.runStartedAt === stoppedRun);
    assert(attempt); assert.equal(attempt.setup.fileLoadedBytes, lastBytes); assert(!attempt.resolvedAt);
    assert(attempt.events.some(event => event.file === 'onnx/encoder_model.onnx'));
    await expect(page.locator('#debug-status')).toContainText('earlier runs');
    await page.screenshot({ path: `${out}/${report.engine}-recovered-setup.png` });
    await page.locator('#debug-close').click();
    if (reopen === 0) await page.close();
  }
  await page.locator('#speech-setup-retry').click();
  await expect(page.locator('#speech-setup')).not.toBeVisible({ timeout: 300000 }); await expect(page.locator('#import')).toBeEnabled();
  const completed = await checkpoint();
  assert(Object.values(completed.speech.models).every(model => model.state === 'ready' && model.verified), 'all successful checks must be durably saved before enabling the library');
  report.setup.completionSavedBeforeOpening = true;
  await expect.poll(async () => (await checkpoint())?.unfinishedSetups?.find(entry => entry.runStartedAt === stoppedRun)?.resolvedAt, { timeout: 30000 }).toBeTruthy();
  report.setup.recoveredAfterClosingDuringRead = { runStartedAt: stoppedRun, fileLoadedBytes: lastBytes, freshOrigins: 2, modelsBlockedUntilRetry: true };
  // A successful retry retains evidence but must not pause every later startup.
  servers.push(await serve()); await page.goto([...allowed].at(-1));
  await expect(page.locator('#import')).toBeEnabled({ timeout: 300000 });
  await page.locator('#ask-open').click();
  await expect(page.locator('#ask-voice-models')).toHaveText(/Conformer.*ready.*Zipformer.*ready.*Moonshine.*ready/, { timeout: 240000 });
  assert.equal(counters.downloads, downloaded); report.nativeCacheAcrossOrigins = true; report.downloads = { ...counters };
  report.cachedStartup = (await checkpoint()).speech.storage;
  assert.equal(report.cachedStartup.networkRequests, 0);
  assert.equal(report.cachedStartup.receivedBytes, 0);
  assert.equal(report.cachedStartup.files.length, files.length);
  assert(report.cachedStartup.files.every(file => file.source === 'saved' && file.requests === 0));
  await expect(page.locator('#ask-voice-models')).toContainText('Downloaded this run: 0 MB.');
  await showSettings(page); await page.locator('#settings-voice').evaluate(e => { e.open = true; });
  await page.screenshot({ path: `${out}/${report.engine}.png` });
  assert(!moduleRequests.some(url => url.endsWith('/pageborne-speech.mjs')), 'Sherpa must not import a separate runtime module');
  assert(moduleRequests.length > 0, 'Exercise the ORT runtime with the wrong MIME type too');
  report.moduleRequests = moduleRequests;
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) {
  report.failure = {
    message: error.message,
    setup: page ? await page.locator('#speech-setup').innerText().catch(() => 'Unavailable') : 'Unavailable',
    checkpoint: await new AtomicPhoneValue({ get: async key => storage.get(key) || '' }, 'diagnostics').read().catch(() => null),
  };
  if (page) await page.screenshot({ path: `${out}/${report.engine}-failure.png` }).catch(() => {});
  throw error;
} finally {
  await writeFile(`${out}/${report.engine}.json`, JSON.stringify(report, null, 2)); await browser.close();
  for (const server of servers) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
}
console.log(JSON.stringify(report));
