// Exercise persistent interruption recovery through actual app + SDK storage.
// Worker results are deterministic; this is not an iOS process-kill simulation.
import { chromium, webkit, expect } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { showLibrary, showSettings } from './ui-helpers.mjs';
process.env.PAGEBORNE_AUTOMATIC_TERMINAL = 'false';
const vite = await createServer({ mode: 'release', server: { host: '127.0.0.1', port: 0 } }); await vite.listen();
const reports = [];
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true, executablePath: engine === chromium ? '/usr/bin/google-chrome' : process.env.WEBKIT_PATH });
    const store = new Map(), errors = [];
    const open = async () => {
      const context = await browser.newContext({ viewport: { width: 440, height: 806 } });
      await context.exposeFunction('__phoneStorage', ({ method, data }) => method === 'getLocalStorage' ? store.get(data.key) || '' : (store.set(data.key, data.value), true));
      await context.addInitScript(() => {
        window.__calls = []; window.__workers = [];
        const NativeWorker = Worker;
        window.Worker = class {
          constructor(url, options) { if (!String(url).includes('speech-worker')) return new NativeWorker(url, options); window.__workers.push(this); }
          postMessage(data) {
            window.__calls.push({ model: data.model, operation: data.operation });
            if (data.operation === 'cancel') return;
            if (data.model === 'refine' && data.operation === 'prepare') {
              window.__refine = { worker: this, id: data.id };
              queueMicrotask(() => this.onmessage({ data: { id: data.id, progress: 'Initializing corrections · decoder…' } })); return;
            }
            queueMicrotask(() => this.onmessage({ data: { id: data.id, result: { model: data.model, backend: data.backend, loadMs: 1, text: 'Hello' } } }));
          }
          terminate() { this.stopped = true; }
        };
        window.flutter_inappwebview = { async callHandler(_, payload) {
          const msg = JSON.parse(payload);
          if (msg.method.endsWith('LocalStorage')) return window.__phoneStorage(msg);
          return ['createStartUpPageContainer', 'updateImageRawData'].includes(msg.method) ? 0 : true;
        } };
      });
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      await page.goto(vite.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled();
      return { context, page };
    };
    try {
      let { context, page } = await open();
      await page.locator('#file-picker').setInputFiles({ name: 'recovery.md', mimeType: 'text/markdown', buffer: Buffer.from('# Recovery\n\nA saved paper.') });
      await showLibrary(page); await page.locator('[data-document-id="recovery.md"] .document-card').click();
      await page.locator('#ask-open').click();
      await expect(page.locator('#ask-voice-models')).toContainText('Initializing corrections');
      await expect(page.locator('#ask-voice-models')).toContainText('CPU draft: ready');
      assert((await page.evaluate(() => JSON.parse(localStorage.getItem('even-reader:preferences:v1')))).speechModelPreparation.pending);
      const interrupted = new Map(store);
      await context.close(); // restore precisely the data present before termination/cleanup
      store.clear(); for (const [key, value] of interrupted) store.set(key, value);
      ({ context, page } = await open()); // fresh origin storage; only native prefs carry over
      await showLibrary(page); await page.locator('[data-document-id="recovery.md"] .document-card').click();
      await page.locator('#ask-open').click();
      await expect(page.locator('#ask-voice-models')).toContainText('paused after an interrupted preparation');
      await expect(page.locator('#ask-voice-models')).toContainText('CPU draft: ready');
      assert.deepEqual(await page.evaluate(() => window.__calls), [{ model: 'fast', operation: 'prepare' }]);
      await showSettings(page); await page.locator('#speech-prepare').click();
      await expect(page.locator('#ask-voice-models')).toContainText('Initializing corrections');
      await page.evaluate(() => { const { worker, id } = window.__refine; worker.onmessage({ data: { id, result: { model: 'Whisper Small English', backend: 'webgpu', loadMs: 1 } } }); });
      await expect(page.locator('#ask-voice-models')).toHaveText('CPU draft: ready · GPU corrections: ready');
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('even-reader:preferences:v1')).speechModelPreparation.pending)).toBe(false);
      assert.deepEqual(errors, []);
      reports.push({ engine: engine.name(), passed: true, releaseBuild: true, mockedWorkers: true, nativeStorageRecovery: true, cpuPreserved: true, explicitRetry: true });
      await context.close();
    } finally { await browser.close(); }
  }
} finally { await mkdir('test-results/speech-recovery', { recursive: true }); await writeFile('test-results/speech-recovery/results.json', JSON.stringify(reports, null, 2)); await vite.close(); }
console.log(JSON.stringify(reports));
