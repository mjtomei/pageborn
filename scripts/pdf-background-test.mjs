import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { access, readdir, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { AtomicPhoneValue } from '../src/phone-storage.js';
import { pdfFixture, scannedPdfFixture } from '../test/fixtures/pdfs.mjs';

const dir = path.resolve(process.env.BACKGROUND_RESULTS || 'test-results/pdf-background');
await mkdir(dir, { recursive: true });
const server = createApp({ distDir: path.resolve('dist') }).listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const cache = path.join(os.homedir(), '.cache/ms-playwright');
const cached = (await readdir(cache)).filter(name => /^chromium-\d+$/.test(name));
const candidates = [process.env.CHROME_PATH, chromium.executablePath(), ...cached.flatMap(name => [path.join(cache, name, 'chrome-linux/chrome'), path.join(cache, name, 'chrome-linux64/chrome')])].filter(Boolean);
const executablePath = (await Promise.all(candidates.map(async file => { try { await access(file); return file; } catch { return null; } }))).find(Boolean);
const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
const phoneData = new Map(); const result = { passed: false, errors: [] }; let page; let context;
const saved = new AtomicPhoneValue({ get: async key => phoneData.get(key) || '' }, 'preferences');
const until = (condition, arg, timeout = 60000) => page.waitForFunction(condition, arg, { polling: 50, timeout });
const event = detail => page.evaluate(detail => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail })), detail);
const imageCount = () => page.evaluate(() => window.__images);
const displayedY = () => page.evaluate(() => JSON.parse(localStorage.getItem('even-reader:diagnostics:v1')).events.findLast(e => e.type === 'pdf-frame')?.y);
const ready = () => until(() => { const d = JSON.parse(localStorage.getItem('even-reader:diagnostics:v1'));
  return !document.querySelector('#bookmark').disabled && d.pdf?.stage === 'ready' && d.events.findLast(e => e.type === 'pdf-frame')?.selection === d.pdf?.selection; });
async function choose(title) {
  await until(() => window.__body.includes('Choose document'));
  for (let n = 0; n < 10; n++) {
    const body = await page.evaluate(() => window.__body);
    if (body.split('\n').includes(`> ${title}`)) { await event({ textEvent: { eventType: 0 } }); return; }
    await event({ textEvent: { eventType: 2 } }); await until(previous => window.__body !== previous, body);
  }
  throw new Error(`Could not choose ${title} from the glasses library`);
}
async function openWebView() {
  context = await browser.newContext({ viewport: { width: 440, height: 806 } });
  await context.exposeFunction('__phoneStorage', m => {
    if (m.method === 'getLocalStorage') return phoneData.get(m.data.key) || '';
    phoneData.set(m.data.key, m.data.value); return true;
  });
  await context.addInitScript(() => {
    // Emulate the relevant hidden-WebView behavior: no animation callbacks,
    // but JavaScript, workers and SDK events continue to run for the glasses.
    let next = 0; window.__rafRequests = 0;
    window.requestAnimationFrame = () => { window.__rafRequests++; return ++next; };
    window.cancelAnimationFrame = () => {};
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { get: () => true });
    delete ReadableStream.prototype[Symbol.asyncIterator]; delete ReadableStream.prototype.values;
    const post = Worker.prototype.postMessage; const pending = [];
    window.__ocrText = null; const observed = new WeakSet();
    window.__holdWorkers = false;
    Worker.prototype.postMessage = function (...args) {
      if (!observed.has(this)) {
        observed.add(this); this.addEventListener('message', ({ data }) => { if (data.action === 'recognize' && data.status === 'resolve') window.__ocrText = data.data.text; });
      }
      if (window.__holdWorkers) pending.push([this, args]); else post.apply(this, args);
    };
    window.__releaseWorkers = () => { window.__holdWorkers = false; for (const [worker, args] of pending.splice(0)) post.apply(worker, args); };
    window.__body = ''; window.__images = 0; window.__bodies = [];
    window.flutter_inappwebview = { callHandler: async (_, payload) => {
      const m = JSON.parse(payload);
      if (m.method.endsWith('LocalStorage')) return window.__phoneStorage(m);
      if (m.method === 'createStartUpPageContainer' || m.method === 'rebuildPageContainer') {
        window.__body = m.data.textObject.find(t => t.containerName === 'body')?.content || '';
        window.__bodies.push(window.__body); return m.method === 'createStartUpPageContainer' ? 0 : true;
      }
      if (m.method === 'textContainerUpgrade' && m.data.containerName === 'body') { window.__body = m.data.content; window.__bodies.push(window.__body); }
      if (m.method === 'updateImageRawData') { window.__images++; return 0; }
      return true;
    } };
  });
  page = await context.newPage(); page.on('pageerror', e => result.errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await until(() => !document.querySelector('#import').disabled);
}
try {
  await openWebView();
  const buffer = process.env.PDF_SAMPLE ? await readFile(process.env.PDF_SAMPLE) : pdfFixture();
  await page.locator('#file-picker').setInputFiles([
    { name: 'reading.pdf', mimeType: 'application/pdf', buffer },
    { name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nnot a valid document') },
  ]);
  await until(() => document.querySelector('#doc-count').textContent === '2' && document.querySelector('#imports').dataset.pending === '0');
  await page.evaluate(() => { window.__holdWorkers = true; });
  await choose('reading');
  await until(() => window.__body.includes('PDF') && !window.__body.includes('Choose a document'));
  await expect.poll(async () => (await saved.read())?.selected?.id).toBe('reading.pdf');
  assert.equal(await imageCount(), 0, 'selection is persisted before PDF preparation finishes');
  await page.evaluate(() => window.__releaseWorkers());
  await ready();
  result.openedFromGlasses = true;
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('even-reader:diagnostics:v1')).counts['pdf-cache-saved']), 1);
  const before = await displayedY(); await event({ textEvent: { eventType: 2 } });
  await expect.poll(displayedY).toBeGreaterThan(before);
  const savedY = await displayedY();
  const position = await page.locator('#position').inputValue();
  await event({ sysEvent: { eventType: 4 } }); // Suspend commits the position immediately.
  await expect.poll(async () => Object.values((await saved.read())?.positions || {}).some(p => p.percent > 0)).toBe(true);
  await context.close();
  await openWebView(); // No IndexedDB/localStorage survives; restore only SDK phone storage.
  await ready();
  assert.equal(await page.locator('#position').inputValue(), position);
  assert.equal(await displayedY(), savedY);
  const bodies = await page.evaluate(() => window.__bodies);
  assert.ok(!bodies.some(body => /Choose a document|Add files on your phone/.test(body)), 'restoring a PDF never sends the empty-library prompt');
  const restored = await page.evaluate(() => JSON.parse(localStorage.getItem('even-reader:diagnostics:v1')));
  assert.equal(restored.pdf.cached, true);
  assert.equal(restored.counts['pdf-cache-hit'], 1);
  assert.ok(!restored.events.some(e => e.type === 'pdf-stage' && /extracting-text|rendering-page|ocr|analyzing-layout/.test(e.stage)), 'cold restore skips all-page preparation');
  result.coldRestore = { position, y: savedY, sdkStorageOnly: true, cached: true };
  result.cacheChars = [...phoneData].filter(([key]) => key.includes(':pdf-cache:body:')).reduce((n, [, value]) => n + value.length, 0);
  const resumed = await displayedY();
  await event({ sysEvent: { eventType: 4 } }); await event({ sysEvent: { eventType: 5 } });
  await event({ textEvent: { eventType: 2 } }); await expect.poll(displayedY).toBeGreaterThan(resumed);
  result.suspendResume = true;
  await event({ textEvent: { eventType: 3 } });
  await choose('broken');
  await until(() => window.__body.includes('Could not open PDF'));
  result.errorOnGlasses = true;

  // Exercise the independent OCR render path while animation frames remain stopped.
  const scan = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 600; c.height = 800;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 600, 800); ctx.fillStyle = '#000'; ctx.font = '24px sans-serif';
    ['Offline recognition works on this scanned page.', 'Readable words remain available without a server.',
      'A paragraph keeps its text and follows the figure.', 'The original document stays saved on this device.'].forEach((s, i) => ctx.fillText(s, 30, 70 + i * 34));
    ctx.strokeRect(100, 250, 400, 160); ctx.beginPath(); ctx.moveTo(100, 400); ctx.lineTo(220, 280); ctx.lineTo(400, 360); ctx.stroke();
    ctx.fillText('Figure labels stay in the image.', 120, 440);
    const rgba = ctx.getImageData(0, 0, 600, 800).data; const rgb = new Uint8Array(600 * 800 * 3);
    for (let n = 0; n < 600 * 800; n++) rgb.set(rgba.subarray(n * 4, n * 4 + 3), n * 3);
    let encoded = ''; for (let n = 0; n < rgb.length; n += 8192) encoded += String.fromCharCode(...rgb.subarray(n, n + 8192)); return btoa(encoded);
  });
  await page.locator('#file-picker').setInputFiles({ name: 'scan.pdf', mimeType: 'application/pdf', buffer: scannedPdfFixture(600, 800, Buffer.from(scan, 'base64')) });
  await until(() => document.querySelector('#doc-count').textContent === '3' && document.querySelector('#imports').dataset.pending === '0');
  await event({ textEvent: { eventType: 3 } }); await choose('scan');
  await until(() => document.querySelector('#doc-path').textContent === 'scan.pdf' && !document.querySelector('#bookmark').disabled);
  await expect(page.locator('#pdf-reflow')).toBeChecked();
  await until(() => !document.querySelector('#bookmark').disabled && document.querySelector('#notice').hidden, null, 120000);
  await page.locator('#search').evaluate(el => { el.value = 'Offline recognition'; el.dispatchEvent(new Event('input')); });
  await until(() => /offline recognition/i.test(document.querySelector('#search-results').textContent));
  result.ocrWithoutAnimationFrames = true;
  result.ocrText = await page.evaluate(() => window.__ocrText);
  assert.match(result.ocrText, /offline recognition/i);
  await context.close(); await openWebView(); await ready();
  const restoredScan = await page.evaluate(() => JSON.parse(localStorage.getItem('even-reader:diagnostics:v1')));
  assert.equal(restoredScan.pdf.cached, true);
  assert.equal(await page.evaluate(() => window.__ocrText), null, 'cached OCR does not rerun recognition');
  await page.locator('#search').evaluate(el => { el.value = 'Offline recognition'; el.dispatchEvent(new Event('input')); });
  await until(() => /offline recognition/i.test(document.querySelector('#search-results').textContent));
  result.ocrRestoredWithoutRecognition = true;
  assert.equal(await page.evaluate(() => document.hidden), true);
  result.rafRequests = await page.evaluate(() => window.__rafRequests);
  assert.deepEqual(result.errors, []); result.passed = true;
  console.log('PASS: glasses-only PDF selection, preparation progress, persisted selection, fresh-WebView position restore, paging, suspend/resume, errors and OCR with all animation frames paused.');
} catch (error) { result.error = error.stack; result.state = await page?.evaluate(() => ({ title: document.querySelector('#title')?.textContent, notice: document.querySelector('#notice-text')?.textContent, search: document.querySelector('#search-results')?.textContent, reflow: document.querySelector('#pdf-reflow')?.checked, pdf: JSON.parse(localStorage.getItem('even-reader:diagnostics:v1') || '{}').pdf, ocrText: window.__ocrText, body: window.__body, images: window.__images, raf: window.__rafRequests })).catch(() => null); throw error; }
finally { await writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2)); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
