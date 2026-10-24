import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';
import { showLibrary } from './ui-helpers.mjs';

const dir = path.resolve(process.env.DEBUG_RESULTS || 'test-results/diagnostics-browser');
await mkdir(dir, { recursive: true });
const server = createApp({ distDir: path.resolve('dist') }).listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const cache = path.join(os.homedir(), '.cache/ms-playwright');
const names = (await readdir(cache)).filter(name => /^chromium-\d+$/.test(name));
const paths = [process.env.CHROME_PATH, chromium.executablePath(), ...names.flatMap(name =>
  [path.join(cache, name, 'chrome-linux/chrome'), path.join(cache, name, 'chrome-linux64/chrome')])].filter(Boolean);
const executablePath = (await Promise.all(paths.map(async file => { try { await access(file); return file; } catch { return null; } }))).find(Boolean);
const browser = await chromium.launch({ headless: true, executablePath });
const url = `http://127.0.0.1:${server.address().port}`;
const result = { passed: false, errors: [] }; let page;
const broken = { name: 'private-document-title.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nPRIVATE DOCUMENT CONTENT\n%%EOF') };
try {
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', error => result.errors.push(error.message));
  await page.goto(url); await expect(page.locator('#import')).toBeEnabled();
  await page.locator('#file-picker').setInputFiles([broken, { name: 'valid.pdf', mimeType: 'application/pdf', buffer: pdfFixture() }]);
  await expect(page.locator('#doc-count')).toHaveText('2');
  await page.locator('[data-document-id="private-document-title.pdf"] .document-card').click();
  await expect(page.locator('#notice')).toContainText('Could not open PDF');
  await page.locator('#error-export').click();
  await expect(page.locator('#debug-dialog')).toBeVisible();
  const download = page.waitForEvent('download'); await page.locator('#debug-download').click();
  const file = await download;
  assert.match(file.suggestedFilename(), /^pageborne-.*-debug-.*\.json$/);
  const exported = await readFile(await file.path(), 'utf8');
  const report = JSON.parse(exported);
  const failure = report.errors.find(item => item.type === 'pdf-open-error');
  assert.equal(failure.context.stage, 'loading-document');
  assert.equal(failure.occurrences, 1);
  // PDF.js's worker exception can lack a stack in Chrome. Assert its actual
  // message/context here; the injected native TypeError below must retain its stack.
  assert.equal(failure.error.name, 'InvalidPDFException'); assert.ok(failure.error.message);
  assert.ok(report.environment.userAgent); assert.ok(report.environment.capabilities.iteratorMap);
  assert.ok(!exported.includes(broken.name)); assert.ok(!exported.includes('PRIVATE DOCUMENT CONTENT'));
  await writeFile(path.join(dir, 'broken-pdf-export.json'), exported);
  // Native share accepts an actual File; cancelling or rejecting preserves it.
  await page.locator('#debug-close').click();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', { configurable: true, writable: true, value: async data => {
      window.__shared = { name: data.files[0].name, text: await data.files[0].text() };
    } });
  });
  await page.locator('#error-export').click(); await page.locator('#debug-share').click();
  await expect(page.locator('#debug-status')).toHaveText('Log shared.');
  assert.equal(JSON.parse(await page.evaluate(() => window.__shared.text)).errors[0].error.name, 'InvalidPDFException');
  await page.evaluate(() => { navigator.share = async () => { throw new DOMException('Cancelled', 'AbortError'); }; });
  await page.locator('#debug-share').click(); await expect(page.locator('#debug-status')).toContainText('cancelled');
  await expect(page.locator('#debug-dialog')).toBeVisible();
  await page.evaluate(() => {
    navigator.share = async () => { throw new Error('unavailable'); };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copied = text; } } });
  });
  await page.locator('#debug-share').click(); await expect(page.locator('#debug-status')).toContainText('Try Save file or Copy log');
  await page.locator('#debug-copy').click(); await expect(page.locator('#debug-status')).toContainText('Log copied');
  assert.ok(JSON.parse(await page.evaluate(() => window.__copied)).errors.length);
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('denied'); }; });
  await page.locator('#debug-copy').click(); await expect(page.locator('#debug-text')).toBeVisible();
  assert.ok(await page.locator('#debug-text').evaluate(el => el.selectionStart === 0 && el.selectionEnd === el.value.length));
  await page.screenshot({ path: path.join(dir, 'phone-export.png') });
  await page.keyboard.press('Escape'); await expect(page.locator('#debug-dialog')).toBeHidden();

  // Reproduce an opaque phone-like TypeError during an actual PDF page render.
  await page.evaluate(() => {
    const original = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function pageborneSyntheticPdfFailure(...args) {
      if (this.canvas.width >= 800) {
        CanvasRenderingContext2D.prototype.getImageData = original;
        throw new TypeError("undefined is not a function (near '...I of g...')");
      }
      return original.apply(this, args);
    };
  });
  await showLibrary(page); await page.locator('[data-document-id="valid.pdf"] .document-card').click();
  await expect(page.locator('#notice')).toContainText('undefined is not a function');
  await page.locator('#error-export').click();
  const detailed = JSON.parse(await page.locator('#debug-text').inputValue());
  const opaque = detailed.errors.find(item => item.error.message.includes('I of g'));
  assert.equal(opaque.context.page, 1); assert.ok(opaque.context.pages > 0);
  assert.ok(['rendering-page', 'reading-pixels'].includes(opaque.context.stage));
  assert.equal(opaque.context.canvasWidth, 900);
  assert.match(opaque.error.stack, /pageborneSyntheticPdfFailure/);
  await writeFile(path.join(dir, 'type-error-export.json'), JSON.stringify(detailed, null, 2));
  await page.reload(); await expect(page.locator('#import')).toBeEnabled({ timeout: 30000 });
  if (await page.locator('#library-toggle').getAttribute('aria-expanded') === 'true') await page.locator('#library-close').click();
  await page.locator('.settings summary').click(); await page.locator('#debug-export').click();
  assert.ok(JSON.parse(await page.locator('#debug-text').inputValue()).errors.some(item => item.error.message.includes('I of g')));

  // Errors also survive a completely fresh WebView through SDK phone storage.
  const phoneData = new Map();
  const phoneContext = async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.exposeFunction('__storage', message => {
      if (message.method === 'getLocalStorage') return phoneData.get(message.data.key) || '';
      phoneData.set(message.data.key, message.data.value); return true;
    });
    await context.addInitScript(() => {
      window.flutter_inappwebview = { callHandler: async (_, payload) => {
        const message = JSON.parse(payload);
        if (message.method.endsWith('LocalStorage')) return window.__storage(message);
        if (message.method === 'createStartUpPageContainer') return 0;
        return true;
      } };
    });
    return context;
  };
  let context = await phoneContext(); let phone = await context.newPage(); await phone.goto(url);
  await expect(phone.locator('#import')).toBeEnabled(); await phone.locator('#file-picker').setInputFiles(broken);
  await phone.locator('.document-card').click(); await expect(phone.locator('#notice')).toContainText('Could not open PDF');
  await phone.locator('#error-export').click();
  const firstRun = JSON.parse(await phone.locator('#debug-text').inputValue()).startedAt;
  await expect.poll(() => phoneData.has('even-reader:phone:v1:diagnostics')).toBe(true);
  await context.close();
  context = await phoneContext(); phone = await context.newPage(); await phone.goto(url);
  await expect(phone.locator('#import')).toBeEnabled({ timeout: 30000 });
  if (await phone.locator('#library-toggle').getAttribute('aria-expanded') === 'true') await phone.locator('#library-close').click();
  await phone.locator('.settings summary').click(); await phone.locator('#debug-export').click();
  const restored = JSON.parse(await phone.locator('#debug-text').inputValue());
  assert.ok(restored.errors.some(item => item.startedAt === firstRun && item.type === 'pdf-open-error'));
  await context.close();
  assert.deepEqual(result.errors, []); result.passed = true;
  console.log('PASS: corrupt PDF and injected TypeError logs, real file download, share/cancel/failure, copy/manual fallback, reload and fresh-WebView phone persistence.');
} catch (error) {
  result.error = error.stack; await page?.screenshot({ path: path.join(dir, 'failure.png') }).catch(() => {}); throw error;
} finally {
  await writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
