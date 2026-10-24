// Deterministic worker lifecycle test; does not emulate iOS memory termination.
import { chromium, webkit, expect } from '@playwright/test';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { showLibrary, showSettings, hideSettings } from './ui-helpers.mjs';

process.env.PAGEBORNE_ASK_ORIGINS = 'https://cold-refinement.test';
const vite = await createServer({ cacheDir: '.state/vite-cold-refinement', server: { host: '127.0.0.1', port: 0 }, clearScreen: false }); await vite.listen();
const out = 'test-results/ask-cold-refinement'; await mkdir(out, { recursive: true });
const reports = [];
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ executablePath: engine === chromium ? '/usr/bin/google-chrome' : process.env.WEBKIT_PATH, headless: true });
    try { for (const outcome of ['ready', 'download-error', 'worker-error', 'disabled']) {
      const context = await browser.newContext({ viewport: { width: 440, height: 806 } }), page = await context.newPage();
      const report = { engine: engine.name(), outcome, passed: false, errors: [], physicalPhone: false, mockedModels: true }; reports.push(report);
      page.on('pageerror', e => report.errors.push(e.message));
      const storage = new Map(), messages = [];
      await page.exposeFunction('__store', ({ method, data }) => method === 'getLocalStorage' ? storage.get(data.key) || '' : (storage.set(data.key, data.value), true));
      await page.addInitScript(() => {
        localStorage.setItem('even-reader:preferences:v1', JSON.stringify({ ask: { mode: 'terminal', endpoint: 'https://cold-refinement.test', token: 'fixture', agent: 'codex' }, speechRefinement: true }));
        window.__modelCalls = []; window.__body = ''; window.__status = ''; window.__exits = 0; window.__workers = [];
        const NativeWorker = Worker;
        window.Worker = class {
          constructor(url, options) { if (!String(url).includes('speech-worker')) return new NativeWorker(url, options); window.__workers.push(this); }
          postMessage(data) {
            window.__modelCalls.push({ operation: data.operation, model: data.model });
            if (data.operation === 'cancel') return;
            if (data.operation === 'prepare' && data.model === 'refine') {
              window.__refine = { worker: this, id: data.id };
              queueMicrotask(() => this.onmessage({ data: { id: data.id, progress: 'Downloading corrections · 10 / 586 MB' } })); return;
            }
            queueMicrotask(() => this.onmessage({ data: { id: data.id, result: { backend: data.backend, model: data.model, text: data.operation === 'transcribe' ? 'This is a test message' : '', words: [], seconds: 2, transcribeMs: 10, loadMs: 5 } } }));
          }
          terminate() { this.stopped = true; }
        };
        window.flutter_inappwebview = { async callHandler(_, payload) {
          const msg = JSON.parse(payload); if (msg.method.endsWith('LocalStorage')) return window.__store(msg);
          if (msg.method === 'shutDownPageContainer') window.__exits++;
          for (const box of msg.method === 'textContainerUpgrade' ? [msg.data] : msg.data?.textObject || []) {
            if (box.containerName === 'body') window.__body = box.content;
            if (box.containerName === 'status') window.__status = box.content;
          }
          return ['createStartUpPageContainer', 'updateImageRawData'].includes(msg.method) ? 0 : true;
        } };
      });
      await page.route('https://cold-refinement.test/**', async route => {
        const url = new URL(route.request().url()), headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        const json = value => route.fulfill({ headers, json: value });
        if (url.pathname === '/api/info') return json({ provider: 'codex' });
        if (url.pathname === '/api/events') return route.fulfill({ headers, contentType: 'text/event-stream', body: ': connected\n\n' });
        if (url.pathname.endsWith('/history')) return json({ history: [] });
        if (url.pathname === '/api/messages') return json({ state: 'idle', messages });
        if (url.pathname === '/api/prompt') {
          messages.push({ id: 1, type: 'user_prompt', text: route.request().postDataJSON().text }, { id: 2, type: 'result', success: true, text: 'Your test message came through.' });
          return json({ sessionId: 'cold-fixture' });
        }
        throw new Error(url.pathname);
      });
      const event = eventType => page.evaluate(eventType => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { sysEvent: { eventType } } })), eventType);
      await page.goto(vite.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled();
      await page.locator('#file-picker').setInputFiles({ name: 'reading.md', mimeType: 'text/markdown', buffer: Buffer.from('# Reading\n\nThis paper stays open while asking.') });
      await showLibrary(page); await page.locator('[data-document-id="reading.md"] .document-card').click();
      await event(9); await expect(page.locator('#ask-status')).toContainText('Listening');
      await expect(page.locator('#ask-voice-models')).toContainText('Downloading corrections');
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { audioEvent: { audioPcm: new Uint8Array(64000), source: 'glasses' } } })));
      await expect(page.locator('#ask-question')).toHaveValue('This is a test message'); await event(10);
      await expect(page.locator('#ask-review-cancel')).toBeVisible(); await event(0);
      await expect(page.locator('#ask-answer')).toHaveText('Your test message came through.');
      await expect.poll(() => page.evaluate(() => window.__body)).toContain('Your test message came through.');
      if (outcome === 'disabled') {
        await showSettings(page); await page.locator('#speech-refinement').uncheck(); await hideSettings(page);
        assert(await page.evaluate(() => window.__refine.worker.stopped), 'disabling corrections stops the pending download worker');
        assert.equal(await page.evaluate(() => window.__workers.filter(worker => worker.stopped).length), 1, 'CPU model stays resident');
      }
      await page.evaluate(outcome => {
        const { worker, id } = window.__refine;
        if (outcome === 'ready' || outcome === 'disabled') worker.onmessage({ data: { id, result: { backend: 'webgpu', model: 'Whisper Small English', download: { cacheAvailable: true } } } });
        else if (outcome === 'download-error') worker.onmessage({ data: { id, error: 'GPU model download or integrity check failed. CPU voice still works.', fatal: false } });
        else worker.onerror({ preventDefault() {} });
      }, outcome);
      await expect(page.locator('#ask-voice-models')).toContainText(outcome === 'disabled' ? 'Corrections disabled' : outcome === 'ready' ? 'GPU corrections: ready' : outcome === 'download-error' ? 'integrity check failed' : 'stopped unexpectedly');
      if (outcome === 'disabled') await page.locator('#ask-open').click();
      await page.waitForTimeout(650); // includes deferred phone storage checkpoint
      await expect(page.locator('#ask-answer')).toHaveText('Your test message came through.');
      const state = await page.evaluate(() => ({ calls: window.__modelCalls, exits: window.__exits, status: window.__status, diagnostics: JSON.parse(localStorage.getItem('even-reader:diagnostics:v1')) }));
      assert.equal(state.exits, 0); assert(!state.calls.some(call => call.model === 'refine' && call.operation === 'transcribe'));
      assert.doesNotMatch(state.status, /Latest/); assert.match(state.status, / +Hold: speak · Tap: back$/);
      assert.equal(state.diagnostics.ask.state, 'answer'); assert.equal(state.diagnostics.speech.refine.state, outcome === 'disabled' ? 'idle' : outcome === 'ready' ? 'ready' : 'error');
      assert.deepEqual(report.errors, []); Object.assign(report, { passed: true, latePreparationNeverRefinesSentQuestion: true, replyPreserved: true, diagnostics: state.diagnostics.speech });
      await page.screenshot({ path: `${out}/${engine.name()}-${outcome}.png` }); await context.close();
    } } finally { await browser.close(); }
  }
} finally { await writeFile(`${out}/results.json`, JSON.stringify(reports, null, 2)); await vite.close(); }
console.log(JSON.stringify(reports));
