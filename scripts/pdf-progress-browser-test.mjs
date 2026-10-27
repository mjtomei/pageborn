import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { access, readdir, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'vite';
import { displayProbe } from './display-probe.mjs';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';
import { showLibrary, showTool, showDockOptions, chooseMode, waitForPdfReady } from './ui-helpers.mjs';

const dir = path.resolve(process.env.PROGRESS_RESULTS || 'test-results/pdf-progress'); await mkdir(dir, { recursive: true });
const server = await createServer({ mode: 'release', cacheDir: '.state/vite-pdf-progress', plugins: [displayProbe(), {
  name: 'pdf-progress-speech-fixture', transform(code, id) {
    if (id.endsWith('/src/main.js')) return code.replace('enabled: DEBUG', 'enabled: true');
    if (id.endsWith('/src/speech-setup.js')) return code.replace('start(initialize) {', 'start(initialize) { this.blocked = false; return Promise.resolve();');
  },
}], server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, clearScreen: false });
await server.listen();
const engine = process.env.PDF_BROWSER || 'chromium';
const cache = path.join(os.homedir(), '.cache/ms-playwright');
const cached = (await readdir(cache)).filter(name => /^chromium-\d+$/.test(name));
const candidates = [process.env.CHROME_PATH, chromium.executablePath(), ...cached.flatMap(name => [path.join(cache, name, 'chrome-linux/chrome'), path.join(cache, name, 'chrome-linux64/chrome')])].filter(Boolean);
const executablePath = (await Promise.all(candidates.map(async file => { try { await access(file); return file; } catch { return null; } }))).find(Boolean);
const browser = await (engine === 'webkit' ? webkit.launch({ executablePath: process.env.WEBKIT_PATH }) : chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] }));
const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
const result = { passed: false, errors: [] }; let page;
const phoneStorage = new Map();
await context.exposeFunction('__phoneStorage', m => {
  if (m.method === 'getLocalStorage' && /^pageborne:models:v1:[a-f0-9]{64}$/.test(m.data.key)) return JSON.stringify({ id: 'fixture', chunks: 1, headers: {} });
  if (m.method === 'getLocalStorage') return phoneStorage.get(m.data.key) || '';
  phoneStorage.set(m.data.key, m.data.value); return true;
});
await context.addInitScript(() => {
  // This suite tests PDF progress/cancellation. Actual speech and persistent
  // checks are covered by speech-verification-browser-test.mjs.
  const NativeWorker = Worker;
  window.Worker = class {
    constructor(url, options) { if (!String(url).includes('ensemble-worker')) return new NativeWorker(url, options); }
    postMessage(data) { if (data.operation === 'prepare') queueMicrotask(() => this.onmessage({ data: { id: data.id, result: { verified: true } } })); }
    terminate() {}
  };
  window.flutter_inappwebview = { async callHandler(_, payload) {
    const m = JSON.parse(payload); if (m.method.endsWith('LocalStorage')) return __phoneStorage(m);
    return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
  } };
  const post = NativeWorker.prototype.postMessage; const pending = [];
  window.__holdFrom = 1; window.__gate = 'render'; window.__held = 0;
  NativeWorker.prototype.postMessage = function (...args) {
    const m = args[0];
    if (window.__failNextPage && m?.action === 'GetPage' && m.data.pageIndex > 0) {
      window.__failNextPage = false;
      return post.call(this, { ...m, data: { ...m.data, pageIndex: 999999 } });
    }
    const match = window.__gate === 'page' ? m?.action === 'GetPage'
      : m?.action === 'GetOperatorList' && !(m.data.intent & 0x100);
    if (match && m.data.pageIndex >= window.__holdFrom) { pending.push([this, args]); window.__held++; }
    else post.apply(this, args);
  };
  window.__release = (from = Infinity) => {
    window.__holdFrom = from;
    for (const [worker, args] of pending.splice(0)) worker.postMessage(...args);
  };
});
const diag = () => page.evaluate(() => JSON.parse(localStorage.getItem('even-reader:diagnostics:v1') || '{}'));
const anchor = () => page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('even-reader:preferences:v1')).positions).find(p => p.pdf));
const partial = async count => {
  await expect(page.locator('#bookmark')).toBeEnabled({ timeout: 120000 });
  await expect(page.locator('#notice-text')).toContainText(`${count} of`, { timeout: 120000 });
  await expect.poll(() => page.evaluate(() => window.__held)).toBeGreaterThan(0);
  assert.notEqual((await diag()).pdf.stage, 'ready');
  await expect.poll(() => page.evaluate(() => window.__displayFrame?.layout?.format)).toBe('pdf');
};
const jump = async value => page.locator('#position').evaluate((el, value) => { el.value = value; el.dispatchEvent(new Event('input')); }, value);
try {
  page = await context.newPage(); page.on('pageerror', error => result.errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled();

  await page.locator('#file-picker').setInputFiles([
    { name: 'progressive.pdf', mimeType: 'application/pdf', buffer: pdfFixture('repeated-text') },
    { name: 'other.md', mimeType: 'text/markdown', buffer: Buffer.from('# Another document\n\nStay in this document while the old PDF closes.') },
  ]);
  await showLibrary(page); await page.locator('[data-document-id="progressive.pdf"] .document-card').click();
  await partial(1); assert.equal((await diag()).counts['pdf-cache-saved'] || 0, 0);
  await expect(page.locator('#pdf-passage canvas').first()).toBeVisible();
  await jump('350'); await page.waitForTimeout(500); const before = await anchor(); assert.ok(before.pdf.offset > 0);
  // Browse without moving the glasses; growing layouts must not force follow.
  await page.locator('#pdf-passage').evaluate(el => { el.dispatchEvent(new Event('wheel')); el.scrollTop = 150; });
  const previewTop = await page.locator('#pdf-passage').evaluate(el => el.scrollTop);
  await page.evaluate(() => window.__release(3)); await partial(3);
  await expect.poll(async () => (await anchor()).pdf).toEqual(before.pdf);
  await expect(page.locator('#passage-current')).toHaveAttribute('aria-pressed', 'false');
  assert.ok(Math.abs(await page.locator('#pdf-passage').evaluate(el => el.scrollTop) - previewTop) < 2);
  result.partialPagingAndPreviewPreserved = true;
  await chooseMode(page, 'speed');
  await page.locator('#word-group').evaluate(el => { el.value = '1'; el.dispatchEvent(new Event('input')); });
  await jump('370'); await page.waitForTimeout(500); const word = (await anchor()).speedCursor;
  await page.evaluate(() => window.__release(6)); await partial(6);
  await expect.poll(async () => (await anchor()).speedCursor.key).toBe(word.key);
  await expect.poll(async () => (await anchor()).speedCursor.text).toBe(word.text);
  result.partialSpeedWordPreserved = true;
  await page.screenshot({ path: path.join(dir, 'reading-during-preparation.png'), fullPage: true });
  await page.evaluate(() => window.__release()); await waitForPdfReady(page);
  await expect.poll(async () => (await anchor()).speedCursor.key).toBe(word.key);
  assert.equal((await diag()).counts['pdf-cache-saved'], 1);
  await page.reload(); await waitForPdfReady(page);
  assert.equal((await diag()).pdf.cached, true); assert.equal((await diag()).counts['pdf-partial-ready'] || 0, 0);
  result.completedCacheReused = true;
  // A saved later-page location must not be replaced by an early-prefix clamp.
  await jump('900'); await page.waitForTimeout(500); const late = await anchor(); assert.ok(late.pdf.page > 1);
  await chooseMode(page,'page');
  await showTool(page, 'pdf'); await page.locator('#pdf-text-size').selectOption('24');
  await expect.poll(() => page.evaluate(() => window.__held)).toBeGreaterThan(0);
  await expect(page.locator('#bookmark')).toBeEnabled();
  await expect(page.locator('#notice-text')).toContainText('Preparing your saved place');
  await expect(page.locator('#pdf-passage canvas').first()).toBeVisible();
  assert.equal((await anchor()).pdf.page, late.pdf.page);
  await page.evaluate(() => window.__release()); await waitForPdfReady(page);
  await expect.poll(async () => (await anchor()).pdf.page).toBe(late.pdf.page);
  result.laterSavedPositionPreserved = true;
  // Choosing to read the prefix cancels the automatic return to the later save.
  await page.evaluate(() => { window.__holdFrom = 1; window.__held = 0; });
  await page.locator('#pdf-text-size').selectOption('28'); await partial(1);
  assert.equal((await anchor()).pdf.page, late.pdf.page);
  await jump('250'); await page.waitForTimeout(500);
  const chosenEarly = await anchor(); assert.equal(chosenEarly.pdf.page, 1);
  await page.evaluate(() => window.__release()); await waitForPdfReady(page);
  await expect.poll(async () => (await anchor()).pdf.page).toBe(1);
  result.readyPrefixWithLaterSave = true;
  // Stop preparation after its first usable page, then change documents.
  await jump('0'); await page.evaluate(() => { window.__holdFrom = 1; });
  await page.locator('#pdf-fit-figures').uncheck(); await partial(1);
  await showLibrary(page); await page.locator('[data-document-id="other.md"] .document-card').click();
  await page.evaluate(() => window.__release());
  await expect(page.locator('#title')).toHaveText('Another document');
  await expect(page.locator('#passage')).toContainText('Stay in this document');
  await page.waitForTimeout(500); assert.equal((await diag()).counts['pdf-cache-saved'], 2, 'cancelled preparation adds no cache entry');
  result.cancelledPreparationCannotReplaceDocument = true;

  await page.evaluate(() => { window.__gate = 'page'; window.__holdFrom = 1; window.__held = 0; });
  await page.locator('#file-picker').setInputFiles({ name: 'failed.pdf', mimeType: 'application/pdf', buffer: pdfFixture('repeated-text') });
  await showLibrary(page); await page.locator('[data-document-id="failed.pdf"] .document-card').click(); await partial(1);
  await page.evaluate(() => { window.__failNextPage = true; window.__release(); });
  await expect(page.locator('#notice-text')).toContainText('remaining PDF pages could not be prepared');
  await expect(page.locator('#bookmark')).toBeEnabled(); await jump('500');
  await expect(page.locator('#pdf-passage canvas').first()).toBeVisible();
  assert.equal((await diag()).counts['pdf-cache-saved'], 2, 'a failed prefix is never cached as complete');
  await showLibrary(page); await page.locator('[data-document-id="other.md"] .document-card').click();
  await page.locator('[data-document-id="failed.pdf"] .document-card').click(); await waitForPdfReady(page);
  assert.equal((await diag()).counts['pdf-cache-saved'], 3, 'reopening can finish and cache the previously failed PDF');
  result.failureKeepsReadyPagesAndRetryWorks = true;

  await page.evaluate(() => { window.__gate = 'page'; window.__holdFrom = 1; window.__held = 0; });
  await page.locator('#file-picker').setInputFiles({ name: 'notes.pdf', mimeType: 'application/pdf', buffer: pdfFixture('annotations') });
  await showLibrary(page); await page.locator('[data-document-id="notes.pdf"] .document-card').click(); await partial(1);
  await jump('350'); await page.waitForTimeout(500); const notePlace = await anchor();
  await showTool(page, 'pdf'); await page.locator('#pdf-footnotes').evaluate(button => button.click());
  await expect(page.locator('#pdf-footnotes')).toHaveText('Back to reading');
  await page.evaluate(() => window.__release());
  await expect.poll(async () => (await diag()).pdf.stage).toBe('ready');
  await expect(page.locator('#pdf-footnotes')).toHaveText('Back to reading');
  await page.locator('#pdf-footnotes').evaluate(button => button.click());
  await expect.poll(async () => (await anchor()).pdf).toEqual(notePlace.pdf);
  assert.equal((await diag()).counts['pdf-cache-saved'], 4);
  result.footnotesViewAndReturnSurviveCompletion = true;

  if (process.env.PDF_SAMPLE) {
    // Exercise real OCR and image previews while all later pages are stalled.
    const buffer = await readFile(process.env.PDF_SAMPLE);
    await page.evaluate(() => { window.__gate = 'page'; window.__holdFrom = 1; window.__held = 0; });
    await page.locator('#file-picker').setInputFiles({ name: 'scan.pdf', mimeType: 'application/pdf', buffer });
    await showLibrary(page); await page.locator('[data-document-id="scan.pdf"] .document-card').click();
    await partial(1); await expect(page.locator('#pdf-passage canvas').first()).toBeVisible();
    assert.equal((await diag()).counts['pdf-cache-saved'], 4);
    await page.evaluate(() => window.__release(3)); await partial(3);
    await chooseMode(page,'page'); await jump('500');
    await page.screenshot({ path: path.join(dir, 'scan-during-ocr.png'), fullPage: true });
    await showLibrary(page); await page.locator('[data-document-id="other.md"] .document-card').click();
    await page.evaluate(() => window.__release());
    await expect(page.locator('#title')).toHaveText('Another document');
    result.realScanReadableBeforeLaterPagesArrive = true;
  }
  await page.evaluate(() => { window.__gate = 'page'; window.__holdFrom = 1; window.__held = 0; });
  await page.locator('#file-picker').setInputFiles({ name: 'long-book.pdf', mimeType: 'application/pdf', buffer: pdfFixture('long-book') });
  await showLibrary(page); await page.locator('[data-document-id="long-book.pdf"] .document-card').click(); await partial(1);
  await page.evaluate(() => window.__release()); await waitForPdfReady(page, 120000);
  assert.equal((await diag()).pdf.pages, 450);
  await showLibrary(page); await page.locator('[data-document-id="other.md"] .document-card').click();
  await page.locator('[data-document-id="long-book.pdf"] .document-card').click(); await waitForPdfReady(page, 120000);
  assert.equal((await diag()).pdf.cached, true);
  result.longBookAndCache = true;
  await page.evaluate(() => { window.__gate = 'page'; window.__holdFrom = 1; window.__held = 0; });
  await page.locator('#file-picker').setInputFiles({ name: 'chapter.pdf', mimeType: 'application/pdf', buffer: pdfFixture('chapter-running-head') });
  await showLibrary(page); await page.locator('[data-document-id="chapter.pdf"] .document-card').click(); await partial(1);
  await page.evaluate(() => window.__release(3)); await partial(3);
  const chapterText = () => page.evaluate(() => (window.__displayFrame?.layout?.blocks || []).map(b => ({ page: b.page, text: b.text })));
  await expect.poll(async () => (await chapterText()).some(b => b.page === 2 && /ChapterPage2Start/.test(b.text))).toBe(true);
  await expect.poll(async () => (await chapterText()).some(b => b.page === 2 && /JOURNEY/.test(b.text))).toBe(false);
  assert.ok((await chapterText()).some(b => b.page === 1 && /A RIVER JOURNEY/.test(b.text)), 'real chapter title remains');
  assert.ok((await chapterText()).some(b => b.page === 2 && /ChapterPage2Start/.test(b.text)), 'body after the running header remains');
  await page.evaluate(() => window.__release()); await waitForPdfReady(page);
  await page.reload(); await waitForPdfReady(page);
  assert.equal((await diag()).pdf.cached, true);
  await expect.poll(async () => (await chapterText()).some(b => b.page === 2 && /ChapterPage2Start/.test(b.text))).toBe(true);
  await expect.poll(async () => (await chapterText()).some(b => b.page === 2 && /JOURNEY/.test(b.text))).toBe(false);
  result.runningHeadRemovedDuringPartialAndCachedReading = true;
  await page.evaluate(() => window.__release()); // Reload reinstalls the test's pause gate.
  await showTool(page, 'pdf'); await page.locator('#pdf-repeated-text').check(); await waitForPdfReady(page);
  await expect.poll(async () => (await chapterText()).some(b => b.page === 2 && /JOURNEY/.test(b.text))).toBe(true);
  result.explicitKeepHeadersHonored = true;
  assert.deepEqual(result.errors, []); result.passed = true;
  console.log('PASS: reading during stalled preparation, growing preview, exact word and source position, cache completion, late-page restoration and cancellation.');
} catch (error) { result.error = error.stack; result.diagnostic = await diag().catch(() => null); throw error; }
finally { await writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2)); await browser.close(); await server.close(); }
