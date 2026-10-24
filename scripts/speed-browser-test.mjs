import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';
import { showLibrary, showTool, showDockOptions, chooseMode } from './ui-helpers.mjs';

const dir = path.resolve('test-results/speed-reading'); await mkdir(dir, { recursive: true });
const server = createApp({ distDir: path.resolve('dist') }).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const cache = path.join(os.homedir(), '.cache/ms-playwright');
const cached = (await readdir(cache).catch(() => [])).filter(name => /^chromium-\d+$/.test(name));
const candidates = [process.env.CHROME_PATH, chromium.executablePath(), ...cached.flatMap(name =>
  [path.join(cache, name, 'chrome-linux/chrome'), path.join(cache, name, 'chrome-linux64/chrome')])].filter(Boolean);
const executablePath = (await Promise.all(candidates.map(async file => { try { await access(file); return file; } catch { return null; } }))).find(Boolean);
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = []; page.on('pageerror', e => errors.push(e.message));
const result = { passed: false }; const storage = new Map();
await page.exposeFunction('__storage', ({ method, data }) => {
  if (method === 'getLocalStorage') return storage.get(data.key) || '';
  storage.set(data.key, data.value); return true;
});
await page.addInitScript(() => {
  window.__body = ''; window.__status = ''; window.__bodies = []; window.__images = 0; window.__delay = 5;
  window.flutter_inappwebview = { async callHandler(_name, serialized) {
    const message = JSON.parse(serialized);
    if (message.method.endsWith('LocalStorage')) return window.__storage(message);
    await new Promise(r => setTimeout(r, window.__delay));
    if (['createStartUpPageContainer', 'rebuildPageContainer'].includes(message.method)) {
      window.__body = message.data.textObject.find(t => t.containerName === 'body')?.content || '';
      window.__status = message.data.textObject.find(t => t.containerName === 'status')?.content || '';
      return message.method === 'createStartUpPageContainer' ? 0 : true;
    }
    if (message.method === 'textContainerUpgrade') {
      if (message.data.containerName === 'body') { window.__body = message.data.content; window.__bodies.push({ text: window.__body.trim(), at: performance.now() }); }
      else if (message.data.containerName === 'status') window.__status = message.data.content;
    }
    if (message.method === 'updateImageRawData') { window.__images++; return 0; }
    return true;
  } };
});
const title = 'A whole section title with more than ten words all shown together';
const nextTitle = 'Another complete section title';
const hugeTitle = 'This exceptionally long heading '.repeat(60).trim() + ' END';
const normalizedBody = () => body().then(text => text.replace(/\s+/g, ' '));
const body = () => page.evaluate(() => window.__body.trim());
const enter = async (kind, value) => {
  if (kind !== 'position') await showDockOptions(page); await page.locator(`#${kind}-value`).click(); await page.locator('#value-input').fill(String(value));
  await page.locator('#value-apply').click(); await expect(page.locator('#value-dialog')).toBeHidden();
};
const open = async name => {
  await showLibrary(page); await page.locator(`[data-document-id="${name}"] .document-card`).click();
  await expect(page.locator('#bookmark')).toBeEnabled({ timeout: 30000 });
};
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`); await expect(page.locator('#import')).toBeEnabled();
  await page.locator('#file-picker').setInputFiles([
    { name: 'words.txt', mimeType: 'text/plain', buffer: Buffer.from(Array.from({ length: 72 }, (_, i) => `word${String(i).padStart(2, '0')}`).join(' ')) },
    { name: 'short.txt', mimeType: 'text/plain', buffer: Buffer.from('one two three four five six seven') },
    { name: 'titles.md', mimeType: 'text/markdown', buffer: Buffer.from(`# ${title}\n\nprefix body\n\n## ${nextTitle}\n\nfollowing body words`) },
    { name: 'long-title.md', mimeType: 'text/markdown', buffer: Buffer.from(`# ${hugeTitle}\n\nbody after title`) },
    { name: 'figures.pdf', mimeType: 'application/pdf', buffer: pdfFixture() },
  ]);
  await expect(page.locator('#doc-count')).toHaveText('5'); await open('words.txt');
  await chooseMode(page, 'speed');
  await expect(page.locator('#word-group-value')).toHaveText('3 words');
  await expect(page.locator('#speed-value')).toHaveText('250 wpm');
  await expect.poll(body).toBe('word00 word01 word02');
  await expect.poll(() => page.evaluate(() => window.__status)).toMatch(/Ⅱ 250 wpm <1m +pg\. 1 +Hold: speak · 2×(?: tap)?: Ask$/);
  const centered = await page.evaluate(() => window.__body);
  assert.match(centered, /^\n{4} +word00/);
  await enter('word-group', 2); await expect.poll(body).toBe('word00 word01');
  await showDockOptions(page); await page.locator('#word-group-value').click();
  for (const invalid of ['', '0', '11', '2.5']) {
    await page.locator('#value-input').fill(invalid); await page.locator('#value-apply').click();
    await expect(page.locator('#value-dialog')).toBeVisible();
  }
  await page.locator('#value-cancel').click(); await enter('word-group', 3); await enter('speed', 600);
  await showDockOptions(page); await page.locator('#speed').focus(); await page.keyboard.press('ArrowRight'); await expect(page.locator('#speed-value')).toHaveText('720 wpm');
  await enter('speed', 600);
  await expect.poll(() => page.evaluate(() => window.__status)).toMatch(/600 wpm  ~10s left$/);
  // At least two successive groups share one source row. A y-only display
  // acknowledgement would skip these while the slow bridge is still working.
  await page.evaluate(() => { window.__delay = 500; window.__bodies = []; });
  await page.locator('#play').click();
  await expect.poll(() => page.evaluate(() => window.__bodies.filter(b => b.text.startsWith('word')).length), { timeout: 18000 }).toBeGreaterThanOrEqual(6);
  await page.locator('#play').click();
  await expect(page.locator('#play')).toHaveText('Start speed reading');
  await page.waitForTimeout(1800);
  const shown = await page.evaluate(() => window.__bodies.filter(b => b.text.startsWith('word')));
  const groups = shown.filter((entry, i) => i === 0 || entry.text !== shown[i - 1].text);
  const numbers = groups.flatMap(entry => entry.text.match(/word\d+/g).map(word => Number(word.slice(4))));
  assert.ok(numbers.length >= 18);
  for (let i = 1; i < numbers.length; i++) assert.equal(numbers[i], numbers[i - 1] + 1, 'no skipped or repeated words with a slow bridge');
  for (let i = 1; i < groups.length; i++) assert.ok(groups[i].at - groups[i - 1].at >= 750, 'each group dwells after acknowledgement');
  assert.equal(await page.evaluate(() => window.__images), 0, 'speed reading uses native text only');
  await page.evaluate(() => { window.__delay = 5; });
  const paused = await body(); await page.waitForTimeout(800); assert.equal(await body(), paused);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await page.waitForTimeout(600);
  await page.reload(); await expect(page.locator('#mode-speed')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(body).toBe(paused); await expect(page.locator('#speed-value')).toHaveText('600 wpm');
  await expect(page.locator('#word-group-value')).toHaveText('3 words');
  for (const mode of ['page', 'auto']) {
    await chooseMode(page, mode);
    // Reload immediately: changing modes must save the shared word now,
    // including words below the top of the last full-page viewport.
    await page.reload(); await expect(page.locator(`#mode-${mode}`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#bookmark')).toBeEnabled();
    await chooseMode(page, 'speed');
    await expect.poll(body).toBe(paused);
  }
  await chooseMode(page, 'page');
  await open('short.txt'); await chooseMode(page, 'speed');
  await open('words.txt'); await expect.poll(body).toBe(paused);
  result.sharedLocationAcrossModesAndDocuments = true;
  await showTool(page, 'bookmarks'); await page.locator('#bookmark').click();
  await enter('position', 0); await expect.poll(body).toBe('word00 word01 word02');
  await chooseMode(page, 'page');
  await page.locator('#bookmarks .nav-item').click();
  await chooseMode(page, 'speed'); await expect.poll(body).toBe(paused);
  await enter('position', 0);
  await page.locator('#bookmarks .nav-item').click(); await expect.poll(body).toBe(paused);
  await page.locator('#tool-close').click();
  await page.screenshot({ path: path.join(dir, 'phone-speed.png'), fullPage: true });
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no overflow at ${width}`);
    assert.ok(await page.locator('#word-group-control').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await open('short.txt'); await enter('word-group', 1); await enter('position', 50);
  await expect.poll(body).toBe('four'); await page.locator('#next').click(); await expect.poll(body).toBe('five');
  await page.locator('#previous').click(); await expect.poll(body).toBe('four');
  await enter('position', 100); await expect.poll(body).toBe('seven');
  await page.locator('#play').click(); await expect(page.locator('#play')).toHaveText('Restart');
  await enter('speed', 60);
  await page.locator('#play').click(); await expect.poll(body).toBe('one'); await page.locator('#play').click();
  await open('figures.pdf'); await enter('word-group', 10);
  await expect.poll(body).toMatch(/^Mixed columns/);
  // Step through the real prepared document until a figure is encountered.
  for (let i = 0; i < 90 && await page.locator('#play').textContent() !== 'Continue'; i++) {
    const before = await page.locator('#position').inputValue();
    await page.locator('#next').click(); await expect(page.locator('#position')).not.toHaveValue(before);
  }
  await expect(page.locator('#play')).toHaveText('Continue');
  await expect.poll(() => page.evaluate(() => window.__images)).toBeGreaterThan(0);
  const figurePosition = await page.locator('#position').inputValue();
  await page.waitForTimeout(1500); await expect(page.locator('#position')).toHaveValue(figurePosition);
  await page.screenshot({ path: path.join(dir, 'pdf-figure.png'), fullPage: true });
  await page.locator('#play').click(); await expect(page.locator('#play')).toHaveText('Pause');
  await expect.poll(() => page.evaluate(() => window.__body.trim())).not.toBe('');
  await page.locator('#play').click();
  const pdfWord = await body();
  await chooseMode(page, 'auto'); await expect(page.locator('#speed-value')).toHaveText('30 steps/min');
  await chooseMode(page, 'page'); await expect(page.locator('#play')).toHaveText('Next page');
  await page.reload(); await expect(page.locator('#bookmark')).toBeEnabled({ timeout: 30000 });
  await chooseMode(page, 'speed');
  await expect.poll(body).toBe(pdfWord);
  result.sharedPdfLocationAcrossModes = true;
  // Titles stay atomic even with one word per group and get twice the dwell.
  await open('titles.md'); await chooseMode(page, 'speed');
  await enter('word-group', 1); await enter('speed', 600);
  await expect.poll(normalizedBody).toBe(title);
  const started = Date.now(); await page.locator('#play').click();
  await page.waitForTimeout(1500); assert.equal(await normalizedBody(), title);
  await expect.poll(normalizedBody, { timeout: 6000 }).not.toBe(title);
  assert.ok(Date.now() - started >= 2400, 'title dwells at half the selected word rate');
  await expect.poll(normalizedBody).toBe(nextTitle); await page.locator('#play').click();
  await showTool(page, 'settings'); await page.locator('#pause-at-titles').check();
  await expect(page.locator('#play')).toHaveText('Continue');
  await page.waitForTimeout(1500); assert.equal(await normalizedBody(), nextTitle);
  await page.screenshot({ path: path.join(dir, 'title-settings.png'), fullPage: true });
  await page.locator('#play').click(); await expect.poll(normalizedBody).toBe('following');
  await page.locator('#play').click(); await enter('position', 0);
  await expect.poll(normalizedBody).toBe(title); await expect(page.locator('#play')).toHaveText('Continue');
  await page.locator('#play').click();
  await expect.poll(normalizedBody).toBe(nextTitle); await expect(page.locator('#play')).toHaveText('Continue');
  // Even an exceptionally large heading is one fitted frame, not cut into groups.
  await open('long-title.md'); const imageCount = await page.evaluate(() => window.__images);
  await expect.poll(() => page.evaluate(() => window.__images)).toBeGreaterThan(imageCount);
  await expect(page.locator('#play')).toHaveText('Continue');
  await page.screenshot({ path: path.join(dir, 'long-title.png'), fullPage: true });
  await page.locator('#preview').screenshot({ path: path.join(dir, 'long-title-preview.png') });
  await enter('speed', 60);
  await page.locator('#play').click(); await expect.poll(normalizedBody).toBe('body'); await page.locator('#play').click();
  await enter('speed', 600);
  // Per-file formatting is independent of shared pace and title stops.
  await open('figures.pdf'); await page.locator('#start').click();
  await expect.poll(normalizedBody).toBe('Mixed columns and a full-width figure');
  await expect(page.locator('#play')).toHaveText('Continue');
  await showTool(page, 'pdf');
  await page.locator('#pdf-text-size').selectOption('28'); await expect(page.locator('#bookmark')).toBeEnabled();
  await page.locator('#pdf-save-defaults').click(); await expect(page.locator('#pdf-default-status')).toContainText('Defaults saved');
  await page.locator('#pdf-text-size').selectOption('24'); await expect(page.locator('#bookmark')).toBeEnabled();
  await page.locator('#file-picker').setInputFiles({ name: 'new-defaults.pdf', mimeType: 'application/pdf', buffer: pdfFixture() });
  await expect(page.locator('#doc-count')).toHaveText('6'); await open('new-defaults.pdf');
  await showTool(page, 'pdf'); await expect(page.locator('#pdf-text-size')).toHaveValue('28');
  await expect(page.locator('#speed-value')).toHaveText('600 wpm'); await expect(page.locator('#word-group-value')).toHaveText('1 word');
  await expect(page.locator('#play')).toHaveText('Continue');
  await showTool(page, 'settings'); await expect(page.locator('#pause-at-titles')).toBeChecked();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await page.waitForTimeout(600);
  await page.reload(); await expect(page.locator('#bookmark')).toBeEnabled({ timeout: 30000 });
  await expect(page.locator('#speed-value')).toHaveText('600 wpm'); await expect(page.locator('#word-group-value')).toHaveText('1 word');
  await showTool(page, 'settings'); await expect(page.locator('#pause-at-titles')).toBeChecked();
  await open('figures.pdf'); await showTool(page, 'pdf'); await expect(page.locator('#pdf-text-size')).toHaveValue('24');
  await page.locator('#pdf-reset-defaults').click(); await expect(page.locator('#bookmark')).toBeEnabled();
  await expect(page.locator('#pdf-text-size')).toHaveValue('28');
  await page.screenshot({ path: path.join(dir, 'pdf-defaults.png'), fullPage: true });
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `settings do not overflow at ${width}`);
  }
  assert.deepEqual(errors, []);
  Object.assign(result, { passed: true, readingTime: true, slowBridgeGroups: groups.length, persistence: true, shortDocument: true, pdfFigurePause: true, nativeText: true, wholeTitles: true, halfRateTitles: true, titlePause: true, oversizedTitle: true, sharedSettings: true, perPdfDefaults: true });
  console.log(JSON.stringify(result));
} catch (error) {
  result.error = error.stack; await page.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }); throw error;
} finally {
  await writeFile(path.join(dir, 'result.json'), JSON.stringify({ ...result, errors }, null, 2));
  await browser.close(); server.close();
}
