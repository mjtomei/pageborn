import { chromium, webkit, expect } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { showLibrary, showSettings, hideSettings, showTool, chooseMode, showDockOptions, backToReading } from './ui-helpers.mjs';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';
process.env.PAGEBORNE_ASK_ORIGINS = 'https://design-pass.test';
const vite = await createServer({ cacheDir: '.state/vite-design-pass', server: { host: '127.0.0.1', port: 0 }, clearScreen: false }); await vite.listen();
const out = 'test-results/design-pass'; await mkdir(out, { recursive: true }); const results = [];
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ executablePath: engine === chromium ? '/usr/bin/google-chrome' : process.env.WEBKIT_PATH, headless: true });
    const result = { engine: engine.name(), passed: false, errors: [] }; results.push(result);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    try {
      page.on('pageerror', e => result.errors.push(e.message));
      await page.addInitScript(() => {
        localStorage.setItem('even-reader:preferences:v1', JSON.stringify({ ask: { mode: 'provider', provider: 'openai-compatible', baseUrl: 'https://design-pass.test', model: 'fixture' } }));
        const NativeWorker = Worker;
        window.Worker = class {
          constructor(url, options) { if (!String(url).includes('speech-worker')) return new NativeWorker(url, options); }
          postMessage(data) { queueMicrotask(() => this.onmessage?.({ data: { id: data.id, result: { backend: data.backend, model: data.model } } })); }
          terminate() {}
        };
      });
      await page.route('https://design-pass.test/**', async route => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } });
        await route.fulfill({ json: { choices: [{ message: { content: 'A concise answer about the marked passage.' } }] }, headers: { 'Access-Control-Allow-Origin': '*' } });
      });
      await page.goto(vite.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled();
      await expect(page.locator('#library-sync-summary')).toHaveText('Not set up'); await page.locator('#library-sync').click();
      await expect(page.locator('#ask-connection-settings')).toHaveAttribute('open', '');
      await expect(page.locator('#ask-connection-summary')).toHaveText('fixture');
      // Section shortcuts open collapsed sections without a helper forcing them open.
      await page.locator('#settings-voice > summary').click(); await expect(page.locator('#speech-backend')).toBeVisible();
      await page.locator('#settings-voice > summary').click(); await page.locator('.settings-jump a[href="#settings-voice"]').click(); await expect(page.locator('#speech-backend')).toBeVisible();
      await page.locator('#font-size').selectOption('26'); await hideSettings(page); await showLibrary(page);
      for (const width of [320, 390, 430]) {
        await page.setViewportSize({ width, height: 844 }); await page.waitForTimeout(250);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `library overflow at ${width}`);
        const header = await page.locator('.library-title-row').boundingBox(); const buttons = await page.locator('.library-title-actions').boundingBox();
        assert(buttons.x + buttons.width <= header.x + header.width + 1, `library actions overflow at ${width}`);
      }
      await page.setViewportSize({ width: 390, height: 844 }); await showSettings(page); await page.locator('#font-size').selectOption('12'); await hideSettings(page); await showLibrary(page);
      await page.locator('#file-picker').setInputFiles([
        { name: 'design.md', mimeType: 'text/markdown', buffer: Buffer.from('# Design sample\n\n' + Array.from({ length: 80 }, (_, i) => `## Section ${i}\n\n${'Long context for highlighting the search result. '.repeat(4)} UniqueNeedle${i} sits here. ${'More useful context. '.repeat(5)}\n\n`).join('')) },
        { name: 'design.pdf', mimeType: 'application/pdf', buffer: pdfFixture('annotations') },
      ]);
      await page.locator('[data-document-id="design.md"] .document-card').click(); await expect(page.locator('#bookmark')).toBeEnabled();
      await page.locator('#dock-toggle').click(); await expect(page.locator('#mode-menu')).toBeVisible();
      await page.keyboard.press('Escape'); await expect(page.locator('#mode-menu')).toBeHidden(); await expect(page.locator('#dock-toggle')).toBeFocused();
      await chooseMode(page, 'auto'); await expect(page.locator('#mode-menu')).toBeHidden(); await expect(page.locator('#pace-toggle')).toBeVisible();
      await showDockOptions(page); await expect(page.locator('#speed')).toBeVisible(); assert.equal((await page.locator('#speed').boundingBox()).height, 48);
      await chooseMode(page, 'speed'); await expect(page.locator('#word-group-value')).toBeVisible();
      await chooseMode(page, 'page'); await expect(page.locator('#pace-toggle')).toBeHidden(); await expect(page.locator('#dock-options')).toBeHidden();
      await showTool(page, 'search'); await page.locator('#search').fill('UniqueNeedle10');
      await expect(page.locator('#search-results mark')).toHaveText('UniqueNeedle10');
      assert((await page.locator('#search-results .nav-item > span').first().innerText()).length < 120);
      await page.locator('#tool-close').click();
      await page.locator('#position').evaluate(el => { el.value = '420'; el.dispatchEvent(new Event('input')); });
      const origin = Number(await page.locator('#position').inputValue());
      const previewLabel = await page.locator('#preview').getAttribute('aria-label');
      await page.locator('#ask-open').click(); await expect(page.locator('#ask-panel')).toBeVisible();
      await expect(page.locator('#ask-back, #ask-navigation')).toHaveCount(0); await expect(page.locator('#transport')).toBeHidden();
      await expect(page.locator('#preview')).toHaveAttribute('aria-label', previewLabel);
      await page.locator('#ask-question').fill('Explain this passage.'); await page.locator('#ask-send').click();
      await expect(page.locator('.ask-message-actions').getByRole('button', { name: 'Copy answer' })).toBeVisible();
      // Force the clipboard fallback without requesting system clipboard access.
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied by fixture'); } } }));
      await page.getByRole('button', { name: 'Copy answer', exact: true }).click();
      assert.equal(await page.evaluate(() => getSelection().toString()), 'A concise answer about the marked passage.');
      await expect(page.locator('#ask-footer')).toBeHidden();
      await page.waitForTimeout(4500); await expect(page.locator('#ask-footer')).toBeHidden();
      await backToReading(page); await page.locator('#position').evaluate(el => { el.value = '800'; el.dispatchEvent(new Event('input')); });
      await page.locator('#ask-open').click(); await page.getByRole('button', { name: /^Go to the passage/ }).click();
      await expect(page.locator('#ask-panel')).toBeHidden(); assert(Math.abs(Number(await page.locator('#position').inputValue()) - origin) <= 10);
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: width > 1000 ? 1000 : 844 }); await page.waitForTimeout(250); await page.locator('#ask-open').click();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `chat overflow at ${width}`);
        if (width >= 1200) { await expect(page.locator('#passage')).toBeHidden(); const box = await page.locator('#ask-panel').boundingBox(); assert(box.width > 350); }
        await page.screenshot({ path: `${out}/${engine.name()}-${width}-chat.png` }); await backToReading(page);
      }
      await page.setViewportSize({ width: 390, height: 844 }); await showLibrary(page); await page.locator('[data-document-id="design.pdf"] .document-card').click();
      await expect(page.locator('#bookmark')).toBeEnabled({ timeout: 60000 }); await showTool(page, 'pdf');
      const helpId = await page.locator('#pdf-reflow-help').evaluate(el => el.closest('dialog').id);
      await page.locator(`button[aria-controls="${helpId}"]`).click();
      for (const id of ['pdf-reflow-help', 'pdf-figures-help', 'pdf-margin-help', 'pdf-repeated-help', 'pdf-colors-help']) await expect(page.locator(`#${id}`)).toBeVisible();
      await page.keyboard.press('Escape');
      assert.deepEqual(result.errors, []); result.passed = true;
    } catch (error) { result.error = error.stack; await page.screenshot({ path: `${out}/${engine.name()}-failure.png` }); throw error; }
    finally { await browser.close(); }
  }
} finally { await vite.close(); await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2)); }
console.log(JSON.stringify(results));
