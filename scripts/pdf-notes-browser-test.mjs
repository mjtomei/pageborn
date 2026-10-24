import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';
import { waitForPdfReady, showLibrary, showTool, showDockOptions, chooseMode } from './ui-helpers.mjs';

const dir = path.resolve('test-results/pdf-notes'); await mkdir(dir, { recursive: true });
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

const body = () => page.evaluate(() => window.__body.trim());
const status = () => page.evaluate(() => window.__status);
const event = detail => page.evaluate(detail => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail })), detail);
const menu = () => event({ menuItemClickEvent: { itemID: 9 } });
const tap = () => event({ textEvent: { eventType: 0 } });
const swipe = direction => event({ textEvent: { eventType: direction > 0 ? 2 : 1 } });
const enter = async (kind, value) => {
  if (kind !== 'position') await showDockOptions(page); await page.locator(`#${kind}-value`).click(); await page.locator('#value-input').fill(String(value));
  await page.locator('#value-apply').click(); await expect(page.locator('#value-dialog')).toBeHidden();
};
const open = async name => {
  await showLibrary(page); await page.locator(`[data-document-id="${name}"] .document-card`).click();
  await waitForPdfReady(page, 30000);
};
const anchor = async () => {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  return page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('even-reader:preferences:v1')).positions));
};
const readyNotes = async () => {
  await expect(page.locator('#preview')).toHaveAttribute('aria-label', /^Footnotes:/);
  await expect.poll(status).toMatch(/^Footnotes · Swipe to read +Tap to return$/);
  await expect.poll(body).toMatch(/(?:FirstNote|SecondNote)/);
  await expect(page.locator('#play')).toHaveText('Back to reading');
};
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`); await expect(page.locator('#import')).toBeEnabled();
  await page.locator('#file-picker').setInputFiles([
    { name: 'annotations.pdf', mimeType: 'application/pdf', buffer: pdfFixture('annotations') },
    { name: 'plain.md', mimeType: 'text/markdown', buffer: Buffer.from('# Plain document\n\nA body without footnotes.\n\n' + 'More ordinary text. '.repeat(100)) },
  ]);
  await expect(page.locator('#doc-count')).toHaveText('2'); await open('annotations.pdf');
  await showTool(page, 'search');
  await page.locator('#search').fill('A sentence with reference');
  await expect(page.locator('#search-results button')).toHaveCount(1);
  await page.locator('#search-results button').click();
  await expect.poll(body).toMatch(/reference\s*\[1\]/);
  await page.screenshot({ path: path.join(dir, 'bracketed-reference.png'), fullPage: true });
  for (const query of ['FirstNote', 'SecondNote']) {
    await page.locator('#search').fill(query); await page.waitForTimeout(400);
    await expect(page.locator('#search-results button')).toHaveCount(0);
  }
  await page.locator('#search').fill('CaptionText'); await expect(page.locator('#search-results button')).toHaveCount(1);
  await page.locator('#tool-close').click();
  for (const mode of ['page', 'auto', 'speed']) {
    await chooseMode(page, mode);
    if (mode !== 'page') await enter('speed', mode === 'speed' ? 60 : 6);
    await enter('position', 15);
    if (mode === 'speed') { await enter('word-group', 1); await page.locator('#next').click(); }
    await expect.poll(status).toMatch(mode === 'page' ? /Pages/ : /Paused/);
    if (mode !== 'page') await tap();
    if (mode !== 'page') await expect(page.locator('#play')).toHaveText('Pause');
    await page.waitForTimeout(200);
    const original = { body: await body(), position: await page.locator('#position').inputValue(), anchor: await anchor(), rate: await page.locator('#speed-value').textContent() };
    await menu(); await readyNotes();
    await expect.poll(body).toMatch(/Footnote \[1\] — PDF page 1/);
    await page.screenshot({ path: path.join(dir, `${mode}-footnotes.png`), fullPage: true });
    await swipe(1); await swipe(-1); await page.waitForTimeout(500);
    assert.equal(await page.locator('#position').inputValue(), original.position, 'note swipes leave the body position intact');
    assert.equal(await page.locator('#speed-value').textContent(), original.rate, 'note swipes never change reading speed');
    assert.deepEqual(await anchor(), original.anchor, 'saving in notes preserves the exact main anchor/word cursor');
    if (mode === 'auto') await menu(); else await tap();
    await expect(page.locator('#preview')).not.toHaveAttribute('aria-label', /^Footnotes:/);
    await expect.poll(body).toBe(original.body);
    await expect(page.locator('#play')).toHaveText(mode === 'page' ? 'Next page' : mode === 'speed' ? 'Start speed reading' : 'Start autoscroll');
    await page.waitForTimeout(1200); assert.equal(await body(), original.body, 'return remains paused');
    assert.deepEqual(await anchor(), original.anchor);
    // The phone button and glasses Back use the same temporary view.
    await showTool(page, 'pdf'); await page.locator('#pdf-footnotes').click(); await readyNotes();
    await event({ sysEvent: { eventType: 3 } }); await expect.poll(body).toBe(original.body);
    await page.locator('#tool-close').click();
  }
  const saved = { body: await body(), position: await page.locator('#position').inputValue(), anchor: await anchor() };
  await menu(); await readyNotes(); await anchor(); await page.waitForTimeout(600);
  await page.reload(); await waitForPdfReady(page, 30000);
  await expect.poll(body).toBe(saved.body); assert.equal(await page.locator('#position').inputValue(), saved.position);
  assert.deepEqual(await anchor(), saved.anchor);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('even-reader:diagnostics:v1')).pdf.cached), true);
  // Later source pages open their own nearby labeled notes.
  await chooseMode(page, 'page'); await showTool(page, 'search');
  await page.locator('#search').fill('SecondSectionStart'); await expect(page.locator('#search-results button')).toHaveCount(1);
  await page.locator('#search-results button').click(); await page.locator('#tool-close').click();
  await menu(); await readyNotes(); await expect.poll(body).toMatch(/Footnote \[2\] — PDF page 2/);
  await page.locator('#play').click();
  // Exercise raster/body transitions and a slow outstanding display request.
  await showTool(page, 'search'); await page.locator('#search').fill('DiagramContent');
  await expect(page.locator('#search-results button')).toContainText('DiagramContent'); await page.locator('#search-results button').click();
  await page.locator('#tool-close').click(); await expect.poll(() => page.evaluate(() => window.__images)).toBeGreaterThan(0);
  const imagePosition = await page.locator('#position').inputValue();
  await page.evaluate(() => { window.__delay = 180; });
  await menu(); await readyNotes(); await tap(); await expect.poll(body).toBe('');
  assert.equal(await page.locator('#position').inputValue(), imagePosition);
  await menu(); await tap(); await menu(); await tap(); await page.waitForTimeout(2000);
  await expect.poll(body).toBe(''); await expect.poll(status).toMatch(/Pages/);
  await page.evaluate(() => { window.__delay = 5; });
  await menu(); await readyNotes(); await open('plain.md');
  await expect.poll(body).toMatch(/Plain document/); const plain = await body();
  await menu(); await expect.poll(body).toContain('No recognized footnotes');
  await tap(); await expect.poll(body).toBe(plain);
  assert.deepEqual(errors, []);
  Object.assign(result, { passed: true, bracketedReferences: true, separateNotes: true, captionsKept: true, nearbySourcePage: true,
    exactReturnAllModes: true, pausedReturn: true, notesDoNotChangePace: true, cacheRestore: true, imageTransitions: true, noNotesMessage: true });
  console.log(JSON.stringify(result));
} catch (error) {
  result.error = error.stack; await page.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }); throw error;
} finally {
  await writeFile(path.join(dir, 'result.json'), JSON.stringify({ ...result, errors }, null, 2));
  await browser.close(); server.close();
}
