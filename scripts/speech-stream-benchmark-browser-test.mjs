// Real Settings/SDK/stream scheduling with deterministic recognition. Hardware
// model checks live in browser-stt/scripts/stream-comparison-browser.mjs.
import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { showSettings, hideSettings, showLibrary, backToReading } from './ui-helpers.mjs';
const useWebkit = process.argv.includes('--webkit');
const out = `test-results/speech-stream-benchmark-${useWebkit ? 'webkit' : 'chromium'}`; await mkdir(out, { recursive: true });
const server = createApp({ distDir: path.resolve('dist') }).listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const browser = await (useWebkit ? webkit : chromium).launch({ headless: true, executablePath: useWebkit ? process.env.WEBKIT_PATH : '/usr/bin/google-chrome' });
const report = { passed: false, actualModels: false, physicalPhone: false, errors: [] };
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
page.on('pageerror', error => report.errors.push(error.message));
const store = new Map();
await page.exposeFunction('__storage', ({ method, data }) => method === 'getLocalStorage' ? store.get(data.key) || '' : (store.set(data.key, data.value), true));
await page.addInitScript(() => {
  const OriginalWorker = Worker, later = window.setTimeout.bind(window);
  window.__holdSmall = true; window.__calls = []; window.__micCalls = []; window.__smallWaiters = [];
  window.Worker = class {
    constructor(url, options) { if (!String(url).includes('speech-worker')) return new OriginalWorker(url, options); this.alive = true; this.cancelled = new Set(); }
    postMessage(data) {
      window.__calls.push({ operation: data.operation, model: data.model, stream: data.stream, vocabulary: data.vocabulary });
      if (data.operation === 'cancel') { this.cancelled.add(data.id); return; }
      const emit = value => { if (this.alive && !this.cancelled.has(data.id)) this.onmessage?.({ data: { id: data.id, ...value } }); };
      const ready = () => emit({ result: { model: data.model, backend: data.backend, loadMs: 20 } });
      if (data.operation === 'prepare') {
        if (data.model === 'refine' && window.__noGpu) return later(() => emit({ error: 'WebGPU unavailable', fatal: false }), 10);
        if (data.model === 'refine' && window.__holdSmall) { window.__smallWaiters.push(ready); later(() => emit({ progress: 'Downloading corrections · test fixture' }), 10); return; }
        later(ready, 10); return;
      }
      if (data.stream) later(() => emit({ partial: { text: 'hello', words: [], partial: true } }), 20);
      later(() => emit({ result: { text: 'hello world', words: [], backend: data.backend, model: data.model, transcribeMs: 40, seconds: 1, loadMs: 0 } }), 40);
    }
    terminate() { this.alive = false; }
  };
  window.flutter_inappwebview = { async callHandler(_, payload) {
    const message = JSON.parse(payload);
    if (message.method.endsWith('LocalStorage')) return window.__storage(message);
    if (message.method === 'audioControl') window.__micCalls.push(message.data.isOpen);
    return ['createStartUpPageContainer', 'updateImageRawData'].includes(message.method) ? 0 : true;
  } };
});
const nativeAudio = () => page.evaluate(() => {
  const pcm = new Uint8Array(32000), view = new DataView(pcm.buffer);
  for (let i = 0; i < 16000; i++) view.setInt16(i * 2, Math.sin(i) * 3000, true);
  window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { audioEvent: { audioPcm: pcm, source: 'glasses' } } }));
});
async function exported() {
  const download = page.waitForEvent('download'); await page.locator('#speech-results-save').click();
  return JSON.parse(await readFile(await (await download).path(), 'utf8'));
}
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`); await expect(page.locator('#import')).toBeEnabled();
  await page.locator('#file-picker').setInputFiles({ name: 'voice.md', mimeType: 'text/markdown', buffer: Buffer.from('# Voice test\n\nA paper to read.') });
  await showLibrary(page); await page.locator('[data-document-id="voice.md"] .document-card').click();
  await showSettings(page); await expect(page.locator('#speech-stream-benchmark')).toBeVisible();
  assert.equal(await page.locator('#speech-benchmark-panel').getAttribute('open'), null);
  await page.locator('#speech-stream-benchmark').click();
  await expect(page.locator('#speech-benchmark-panel')).toHaveAttribute('open', '');
  await expect(page.locator('#speech-benchmark-status')).toContainText('Downloading corrections');
  // Starting ordinary Tiny dictation cancels just the comparison's wait. The
  // shared Small download survives, and no GPU is needed to show the draft.
  await hideSettings(page); await page.locator('#ask-open').click(); await page.locator('#ask-voice').click();
  await expect.poll(() => page.evaluate(() => window.__micCalls.at(-1))).toBe(true);
  await nativeAudio(); await expect(page.locator('#ask-question')).toHaveValue('hello world');
  await page.locator('#ask-voice').click(); await expect(page.locator('#ask-review-cancel')).toBeVisible();
  await page.locator('#ask-review-cancel').click(); await backToReading(page);
  assert.equal(await page.evaluate(() => window.__calls.filter(call => call.operation === 'transcribe' && call.model === 'refine').length), 0);
  report.tinyWhileSmallDownloads = true;
  await page.evaluate(() => { window.__holdSmall = false; window.__smallWaiters.splice(0).forEach(ready => ready()); });
  await showSettings(page);
  const preferences = await page.locator('#speech-backend').inputValue();
  const callStart = await page.evaluate(() => window.__calls.length);
  await page.locator('#speech-stream-benchmark').click();
  await expect(page.locator('#speech-stream-live')).toContainText('hello', { timeout: 15000 });
  await expect(page.locator('#speech-benchmark-status')).toContainText('Streaming comparison finished', { timeout: 150000 });
  report.bundled = await exported(); assert.equal(report.bundled.runs.length, 3); assert(report.bundled.completed);
  for (const row of report.bundled.runs) for (const model of ['fast', 'refine']) {
    const run = row[model]; assert(!run.error); assert(run.firstWordMs > 0 && run.firstWordMs < run.audioMs);
    assert(run.backlog.length > 20); assert(run.backlogP95Ms < 2000); assert(run.updates.length > 1);
  }
  assert(report.bundled.runs.some(row => row.fast.audioMs > 15000), 'one trial crosses the bounded window');
  const calls = await page.evaluate(start => window.__calls.slice(start), callStart);
  assert(calls.filter(row => row.operation === 'transcribe').every(row => row.vocabulary.length === 0));
  assert(calls.some(row => row.stream && row.model === 'refine'));
  assert.equal(await page.locator('#speech-backend').inputValue(), preferences);
  await page.locator('#speech-benchmark-output').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${out}/results.png` });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  // A recorded sample uses the same stream test and remains downloadable.
  await page.locator('#speech-record').click(); await expect.poll(() => page.evaluate(() => window.__micCalls.at(-1))).toBe(true);
  await nativeAudio(); await page.locator('#speech-record').click(); await expect(page.locator('#speech-record-stream')).toBeEnabled();
  await page.locator('#speech-record-reference').fill('hello world'); await page.locator('#speech-record-stream').click();
  await expect(page.locator('#speech-benchmark-status')).toContainText('Streaming comparison finished');
  report.recording = await exported(); assert.equal(report.recording.runs[0].refine.score.wer, 0);
  // Disable/dispose just Small, then fail its next preparation. Tiny still runs.
  await page.locator('#speech-refinement').uncheck(); await page.evaluate(() => { window.__noGpu = true; });
  await page.locator('#speech-record-stream').click(); await expect(page.locator('#speech-benchmark-status')).toContainText('Streaming comparison finished');
  report.noGpu = await exported(); assert.match(report.noGpu.prepared.refine.error, /unavailable/); assert(report.noGpu.runs[0].fast);
  await page.locator('#speech-stream-benchmark').click(); await page.locator('#speech-benchmark-cancel').click();
  await expect(page.locator('#speech-stream-benchmark')).toBeEnabled(); await expect(page.locator('#speech-benchmark-status')).toContainText('Cancelled');
  await page.waitForTimeout(300); assert.equal((await exported()).completed, false);
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.error = error.stack; await page.screenshot({ path: `${out}/failure.png` }); throw error; }
finally { await writeFile(`${out}/results.json`, JSON.stringify(report, null, 2)); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
console.log(`PASS: ${useWebkit ? 'WebKit' : 'Chrome'} one-button streaming, live word latency/backlog, Tiny during Small download, recording/export, cancellation and GPU fallback.`);
