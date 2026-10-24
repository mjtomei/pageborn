import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';
import { waitForPdfReady, showTool, showDockOptions, chooseMode, showSettings, hideSettings } from './ui-helpers.mjs';

const dir = path.resolve('test-results/pdf-entry'); await mkdir(dir, { recursive: true });
const server = createApp({ distDir: path.resolve('dist') }).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const cache = path.join(os.homedir(), '.cache/ms-playwright');
const cached = (await readdir(cache).catch(() => [])).filter(name => /^chromium-\d+$/.test(name));
const candidates = [process.env.CHROME_PATH, chromium.executablePath(), ...cached.flatMap(name =>
  [path.join(cache, name, 'chrome-linux/chrome'), path.join(cache, name, 'chrome-linux64/chrome')])].filter(Boolean);
const executablePath = (await Promise.all(candidates.map(async file => { try { await access(file); return file; } catch { return null; } }))).find(Boolean);
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const storage = new Map(); const result = { passed: false };
await page.exposeFunction('__storage', ({ method, data }) => {
  if (method === 'getLocalStorage') return storage.get(data.key) || '';
  storage.set(data.key, data.value); return true;
});
await page.addInitScript(() => {
  window.__body = ''; window.__bodies = []; window.__images = 0; window.__delay = 10;
  const record = raw => { window.__body = raw; if (raw.trim()) window.__bodies.push({ raw, at: performance.now() }); };
  window.flutter_inappwebview = { async callHandler(_name, serialized) {
    const message = JSON.parse(serialized);
    if (message.method.endsWith('LocalStorage')) return window.__storage(message);
    await new Promise(r => setTimeout(r, message.method === 'updateImageRawData' ? 10 : window.__delay));
    if (['createStartUpPageContainer', 'rebuildPageContainer'].includes(message.method)) {
      record(message.data.textObject.find(t => t.containerName === 'body')?.content || '');
      return message.method === 'createStartUpPageContainer' ? 0 : true;
    }
    if (message.method === 'textContainerUpgrade' && message.data.containerName === 'body') record(message.data.content);
    if (message.method === 'updateImageRawData') { window.__images++; return 0; }
    return true;
  } };
});
const enter = async (kind, value) => {
  if (kind !== 'position') await showDockOptions(page); await page.locator(`#${kind}-value`).click(); await page.locator('#value-input').fill(String(value));
  await page.locator('#value-apply').click(); await expect(page.locator('#value-dialog')).toBeHidden();
};
const figure = async () => {
  await showTool(page, 'search'); await page.locator('#search').fill('FigureStart');
  await expect(page.locator('#search-results button')).toHaveCount(1);
  const before = await page.evaluate(() => window.__images);
  await page.locator('#search-results button').click(); await page.locator('#tool-close').click();
  await expect.poll(() => page.evaluate(() => window.__images)).toBeGreaterThan(before);
  await expect.poll(() => page.evaluate(() => window.__body)).toBe('');
  await page.evaluate(() => { window.__bodies = []; });
};
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`); await expect(page.locator('#import')).toBeEnabled();
  await page.locator('#file-picker').setInputFiles({ name: 'mixed.pdf', mimeType: 'application/pdf', buffer: pdfFixture() });
  await expect(page.locator('#doc-count')).toHaveText('1');
  await page.locator('[data-document-id="mixed.pdf"] .document-card').click();
  await waitForPdfReady(page, 30000);
  await chooseMode(page, 'auto');
  await expect(page.locator('#reader-controls #entry-lines-control')).toHaveCount(0);
  await showTool(page, 'settings');
  await expect(page.locator('#shared-settings #entry-lines-value')).toHaveText('3 lines');
  await page.locator('#entry-lines-value').click();
  for (const invalid of ['', '0', '10', '2.5']) {
    await page.locator('#value-input').fill(invalid); await page.locator('#value-apply').click();
    await expect(page.locator('#value-dialog')).toBeVisible();
  }
  await page.locator('#value-cancel').click();
  await hideSettings(page);
  await enter('speed', 200); await figure();
  await page.evaluate(() => { window.__delay = 350; });
  await page.locator('#play').click();
  await expect.poll(() => page.evaluate(() => window.__bodies.length), { timeout: 30000 }).toBeGreaterThanOrEqual(8);
  await page.locator('#play').click(); await page.waitForTimeout(900);
  const frames = await page.evaluate(() => window.__bodies);
  const firstLines = frames[0].raw.split('\n').slice(6);
  assert.equal(firstLines.length, 3);
  for (let i = 0; i < 7; i++) {
    const lines = frames[i].raw.split('\n'); const padding = 6 - i;
    assert.equal(lines.length, 9); assert.deepEqual(lines.slice(0, padding), Array(padding).fill(''));
    assert.deepEqual(lines.slice(padding, padding + 3), firstLines, 'first three lines remain during filling');
    if (i) {
      assert.deepEqual(lines.slice(padding, -1), frames[i - 1].raw.split('\n').slice(padding + 1), 'one line enters at a time');
      assert.ok(frames[i].at - frames[i - 1].at >= 600, 'reveal waits for SDK acceptance and dwell');
    }
  }
  assert.deepEqual(frames[7].raw.split('\n').slice(0, 8), frames[6].raw.split('\n').slice(1), 'normal scrolling starts after filling');
  for (const count of [1, 9]) {
    await page.evaluate(() => { window.__delay = 10; });
    await showTool(page, 'settings');
    await enter('entry-lines', count); await figure(); await page.locator('#play').click();
    await expect.poll(() => page.evaluate(() => window.__bodies.length), { timeout: 15000 }).toBeGreaterThan(0);
    await page.locator('#play').click();
    const raw = await page.evaluate(() => window.__bodies[0].raw);
    assert.equal(raw.match(/^\n*/)[0].length, 9 - count);
    await page.screenshot({ path: path.join(dir, `entry-${count}-lines.png`), fullPage: true });
  }
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await page.waitForTimeout(600);
  await page.reload(); await waitForPdfReady(page, 30000);
  await showTool(page, 'settings');
  await expect(page.locator('#entry-lines-value')).toHaveText('Full screen');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('even-reader:preferences:v1')).pdfEntryLines), 9);
  for (const width of [320, 390, 1024]) {
    await page.setViewportSize({ width, height: 640 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no overflow at ${width}`);
    assert.ok(await page.locator('#entry-lines-control').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    assert.ok(await page.locator('#reader-controls').evaluate(el => el.getBoundingClientRect().bottom <= innerHeight + 1));
  }
  for (const mode of ['page', 'speed']) { await chooseMode(page, mode); await expect(page.locator('#entry-lines-control')).toBeVisible(); }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.keyboard.press('Escape');
  await expect(page.locator('#library-panel')).toHaveAttribute('data-open', 'false');
  await showSettings(page); await page.locator('#entry-lines-help').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(dir, 'settings-narrow.png'), fullPage: true });
  await hideSettings(page); await expect(page.locator('#entry-lines-control')).toBeHidden();
  assert.deepEqual(errors, []);
  Object.assign(result, { passed: true, sharedSettingsLocation: true, defaultThreeLines: true, everyRevealAcknowledged: true, oneAndNineLines: true, numericValidation: true, persistence: true, narrowLayouts: true });
  console.log(JSON.stringify(result));
} catch (error) {
  result.error = error.stack; await page.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }); throw error;
} finally {
  await writeFile(path.join(dir, 'result.json'), JSON.stringify({ ...result, errors }, null, 2));
  await browser.close(); server.close();
}
