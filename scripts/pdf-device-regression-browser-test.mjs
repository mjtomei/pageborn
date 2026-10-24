// Full reader UI + the reported paper. Optional real speech workers reproduce
// the resident-model overlap; desktop results do not certify physical iOS.
import { chromium, webkit, expect } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { showLibrary, showTool, waitForPdfReady } from './ui-helpers.mjs';
const name = process.env.PDF_BROWSER || 'chromium', real = process.env.PDF_SPEECH === 'real';
const output = process.env.PDF_RESULTS || `test-results/pdf-device-${name}`;
await mkdir(output, { recursive: true });
const file = process.argv[2]; if (!file) throw Error('Supply the regression PDF path.');
const manifests = JSON.parse(await readFile('node_modules/@pageborne/browser-stt/vendor/stt/ensemble-models.json'));
const files = manifests.flatMap(model => model.files.filter(f => f.url).map(f => ({ ...f,
  path: path.join(path.resolve(process.env.PAGEBORNE_TEST_MODEL_DIR || '.state/models'), model.directory, f.file) })));
const server = createApp({ distDir: path.resolve('dist') }).listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await (name === 'webkit' ? webkit : chromium).launch({ executablePath: name === 'webkit' ? process.env.WEBKIT_PATH : '/usr/bin/google-chrome' });
const storage = new Map(), report = { engine: name, realSpeech: real, physicalPhone: false, phases: [], errors: [], passed: false };
let page, monitor, setupMonitor;
try {
 const context = await browser.newContext({ viewport: { width: 440, height: 806 } });
 await context.exposeFunction('__storage', ({ method, data }) => {
  if (!real && method === 'getLocalStorage' && /^pageborne:models:v1:[a-f0-9]{64}$/.test(data.key)) return JSON.stringify({ id: 'fixture', chunks: 1, headers: {} });
  if (method === 'getLocalStorage') return storage.get(data.key) || '';
  storage.set(data.key, data.value); return true;
 });
 await context.addInitScript(real => {
  const NativeWorker = Worker; window.__workers = []; window.__checks = [];
  window.Worker = class {
   constructor(url, options) {
    const speech = String(url).includes('ensemble-worker');
    if (!real && speech) { this.mock = true; return; }
    const worker = new NativeWorker(url, options), item = { speech, active: true }; window.__workers.push(item);
    worker.addEventListener('message', ({ data }) => { if (data.progress?.stage === 'checking') window.__checks.push(data.id); });
    const terminate = worker.terminate.bind(worker); worker.terminate = () => { item.active = false; terminate(); }; return worker;
   }
   postMessage(data) { if (data.operation === 'prepare') queueMicrotask(() => this.onmessage({ data: { id: data.id, result: { verified: true } } })); }
   terminate() {}
  };
  window.flutter_inappwebview = { async callHandler(_, payload) { const m = JSON.parse(payload); if (m.method.endsWith('LocalStorage')) return __storage(m); return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true; } };
 }, real);
 await context.route('**/*', route => {
  const url = route.request().url(); if (url.startsWith(origin) || /^(blob|data):/.test(url)) return route.continue();
  const model = files.find(f => f.url === url); if (real && model) return route.fulfill({ path: model.path, headers: { 'Access-Control-Allow-Origin': '*' } });
  return route.abort();
 });
 page = await context.newPage(); page.on('pageerror', e => report.errors.push(e.message)); page.on('crash', () => report.errors.push('Page process crashed'));
 const session = name === 'chromium' ? await browser.newBrowserCDPSession() : null;
 const heap = name === 'chromium' ? await context.newCDPSession(page) : null;
 const sample = async label => {
  const data = await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('even-reader:diagnostics:v1') || '{}'); return { pdf: d.pdf, models: d.speech?.models, activeSpeech: __workers.filter(w => w.speech && w.active).length, checks: __checks.length }; });
  if (session) { const { processInfo } = await session.send('SystemInfo.getProcessInfo'); data.processes = await Promise.all(processInfo.filter(p => p.type === 'renderer').map(async p => { const status = await readFile(`/proc/${p.id}/status`, 'utf8').catch(() => ''); return { pid: p.id, rssKB: Number(status.match(/VmRSS:\s+(\d+)/)?.[1]) }; })); }
  if (heap) data.heap = await heap.send('Runtime.getHeapUsage');
  report.phases.push({ label, ...data }); console.log(JSON.stringify({ label, stage: data.pdf?.stage, page: data.pdf?.page, speech: data.activeSpeech, heap: data.heap, processes: data.processes }));
 };
 await page.goto(origin); console.log('Loaded app'); setupMonitor = setInterval(() => page.locator('#speech-setup').innerText().then(s => console.log('Setup:', s.replaceAll('\n',' · '))).catch(() => {}), 5000); await expect.poll(async () => { if (await page.locator('#speech-setup-retry').isVisible()) throw Error(await page.locator('#speech-setup [role=status]').innerText()); return page.locator('#import').isEnabled(); }, { timeout: 180000 }).toBe(true); clearInterval(setupMonitor); await sample('after-startup');
 await page.locator('#file-picker').setInputFiles({ name: 'reflow-crash.pdf', mimeType: 'application/pdf', buffer: await readFile(file) });
 await showLibrary(page); await page.locator('[data-document-id="reflow-crash.pdf"] .document-card').click();
 monitor = setInterval(() => sample('reflow').catch(() => {}), 500);
 await waitForPdfReady(page); clearInterval(monitor); await sample('ready');
 await expect(page.locator('#pdf-passage canvas').first()).toBeVisible();
 if (heap && process.env.PDF_HEAP) { await heap.send('HeapProfiler.collectGarbage'); await sample('ready-after-gc'); const chunks = []; heap.on('HeapProfiler.addHeapSnapshotChunk', e => chunks.push(e.chunk)); await heap.send('HeapProfiler.takeHeapSnapshot'); await writeFile(`${output}/heap.json`, chunks.join('')); }
 // A second fresh layout exercises toggling reflow/settings and cancellation.
 await showTool(page, 'pdf'); await page.locator('#pdf-text-size').selectOption('24');
 await waitForPdfReady(page); await sample('reflow-24');
 await page.locator('#tool-close').click();
 await expect(page.locator('#pdf-passage canvas').first()).toBeVisible();
 await page.screenshot({ path: `${output}/ready.png` });
 await page.locator('#position').evaluate(el => { el.value = el.max; el.dispatchEvent(new Event('input')); });
 await expect.poll(() => page.locator('#pdf-passage canvas').count()).toBeGreaterThan(0);
 await expect(page.locator('#pdf-passage')).not.toContainText('Could not render');
 await page.screenshot({ path: `${output}/last-page.png` });
 assert.equal(report.phases.findLast(p => p.pdf)?.pdf.pages, 50);
 assert.deepEqual(report.errors, []); report.passed = true;
} finally { clearInterval(setupMonitor); report.final = await page?.evaluate(() => ({ setup: document.querySelector('#speech-setup')?.innerText, diagnostics: JSON.parse(localStorage.getItem('even-reader:diagnostics:v1') || '{}') })).catch(() => null); clearInterval(monitor); await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2)); await browser.close(); await new Promise(r => server.close(r)); }
console.log(JSON.stringify({ engine: name, passed: report.passed, realSpeech: real, physicalPhone: false, samples: report.phases.length, errors: report.errors }));
