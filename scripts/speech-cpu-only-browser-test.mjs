// Actual CPU model, app streaming/review and saved-setting upgrade coverage.
// Glasses transport and agent replies are fixtures; no real agent receives text.
import { chromium, webkit, expect } from '@playwright/test';
import { createApp } from '../server/app.js';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { showLibrary, showSettings, hideSettings, backToReading } from './ui-helpers.mjs';

const out = 'test-results/speech-cpu-only'; await mkdir(out, { recursive: true });
const server = createApp({ distDir: path.resolve('dist') }).listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const reports = [];
const wave = await readFile('node_modules/@pageborne/browser-stt/vendor/stt/phone-benchmark/1272-128104-0000.wav');
const pcm = wave.subarray(44);
const longClips = await Promise.all(['1272-128104-0000', '1272-128104-0001', '1272-128104-0002', '2961-960-0003'].map(async file =>
  (await readFile(`node_modules/@pageborne/browser-stt/vendor/stt/phone-benchmark/${file}.wav`)).subarray(44)));
const longPcm = Buffer.concat(longClips.flatMap(clip => [clip, Buffer.alloc(19200)]));
try {
  const assets = await readdir('dist/stt');
  assert(!assets.some(name => /whisper|asyncify/.test(name)));
  const worker = await readFile('dist/stt/speech-worker.js', 'utf8');
  assert.doesNotMatch(worker, /whisper-small|Downloading corrections|pageborne-speech-weights/);
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true, executablePath: engine === chromium ? '/usr/bin/google-chrome' : process.env.WEBKIT_PATH });
    const report = { engine: engine.name(), passed: false, realTiny: true, physicalPhone: false, errors: [], unexpectedNetwork: [] }; reports.push(report);
    const storage = new Map(), messages = [];
    const context = await browser.newContext({ viewport: { width: 440, height: 806 } });
    let page;
    try {
      await context.exposeFunction('__phoneStorage', ({ method, data }) => method === 'getLocalStorage' ? storage.get(data.key) || '' : (storage.set(data.key, data.value), true));
      await context.addInitScript(() => {
        if (!localStorage.getItem('even-reader:preferences:v1')) localStorage.setItem('even-reader:preferences:v1', JSON.stringify({ speechRefinement: true, speechBackend: 'webgpu', speechModelPreparation: { pending: true, id: 'interrupted-old-small' } }));
        window.__speechCalls = []; window.__speechResults = []; window.__speechWorkers = [];
        const NativeWorker = Worker;
        window.Worker = class extends NativeWorker {
          constructor(url, options) {
            super(url, options); this.speech = String(url).includes('speech-worker');
            if (this.speech) { window.__speechWorkers.push(this); this.addEventListener('message', ({ data }) => { if (data.result || data.partial) window.__speechResults.push(data.result || data.partial); }); }
          }
          postMessage(data, ...args) { if (this.speech) window.__speechCalls.push({ model: data.model, backend: data.backend, operation: data.operation }); return super.postMessage(data, ...args); }
        };
        window.flutter_inappwebview = { async callHandler(_, payload) {
          const msg = JSON.parse(payload); if (msg.method.endsWith('LocalStorage')) return window.__phoneStorage(msg);
          return ['createStartUpPageContainer', 'updateImageRawData'].includes(msg.method) ? 0 : true;
        } };
      });
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === origin && url.pathname === '/stt/speech-worker.js') {
          const response = await route.fetch();
          return route.fulfill({ response, body: `Object.defineProperty(navigator, 'gpu', {value:{requestAdapter(){throw new Error('CPU-only build requested GPU');}}});\nconst openDB = indexedDB.open.bind(indexedDB); indexedDB.open = function(name,...args){if(name==='pageborne-speech-weights-v1') throw new Error('CPU-only build opened Small cache'); return openDB(name,...args);};\n` + await response.text() });
        }
        if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
        if (!url.pathname.startsWith('/api/')) { report.unexpectedNetwork.push(url.origin); return route.abort(); }
        const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
        const json = value => route.fulfill({ headers, json: value });
        if (route.request().method() === 'OPTIONS') return route.fulfill({ headers, status: 204 });
        if (url.pathname === '/api/info') return json({ provider: 'codex' });
        if (url.pathname === '/api/events') return route.fulfill({ headers, contentType: 'text/event-stream', body: ': ready\n\n' });
        if (url.pathname.endsWith('/history')) return json({ history: [] });
        if (url.pathname === '/api/messages') return json({ state: 'idle', messages });
        if (url.pathname === '/api/prompt') {
          messages.push({ id: 1, type: 'user_prompt', text: route.request().postDataJSON().text }, { id: 2, type: 'result', success: true, text: 'The CPU voice question arrived.' });
          return json({ sessionId: 'cpu-only-fixture' });
        }
        report.unexpectedNetwork.push(url.pathname); return route.abort();
      });
      page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
      await page.goto(origin); await expect(page.locator('#import')).toBeEnabled();
      await page.locator('#file-picker').setInputFiles(['first','second'].map(name => ({ name: `${name}.md`, mimeType: 'text/markdown', buffer: Buffer.from(`# ${name}\n\nA paper for testing local voice.`) })));
      await showLibrary(page); await page.locator('[data-document-id="first.md"] .document-card').click();
      assert.equal(await page.evaluate(() => window.__speechWorkers.length), 0);
      await page.locator('#ask-open').click();
      await expect(page.locator('#ask-voice-models')).toHaveText('CPU draft: ready', { timeout: 60000 });
      await showSettings(page);
      assert.equal(await page.locator('#speech-refinement, #speech-stream-benchmark, #speech-benchmark-panel').count(), 0);
      assert.equal(await page.locator('#shared-settings .help-button').count(), 0);
      await expect(page.locator('#speech-vocabulary-help')).toBeVisible();
      await expect(page.locator('#speech-status')).toHaveText('CPU draft: ready');
      await expect(page.locator('#speech-prepare, #speech-compare, #speech-test-file')).toHaveCount(0);
      await expect(page.locator('#speech-retry')).toBeHidden();
      await hideSettings(page); await showLibrary(page); await page.locator('[data-document-id="second.md"] .document-card').click();
      const event = type => page.evaluate(eventType => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { sysEvent: { eventType } } })), type);
      await event(9); await expect(page.locator('#ask-status')).toContainText('Listening');
      await page.evaluate(encoded => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { audioEvent: { audioPcm: Uint8Array.from(atob(encoded), c => c.charCodeAt(0)), source: 'glasses' } } })), pcm.toString('base64'));
      await expect(page.locator('#ask-question')).not.toHaveValue('', { timeout: 30000 });
      await expect(page.locator('#ask-status')).toContainText('Listening');
      await event(10);
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('even-reader:diagnostics:v1')).ask.completionPending), { timeout: 30000 }).toBe(false);
      await expect(page.locator('#ask-question')).toHaveValue(/mister|quilter|apostle|middle|classes/i);
      assert.equal(messages.length, 0);
      await page.locator('#ask-send').click(); await expect(page.locator('#ask-answer')).toHaveText('The CPU voice question arrived.', { timeout: 30000 });
      await backToReading(page); await page.locator('#ask-open').click();
      const state = await page.evaluate(() => ({ calls: window.__speechCalls, workers: window.__speechWorkers.length, results: window.__speechResults }));
      assert(state.calls.filter(row => row.operation !== 'cancel').every(row => row.model === 'fast' && row.backend === 'wasm'));
      assert.equal(state.workers, 1); assert.equal(state.calls.filter(row => row.operation === 'prepare').length, 1);
      assert(state.results.some(row => row.partial && row.words.length));
      assert(state.results.some(row => row.words?.some(word => Number.isFinite(word.scores?.minimum))));
      report.transcript = state.results.find(row => row.text && !row.partial)?.text;
      report.cpuReusedAcrossDocuments = report.partialBeforeRelease = report.confidenceWords = report.agentReply = report.oldPreferencesIgnored = true;
      await backToReading(page);
      // One held message, multiple real Tiny windows. Recognition must keep
      // the opening sentence through live drafts and the final phone review.
      await event(9); await expect(page.locator('#ask-status')).toContainText('Listening');
      await page.evaluate(encoded => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { audioEvent: { audioPcm: Uint8Array.from(atob(encoded), c => c.charCodeAt(0)), source: 'glasses' } } })), longPcm.toString('base64'));
      await expect(page.locator('#ask-question')).toHaveValue(/not understood by them at all/i, { timeout: 60000 });
      await expect(page.locator('#ask-status')).toContainText('Listening');
      const firstPass = await page.locator('#ask-question').inputValue();
      await page.evaluate(encoded => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { audioEvent: { audioPcm: Uint8Array.from(atob(encoded), c => c.charCodeAt(0)), source: 'glasses' } } })), longPcm.toString('base64'));
      await expect.poll(async () => ((await page.locator('#ask-question').inputValue()).match(/not understood by them at all/gi) || []).length, { timeout: 60000 }).toBe(2);
      await expect(page.locator('#ask-status')).toContainText('Listening');
      const liveLong = await page.locator('#ask-question').inputValue();
      assert(liveLong.startsWith(firstPass));
      await event(10);
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('even-reader:diagnostics:v1')).ask.completionPending), { timeout: 30000 }).toBe(false);
      const reviewedLong = await page.locator('#ask-question').inputValue();
      for (const text of [liveLong, reviewedLong]) {
        assert.match(text, /^Mr\.? Quilter is the apostle/i);
        assert.match(text, /less interesting than his matter/i);
        assert.match(text, /most readily to the mind/i);
        assert.match(text, /not understood by them at all/i);
      }
      report.longRecording = { seconds: 2 * longPcm.length / 32000, live: liveLong, review: reviewedLong };
      // Cancel the unsent review, then leave the independent phone chat pane.
      await event(3); await expect(page.locator('#ask-review-cancel')).toBeHidden();
      await expect(page.locator('#ask-question')).toHaveValue(''); await backToReading(page);
      for (const silence of [false, true]) {
        await event(9); await expect(page.locator('#ask-status')).toContainText('Listening');
        if (silence) await page.evaluate(() => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { audioEvent: { audioPcm: new Uint8Array(16000), source: 'glasses' } } })));
        await event(10); await expect(page.locator('#ask-panel')).toBeHidden({ timeout: 30000 });
        await expect(page.locator('#ask-status')).not.toHaveText(/No speech|silent/);
        assert.equal(messages.length, 2);
      }
      report.silentAndEmptyHoldIsNoop = true;
      await page.reload(); await expect(page.locator('#import')).toBeEnabled();
      await page.locator('#ask-open').click(); await expect(page.locator('#ask-voice-models')).toHaveText('CPU draft: ready', { timeout: 60000 });
      assert.equal(await page.evaluate(() => window.__speechWorkers.length), 1);
      const refused = await page.evaluate(async () => {
        const worker = new Worker(new URL('stt/speech-worker.js', document.baseURI), { type: 'module' });
        try {
          const run = data => new Promise((resolve, reject) => { worker.onmessage = event => resolve(event.data); worker.onerror = reject; worker.postMessage({ ...data, operation: 'prepare', base: new URL('stt/', document.baseURI).href }); });
          return [await run({ id: 9001, model: 'refine', backend: 'webgpu' }), await run({ id: 9002, model: 'fast', backend: 'webgpu' })];
        } finally { worker.terminate(); }
      });
      assert(refused.every(result => /Tiny CPU only/.test(result.error))); report.workerRejectsGpu = true;
      await page.screenshot({ path: `${out}/${engine.name()}.png` });
      assert.deepEqual(report.errors, []); assert.deepEqual(report.unexpectedNetwork, []); report.passed = true;
    } catch (error) { report.failure = error.stack; await page?.screenshot({ path: `${out}/${engine.name()}-failure.png` }); throw error; }
    finally { await context.close(); await browser.close(); }
  }
} finally { await writeFile(`${out}/results.json`, JSON.stringify(reports, null, 2)); server.closeAllConnections(); await new Promise(r => server.close(r)); }
console.log(JSON.stringify(reports));
