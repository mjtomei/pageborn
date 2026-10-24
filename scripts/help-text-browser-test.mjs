import { chromium, webkit, expect } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { showSettings, hideSettings, showLibrary, backToReading } from './ui-helpers.mjs';

process.env.PAGEBORNE_ASK_ORIGINS = 'https://help-fixture.test';
const vite = await createServer({ cacheDir: '.state/vite-help-text', server: { host: '127.0.0.1', port: 0 }, clearScreen: false }); await vite.listen();
const out = 'test-results/help-text'; await mkdir(out, { recursive: true }); const reports = [];
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ executablePath: engine === chromium ? '/usr/bin/google-chrome' : process.env.WEBKIT_PATH, headless: true });
    const report = { engine: engine.name(), passed: false, errors: [] }; reports.push(report);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      page.on('pageerror', error => report.errors.push(error.message));
      await page.addInitScript(() => {
        const Original = Worker;
        window.Worker = class {
          constructor(url, options) { if (!String(url).includes('speech-worker')) return new Original(url, options); }
          postMessage(data) { queueMicrotask(() => this.onmessage({ data: { id: data.id, result: { backend: data.backend, model: data.model } } })); }
          terminate() {}
        };
      });
      await page.goto(vite.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled();
      await showSettings(page); await expect(page.locator('#font-size')).toBeEnabled();
      assert.equal(await page.locator('#shared-settings #font-size').count(), 1);
      await expect(page.locator('#speech-vocabulary-help')).toBeVisible();
      assert.equal(await page.locator('#shared-settings .help-button').count(), 0);
      assert.equal(await page.locator('#shared-settings #speech-status').count(), 1);
      await expect(page.locator('#ask-context-tokens, #ask-config-test, #speech-prepare, #speech-compare, #speech-test-file, #speech-test-output')).toHaveCount(0);
      await expect(page.locator('#speech-retry')).toBeHidden();
      await hideSettings(page); await showLibrary(page);
      await page.locator('#file-picker').setInputFiles(['first', 'second'].map(name => ({ name: `${name}.md`, mimeType: 'text/markdown', buffer: Buffer.from(`# ${name}\n\n${'Reading text with a few words. '.repeat(80)}`) })));
      await expect(page.locator('#doc-count')).toHaveText('2'); await page.locator('[data-document-id="first.md"] .document-card').click();
      await expect(page.locator('#passage button').first()).toBeVisible();
      await expect(page.locator('#passage-help')).toBeHidden(); await expect(page.locator('#glasses-hints')).toBeHidden();
      await page.locator('#hints-toggle').click(); await expect(page.locator('#glasses-hints')).toBeVisible();
      await page.keyboard.press('Escape'); await expect(page.locator('#hints-toggle')).toBeFocused();
      const selectors = ['#title', '#play', '#tab-search', '#ask-question', '#font-size', '#passage button'];
      const sizes = () => page.evaluate(selectors => selectors.map(selector => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)), selectors);
      const baseline = await sizes();
      for (const [size, scale] of [['22', 1.2], ['26', 1.4], ['12', 1]]) {
        await showSettings(page); await page.locator('#font-size').selectOption(size); await hideSettings(page);
        const actual = await sizes(); actual.forEach((value, i) => assert(Math.abs(value / baseline[i] - scale) < .01, `${selectors[i]} shares scale ${scale}`));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      }
      await page.locator('#ask-open').click(); await expect(page.locator('#ask-voice-models')).toBeHidden();
      await expect(page.locator('.ask-head #ask-help')).toBeVisible();
      await expect(page.locator('.ask-status-row')).toBeHidden();
      const header = await page.locator('.ask-head .tool-panel-head').boundingBox(), help = await page.locator('#ask-help').boundingBox();
      assert(help.y >= header.y && help.y + help.height <= header.y + header.height + 1);
      await page.screenshot({ path: `${out}/${engine.name()}-ask-header.png` });
      await page.locator('#ask-help').click();
      await expect(page.locator('#ask-voice-models')).toBeVisible(); await expect(page.locator('#ask-voice-models')).toContainText('CPU draft');
      await page.screenshot({ path: `${out}/${engine.name()}-voice-help.png` });
      await page.keyboard.press('Escape'); await expect(page.locator('#ask-voice-models')).toBeHidden();
      await backToReading(page);
      await showSettings(page); await page.locator('#font-size').selectOption('26'); await hideSettings(page);
      await showLibrary(page); await page.locator('[data-document-id="second.md"] .document-card').click();
      await expect(page.locator('#font-size')).toHaveValue('26');
      await page.reload(); await expect(page.locator('#import')).toBeEnabled(); await expect(page.locator('#font-size')).toHaveValue('26');
      await expect(page.locator('#bookmark')).toBeEnabled(); await expect(page.locator('#passage button').first()).toContainText('second');
      await page.waitForFunction(() => document.querySelector('#library-panel').getBoundingClientRect().bottom < 1);
      await expect(page.locator('#glasses-hints')).toBeHidden();
      await page.screenshot({ path: `${out}/${engine.name()}-large.png` });
      assert.deepEqual(report.errors, []); report.passed = true;
    } finally { await browser.close(); }
  }
} finally { await vite.close(); await writeFile(`${out}/results.json`, JSON.stringify(reports, null, 2)); }
console.log(JSON.stringify(reports));
