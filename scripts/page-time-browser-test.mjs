// Exercise actual glasses page turns and session resets in the phone app.
import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { showLibrary, waitForPdfReady, showTool, chooseMode } from './ui-helpers.mjs';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';

process.env.PAGEBORNE_ASK_ORIGINS = '';
const out = 'test-results/page-time'; await mkdir(out, { recursive: true });
const vite = await createServer({ mode: 'release', cacheDir: '.state/vite-page-time', plugins: [{
  name: 'page-time-fixture', transform(code, id) {
    if (id.endsWith('/src/main.js')) return code.replace('enabled: DEBUG', 'enabled: true');
    // Reading estimates do not depend on downloading or checking speech models.
    if (id.endsWith('/src/speech-setup.js')) return code.replace('start(initialize) {', 'start(initialize) { this.blocked = false; return Promise.resolve();');
  },
}], server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, clearScreen: false });
await vite.listen(); const results = [];
try {
  for (const engine of process.env.PAGE_TIME_BROWSER === 'chromium' ? [chromium] : [chromium, webkit]) {
    const browser = await engine.launch({ headless: true, executablePath: engine === chromium ? process.env.CHROME_PATH || '/usr/bin/google-chrome' : process.env.WEBKIT_PATH });
    const page = await browser.newPage({ viewport: { width: 440, height: 806 } });
    const result = { engine: engine.name(), passed: false, errors: [], physicalGlasses: false }; results.push(result);
    page.on('pageerror', error => result.errors.push(error.message));
    try {
      await page.addInitScript(() => {
        const storage = new Map(); window.__boxes = {};
        window.flutter_inappwebview = { async callHandler(_, payload) {
          const m = JSON.parse(payload);
          if (m.method === 'getLocalStorage') return storage.get(m.data.key) || '';
          if (m.method === 'setLocalStorage') { storage.set(m.data.key, m.data.value); return true; }
          for (const text of m.method === 'textContainerUpgrade' ? [m.data] : m.data?.textObject || []) window.__boxes[text.containerName] = text.content;
          return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
        } };
      });
      const event = eventType => page.evaluate(eventType => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { sysEvent: { eventType } } })), eventType);
      const status = () => page.evaluate(() => window.__boxes.status || '');
      const body = () => page.evaluate(() => window.__boxes.body || '');
      const timePattern = /(?:~\d+[mh]|<1m)/;
      const pageNumber = number => new RegExp(`\\bpg\\. ${number}(?:\\s|$)`);
      const seek = value => page.locator('#position').evaluate((el, value) => { el.value = String(value); el.dispatchEvent(new Event('input')); }, value);
      const open = async name => {
        await showLibrary(page); await page.locator(`[data-document-id="${name}"] .document-card`).click();
        await expect(page.locator('#bookmark')).toBeEnabled(); await expect.poll(status).toContain('Pages');
        await expect.poll(status, { message: 'opening must reset the estimate in the acknowledged glasses frame' }).not.toMatch(timePattern);
      };
      const readPage = async () => {
        await page.waitForTimeout(350);
        const before = await body(); await event(2); await expect.poll(body).not.toBe(before);
      };
      await page.goto(vite.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled();
      await page.locator('#file-picker').setInputFiles([
        { name: 'pace.md', mimeType: 'text/markdown', buffer: Buffer.from('# Session pace\n\n' + Array.from({ length: 100 }, (_, i) => `Paragraph ${i}. Reading enough text to fill several glasses screens.\n\n`).join('')) },
        { name: 'other.md', mimeType: 'text/markdown', buffer: Buffer.from('# Another paper\n\nDifferent document.') },
        { name: 'pace.pdf', mimeType: 'application/pdf', buffer: pdfFixture('repeated-text') },
      ]);
      await open('pace.md'); await expect.poll(status).toMatch(pageNumber(1));
      // Skipping around the doc is not reading multiple pages.
      await seek(300); await seek(600); await seek(0);
      assert.doesNotMatch(await status(), timePattern);
      for (let i = 0; i < 4; i++) { await readPage(); assert.doesNotMatch(await status(), timePattern); }
      await readPage(); await expect.poll(status).toMatch(pageNumber(6)); await expect.poll(status).toMatch(timePattern);
      const estimate = (await status()).match(timePattern)[0];
      result.fifthCompletedPage = result.seeksNotSamples = true;
      // Menus return to the same estimate. Reopening even the same doc starts
      // again at its saved position with no estimate or persisted statistics.
      await page.locator('#preview-menu-toggle').click(); await expect.poll(body).toMatch(/^Pageborne menu/);
      await page.waitForTimeout(500); await page.locator('#preview-menu-toggle').click();
      await expect.poll(status).toContain(estimate);
      await page.locator('#preview').screenshot({ path: `${out}/${engine.name()}-markdown.png` });
      await open('pace.md'); await readPage(); assert.doesNotMatch(await status(), timePattern);
      await open('other.md'); await open('pace.md');
      result.sameDocumentReset = result.documentSwitchReset = true;
      await open('pace.pdf'); await waitForPdfReady(page); await expect.poll(status).toContain('Pages');
      for (let i = 0; i < 5; i++) { await readPage(); if (i < 4) assert.doesNotMatch(await status(), timePattern); }
      await expect.poll(status).toMatch(timePattern);
      await page.locator('#preview').screenshot({ path: `${out}/${engine.name()}-pdf.png` });
      result.pdfScreens = true;
      const goToPdfPage = async number => {
        await showTool(page, 'outline');
        await page.locator('#outline button').filter({ hasText: `PDF page ${number}` }).click();
        await expect.poll(status).toMatch(pageNumber(number));
      };
      for (const number of [5, 2, 8]) await goToPdfPage(number);
      await goToPdfPage(5);
      for (const mode of ['auto', 'speed', 'page']) {
        await chooseMode(page, mode); await expect.poll(status).toMatch(pageNumber(5));
        assert.doesNotMatch(await status(), /^pg\. 5\//);
      }
      await page.locator('#preview').screenshot({ path: `${out}/${engine.name()}-pdf-page-number.png` });
      await open('other.md'); await open('pace.pdf'); await waitForPdfReady(page);
      await expect.poll(status).toMatch(pageNumber(5));
      result.pdfOriginalPagesAndCachedReopen = result.pageNumbersAcrossModes = true;
      await showTool(page, 'pdf'); await page.locator('#pdf-reflow').uncheck(); await waitForPdfReady(page);
      await goToPdfPage(7); await chooseMode(page, 'speed');
      await expect.poll(status).toMatch(pageNumber(7)); await expect.poll(status).toContain('Image ·');
      await page.locator('#preview').screenshot({ path: `${out}/${engine.name()}-pdf-raster-page-number.png` });
      result.pdfRasterPageNumber = true;
      // Without reflow, the same PDF is displayed as images. Fast turns must
      // not create a reading rate even though source OCR text is available.
      await chooseMode(page, 'page'); await goToPdfPage(1);
      for (let i = 0; i < 6; i++) {
        const position = await page.locator('#position').inputValue();
        await page.waitForTimeout(350); await event(2);
        await expect(page.locator('#position')).not.toHaveValue(position);
      }
      await expect.poll(status).not.toMatch(timePattern);
      result.imageTurnsIgnored = true;
      assert.deepEqual(result.errors, []); result.passed = true;
    } catch (error) { result.failure = error.stack; await page.screenshot({ path: `${out}/${engine.name()}-failure.png` }).catch(() => {}); }
    finally { await browser.close(); console.log(JSON.stringify(result)); }
  }
} finally { await vite.close(); await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2)); }
if (results.some(result => !result.passed)) process.exitCode = 1;
