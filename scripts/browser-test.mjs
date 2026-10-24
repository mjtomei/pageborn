import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, access, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { AtomicPhoneValue } from '../src/phone-storage.js';
import { runTableStressBrowser } from './table-stress.mjs';
import { speedToSlider } from '../src/reader.js';
import { showLibrary, showTool, showDockOptions, showSettings, hideSettings } from './ui-helpers.mjs';

const dir = await mkdtemp(path.join(os.tmpdir(), 'even-reader-browser-'));
const content = '# A field guide\n\nAn introduction to reading at your own pace.\n\n' + Array.from({ length: 18 }, (_, i) =>
  `## Chapter ${i + 1}\n\n${('A long paragraph with room for thought. ').repeat(35)} Unique-${i + 1} finishes this passage.\n\n- A useful observation\n- Something to remember\n\n`).join('');
const app = createApp({ distDir: path.resolve(process.env.READER_TEST_DIST || 'dist') });
const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const cache = path.join(os.homedir(), '.cache/ms-playwright');
const cached = (await readdir(cache).catch(() => [])).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
const candidates = [process.env.CHROME_PATH, chromium.executablePath(), ...cached.flatMap(name =>
  [path.join(cache, name, 'chrome-linux/chrome'), path.join(cache, name, 'chrome-linux64/chrome')]), '/usr/bin/google-chrome'].filter(Boolean);
const executablePath = (await Promise.all(candidates.map(async file => { try { await access(file); return file; } catch { return null; } }))).find(Boolean);
const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
const errors = []; const networkCalls = [];
const observe = context => context.on('request', request => { if (['fetch', 'xhr'].includes(request.resourceType())) networkCalls.push(request.url()); });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 1 });
observe(context);
const phoneData = new Map();
async function installBridge(target, values = phoneData) {
await target.exposeFunction('__phoneStorage', message => {
  if (message.method === 'getLocalStorage') return values.get(message.data.key) || '';
  values.set(message.data.key, message.data.value); return true;
});
await target.addInitScript(() => {
  window.__bridgeCalls = []; window.__inflight = 0; window.__maxInflight = 0; window.__failText = false;
  window.__storedBody = ''; window.__textDelay = 25;
  window.flutter_inappwebview = { async callHandler(_name, serialized) {
    const message = JSON.parse(serialized); window.__bridgeCalls.push(message);
    window.__inflight++; window.__maxInflight = Math.max(window.__maxInflight, window.__inflight);
    try {
      await new Promise(r => setTimeout(r, message.method.endsWith('LocalStorage') ? 2 : window.__textDelay));
      if (message.method.endsWith('LocalStorage')) {
        if (message.method === 'setLocalStorage' && window.__failStorage) return false;
        return await window.__phoneStorage(message);
      }
      if (['createStartUpPageContainer', 'rebuildPageContainer'].includes(message.method)) {
        window.__storedBody = message.data.textObject.find(t => t.containerName === 'body')?.content || '';
        return message.method === 'createStartUpPageContainer' ? 0 : true;
      }
      if (message.method === 'textContainerUpgrade') {
        if (new TextEncoder().encode(message.data.content).length >= 1000) return false;
        if (window.__failText) return false;
        if (message.data.containerName === 'body') {
          if (message.data.contentOffset != null) throw new Error('Unexpected partial update');
          window.__storedBody = message.data.content;
        }
        return true;
      }
      if (message.method === 'updateImageRawData') throw new Error('Image payload in native text mode');
      return true;
    } finally { window.__inflight--; }
  } };
});
}
await installBridge(context);
const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
const until = (condition, argument) => page.waitForFunction(condition, argument, { timeout: 12000 });
const event = detail => page.evaluate(detail => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail })), detail);
const storedSnapshot = () => page.evaluate(() => new Promise((resolve, reject) => {
  const open = indexedDB.open('even-reader', 1);
  open.onsuccess = () => { const db = open.result; const req = db.transaction('data').objectStore('data').get('snapshot'); req.onsuccess = () => { resolve(req.result); db.close(); }; req.onerror = () => reject(req.error); };
}));
const click = async id => { if (['import', 'clear-imports'].includes(id)) await showLibrary(page); if (/^(mode-|speed|word-group)/.test(id)) await showDockOptions(page); return page.locator(`#${id}`).click(); };
const setTextSize = async size => { await showSettings(page); await page.locator('#font-size').selectOption(size); await hideSettings(page); };
const percent = async () => Number((await page.locator('#position-value').innerText()).replace('%', ''));
const savedPhonePreferences = new AtomicPhoneValue({ get: async key => phoneData.get(key) || '' }, 'preferences');
const flushPhone = async () => {
  const expected = await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    return JSON.parse(localStorage.getItem('even-reader:preferences:v1'));
  });
  await expect.poll(() => savedPhonePreferences.read(), { timeout: 12000 }).toEqual(expected);
};
const reopen = async () => { await flushPhone(); await page.reload(); };
const changeRange = async (id, value) => page.locator(`#${id}`).evaluate((el, value) => { el.value = value; el.dispatchEvent(new Event('input')); }, String(id === 'speed' ? speedToSlider(value) : value));
try {
  await page.goto(base);
  await until(() => !document.querySelector('#import').disabled);
  assert.equal(await page.locator('#doc-count').textContent(), '0');
  await until(() => window.__storedBody.startsWith('No saved documents.'));
  assert.equal(await page.locator('#sync, #settings, #server, #token, #debug-send, #test-start').count(), 0);
  const chooser = page.waitForEvent('filechooser'); await click('import');
  await (await chooser).setFiles([
    { name: 'guide.md', mimeType: 'text/markdown', buffer: Buffer.from(content) },
    { name: 'weekend.md', mimeType: 'text/markdown', buffer: Buffer.from('# Weekend notes\n\nA quieter kind of weekend.\n\n## Walk\nFollow the river.') },
  ]);
  await until(() => document.querySelector('#doc-count').textContent === '2');
  assert.equal(await page.locator('#title').textContent(), 'Choose something good.', 'imports do not open or format a document automatically');
  await until(() => window.__storedBody.startsWith('Choose document') && window.__storedBody.includes('A field guide') && window.__storedBody.includes('Weekend notes'));
  assert.doesNotMatch(await page.evaluate(() => window.__storedBody), /Back to reading/);
  await reopen();
  await until(() => window.__storedBody.startsWith('Choose document'));
  assert.equal(await page.locator('#title').textContent(), 'Choose something good.', 'no selection stays at the library after reopening');
  if (!await page.evaluate(() => window.__storedBody.includes('> A field guide'))) await event({ textEvent: { eventType: 2 } });
  await until(() => window.__storedBody.includes('> A field guide'));
  await event({ textEvent: {} });
  await until(() => document.querySelector('#title').textContent === 'A field guide');
  await until(() => window.__bridgeCalls.filter(c => c.method === 'textContainerUpgrade').length >= 2);
  assert.equal(await page.locator('#title').textContent(), 'A field guide');
  assert.equal(new URL(page.url()).hash, '');
  const startup = await page.evaluate(() => window.__bridgeCalls.find(c => c.method === 'createStartUpPageContainer'));
  console.log('SDK startup payload:', JSON.stringify(startup).slice(0, 1200));
  assert.equal(await page.locator('#mode-page').getAttribute('aria-pressed'), 'true', 'new readers start in page mode');
  assert.equal(await page.locator('#page-overlap').count(), 0);
  await click('mode-auto');
  assert.equal(await page.locator('#overlap-control').count(), 0);
  const before = await page.locator('#position').inputValue();
  await event({ textEvent: { eventType: 1 } });
  await until(() => parseInt(document.querySelector('#speed-value').textContent) === 36);
  await event({ textEvent: { eventType: 2 } });
  await until(() => parseInt(document.querySelector('#speed-value').textContent) === 30);
  assert.equal(await page.locator('#position').inputValue(), before, 'paused swipes adjust speed without moving');
  assert.equal(await page.locator('#play').textContent(), 'Start autoscroll');
  assert.equal(startup.data.textObject.some(t => t.containerName === 'title'), false);
  assert.equal(startup.data.textObject.find(t => t.containerName === 'body').yPosition, 0);
  const openPosition = async () => {
    await event({ sysEvent: { eventType: 4 } });
    await event({ menuItemClickEvent: { itemID: 8 } });
    await event({ sysEvent: { eventType: 5 } });
    await until(() => window.__storedBody.startsWith('Go to position'));
  };
  await changeRange('position', 375); await click('play');
  await openPosition();
  await until(() => window.__storedBody.includes('37.5% of document'));
  await event({ textEvent: { eventType: 2 } });
  await until(() => window.__storedBody.includes('40% of document'));
  assert.equal(await percent(), 37.5, 'selector previews a candidate before committing');
  assert.equal(await page.locator('#speed-value').textContent(), '30 l/min', 'selector swipes do not adjust autoscroll speed');
  await event({ textEvent: { eventType: 1 } });
  await until(() => window.__storedBody.includes('35% of document'));
  await event({ textEvent: {} });
  await until(() => !window.__storedBody.startsWith('Go to position'));
  assert.equal(await percent(), 35); assert.equal(await page.locator('#play').textContent(), 'Start autoscroll');
  await expect(page.locator('#passage-current')).toHaveAttribute('aria-pressed', 'true');
  await openPosition(); await event({ textEvent: { eventType: 2 } });
  await event({ sysEvent: { eventType: 4 } }); await event({ menuItemClickEvent: { itemID: 8 } }); await event({ sysEvent: { eventType: 5 } });
  await until(() => !window.__storedBody.startsWith('Go to position'));
  assert.equal(await percent(), 35, 'reselecting the menu action cancels without changing the saved place');
  for (const [start, direction, end] of [[950, 2, 100], [50, 1, 0]]) {
    await changeRange('position', start); await openPosition();
    await event({ textEvent: { eventType: direction } }); await event({ textEvent: { eventType: direction } });
    await until(p => window.__storedBody.includes(`${p}% of document`), end);
    await event({ textEvent: {} }); await until(p => document.querySelector('#position-value').textContent === `${p}%`, end);
  }
  await openPosition(); await changeRange('position', 250);
  await until(() => !window.__storedBody.startsWith('Go to position'));
  assert.equal(await percent(), 25, 'phone navigation dismisses the position selector');
  await openPosition(); await event({ textEvent: { eventType: 2 } });
  await event({ textEvent: { eventType: 3 } });
  await until(() => !window.__storedBody.startsWith('Go to position'));
  assert.equal(await percent(), 25, 'Back cancels a position preview without leaving the document');
  // The actual SDK event path opens a saved document and restores its position.
  const openDocuments = async () => {
    await event({ sysEvent: { eventType: 4 } });
    await event({ menuItemClickEvent: { itemID: 7 } });
    await event({ sysEvent: { eventType: 5 } });
    await until(() => window.__storedBody.startsWith('Choose document'));
  };
  await changeRange('position', 500);
  const guideFirst = (await storedSnapshot()).documents[0].id === 'guide.md';
  await openDocuments();
  const pickerSpeed = await page.locator('#speed').inputValue();
  await event({ textEvent: { eventType: guideFirst ? 2 : 1 } });
  await until(() => window.__storedBody.includes('> Weekend notes'));
  assert.equal(await page.locator('#speed').inputValue(), pickerSpeed, 'picker swipes do not change autoscroll speed');
  await event({ textEvent: {} });
  await until(() => document.querySelector('#title').textContent === 'Weekend notes' && !window.__storedBody.startsWith('Choose document'));
  assert.equal(await page.locator('#play').textContent(), 'Start autoscroll', 'opening a document leaves playback paused');
  await openDocuments(); await event({ textEvent: { eventType: guideFirst ? 1 : 2 } });
  await until(() => window.__storedBody.includes('> A field guide'));
  await event({ textEvent: {} });
  await until(() => document.querySelector('#title').textContent === 'A field guide' && document.querySelector('#position-value').textContent === '50%');
  await openDocuments(); await event({ textEvent: { eventType: guideFirst ? 1 : 2 } });
  await until(() => window.__storedBody.includes('> Back to reading'));
  await event({ textEvent: {} });
  await until(() => !window.__storedBody.startsWith('Choose document'));
  assert.equal(await percent(), 50, 'Back preserves position');
  await openDocuments(); await event({ textEvent: { eventType: 3 } });
  await until(() => !window.__storedBody.startsWith('Choose document'));
  assert.equal(await percent(), 50, 'Back cancels the menu document picker');
  await openDocuments(); await changeRange('position', 250);
  await until(() => !window.__storedBody.startsWith('Choose document'));
  assert.equal(await percent(), 25, 'phone navigation dismisses the picker');
  await changeRange('speed', 200);
  assert.equal(await page.locator('#speed').inputValue(), String(speedToSlider(200)), 'phone slider reaches exactly 200');
  await event({ textEvent: { eventType: 1 } });
  await until(() => window.__bridgeCalls.filter(c => c.method === 'textContainerUpgrade' && c.data.containerName === 'status').at(-1)?.data.content.includes('200 l/min'));
  const footer = await page.evaluate(() => window.__bridgeCalls.filter(c => c.method === 'textContainerUpgrade' && c.data.containerName === 'status').at(-1).data.content);
  assert.match(footer, /~\d+[ms] left/);
  await changeRange('speed', 30);
  await showTool(page, 'outline'); await page.locator('#outline button').filter({ hasText: 'Chapter 12' }).click();
  await until(() => Number(document.querySelector('#position-value').textContent.replace('%', '')) > 50);
  await click('tab-search'); await page.locator('#search').fill('Unique-15');
  await page.locator('#search-results button').first().click();
  await until(() => document.querySelector('#passage').textContent.includes('Unique-15'));
  const searchPercent = await percent(); assert.ok(searchPercent > 70);
  await showTool(page, 'bookmarks'); await click('bookmark'); assert.equal(await page.locator('#bookmarks .bookmark-row').count(), 1);
  await click('start'); await page.locator('#bookmarks .nav-item').click();
  await until(p => document.querySelector('#position-value').textContent === `${p}%`, searchPercent);
  await changeRange('position', 400); await until(() => document.querySelector('#position-value').textContent === '40%');
  await until(() => !window.__inflight && window.__bridgeCalls.filter(c => c.method === 'textContainerUpgrade' && c.data.containerName === 'status').at(-1)?.data.content.includes('  40%'));
  await page.evaluate(() => {
    const position = document.querySelector('#position'); position.value = '700'; position.dispatchEvent(new Event('input'));
    window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { textEvent: { eventType: 1 } } }));
  });
  assert.equal(await page.locator('#position').inputValue(), '700', 'a stale boundary event must not undo a phone jump before its render tick');
  await changeRange('position', 400);
  await click('mode-page');
  const pageLayout = startup.data;
  assert.equal(pageLayout.textObject.find(t => t.containerName === 'body').isEventCapture, 0, 'page body must not scroll or bounce');
  assert.equal(pageLayout.textObject.filter(t => t.isEventCapture === 1).length, 1);
  assert.equal(await page.locator('#overlap-control, #page-overlap').count(), 0);
  const rebuilds = await page.evaluate(() => window.__bridgeCalls.filter(c => c.method === 'rebuildPageContainer').length);
  await click('mode-auto'); await changeRange('speed', 200); await click('play');
  const initialRange = await page.locator('#position').inputValue();
  await until(value => Number(document.querySelector('#position').value) > Number(value), initialRange);
  assert.equal(await page.evaluate(() => window.__bridgeCalls.filter(c => c.method === 'rebuildPageContainer').length), rebuilds, 'page turns update text without rebuilding');
  await event({ sysEvent: { eventType: 4 } });
  await until(() => document.querySelector('#play').textContent === 'Start autoscroll');
  await event({ sysEvent: { eventType: 5 } });
  await click('mode-page');
  await changeRange('position', 620); await until(() => document.querySelector('#position-value').textContent === '62%');
  // Wait for eager position persistence, then restore after a cold WebView start.
  await until(() => Object.values(JSON.parse(localStorage.getItem('even-reader:preferences:v1')).positions).some(p => Math.round(p.percent) === 62));
  await reopen(); await until(() => document.querySelector('#position-value').textContent === '62%');
  assert.equal(await page.locator('#page-overlap').count(), 0, 'overlap control stays removed after a cold start');
  assert.equal(await page.locator('#mode-page').getAttribute('aria-pressed'), 'true');
  await context.setOffline(true);
  const offlineStart = await percent();
  await click('mode-page'); await click('next');
  await until(p => Number(document.querySelector('#position-value').textContent.replace('%', '')) > p, offlineStart);
  await context.setOffline(false);
  const beforeBack = await percent();
  await event({ sysEvent: { eventType: 3 } });
  await until(() => window.__storedBody.startsWith('Choose document') && document.querySelector('#title').textContent === 'Choose something good.');
  assert.doesNotMatch(await page.evaluate(() => window.__storedBody), /Back to reading/);
  assert.equal(await page.evaluate(() => window.__bridgeCalls.some(c => c.method === 'shutDownPageContainer')), false, 'Back from a document does not exit');
  await reopen();
  await until(() => window.__storedBody.startsWith('Choose document'));
  assert.equal(await page.locator('#title').textContent(), 'Choose something good.');
  await event({ sysEvent: { eventType: 3 } });
  await until(() => window.__bridgeCalls.some(c => c.method === 'shutDownPageContainer'));
  await event({ sysEvent: { eventType: 5 } });
  await until(() => window.__storedBody.startsWith('Choose document'));
  if (!await page.evaluate(() => window.__storedBody.includes('> A field guide'))) await event({ textEvent: { eventType: 2 } });
  await until(() => window.__storedBody.includes('> A field guide'));
  await event({ textEvent: {} });
  await until(() => document.querySelector('#title').textContent === 'A field guide');
  assert.equal(await percent(), beforeBack, 'reopening from the library restores the reading position');
  await page.evaluate(() => { window.__failText = true; }); await click('next');
  await until(() => document.querySelector('#connection').textContent.includes('Display paused:'));
  await page.evaluate(() => { window.__failText = false; }); await click('reconnect');
  await until(() => document.querySelector('#connection').textContent === 'Native text connected');
  // A slow host must render every automatic line instead of skipping ahead.
  await page.locator('#file-picker').setInputFiles({ name: 'auto.md', mimeType: 'text/markdown', buffer: Buffer.from('# Autoscroll check\n\n```\n' + Array.from({ length: 240 }, (_, i) => `Line ${String(i).padStart(3, '0')}: reading`).join('\n') + '\n```') });
  await showLibrary(page); await page.locator('[data-document-id="auto.md"] .document-card').click();
  await until(() => document.querySelector('#title').textContent === 'Autoscroll check' && !document.querySelector('#import').disabled);
  await click('mode-auto'); await changeRange('speed', 200); await click('start');
  await until(() => !window.__inflight && window.__storedBody.startsWith('Autoscroll check'));
  const callStart = await page.evaluate(() => window.__bridgeCalls.length);
  await page.evaluate(() => { window.__textDelay = 900; });
  await event({ sysEvent: {} });
  await until(() => document.querySelector('#play').textContent === 'Pause');
  await page.waitForTimeout(7200);
  await event({ sysEvent: {} });
  await until(() => document.querySelector('#play').textContent === 'Start autoscroll');
  await until(() => !window.__inflight);
  const bodies = await page.evaluate(start => window.__bridgeCalls.slice(start)
    .filter(c => c.method === 'textContainerUpgrade' && c.data.containerName === 'body').map(c => c.data.content.split('\n')), callStart);
  assert.ok(bodies.length >= 2, 'slow-host test must advance multiple lines');
  for (let i = 1; i < bodies.length; i++) assert.deepEqual(bodies[i].slice(0, -1), bodies[i - 1].slice(1), 'slow-host updates advance exactly one row');
  await page.evaluate(() => { window.__textDelay = 25; });
  await changeRange('position', 500);
  await until(() => document.querySelector('#position-value').textContent === '50%');
  const jumpLine = await page.locator('#passage button[aria-current=true]').getAttribute('aria-label');
  await page.waitForTimeout(700);
  assert.equal(await page.locator('#passage button[aria-current=true]').getAttribute('aria-label'), jumpLine, 'phone jump pauses playback');
  await click('play');
  await until(line => document.querySelector('#passage button[aria-current=true]')?.getAttribute('aria-label') !== line, jumpLine);
  await changeRange('position', 1000);
  await until(() => document.querySelector('#play').disabled);
  assert.equal(await page.locator('#play').isDisabled(), true);
  await changeRange('position', 999); await click('play');
  await until(() => document.querySelector('#position').value === '1000' && document.querySelector('#play').disabled);
  await flushPhone();
  // Apply stale cache values on the next launch, after the previous page's
  // pagehide handler has flushed its actual preferences.
  await page.addInitScript(() => {
    const stale = sessionStorage.getItem('test-stale-preferences');
    if (stale) localStorage.setItem('even-reader:preferences:v1', stale);
    sessionStorage.removeItem('test-stale-preferences');
  });
  await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('even-reader:preferences:v1'));
    p.mode = 'page'; p.autoSpeed = 6; p.preloadText = true; p.speed = 3;
    sessionStorage.setItem('test-stale-preferences', JSON.stringify(p));
  });
  await page.reload();
  await until(() => document.querySelector('#mode-auto').getAttribute('aria-pressed') === 'true');
  assert.equal(await page.locator('#play').textContent(), 'Start autoscroll', 'phone preferences take precedence over stale browser settings and reopen paused');
  assert.equal(await page.locator('#speed').inputValue(), String(speedToSlider(200)));
  assert.equal(await page.locator('#mode-native, #preload-controls').count(), 0);
  await click('start');
  await until(() => document.querySelector('#passage button[aria-current=true]')?.getAttribute('aria-label') === 'Autoscroll check' && document.querySelector('#position-value').textContent === '0%');
  // Full-document browsing remains independent from the glasses until a line is selected.
  const pane = page.locator('#passage');
  assert.equal(await page.locator('#shared-settings #font-size').count(), 1);
  assert.equal(await page.locator('#reader-controls #font-size').count(), 0);
  const longFile = { name: 'phone.md', mimeType: 'text/markdown', buffer: Buffer.from('# From my phone\n\n```\n' + Array.from({ length: 5000 }, (_, i) => `Phone line ${String(i).padStart(4, '0')}: café and reading`).join('\n') + '\n```') };
  const picker = page.waitForEvent('filechooser'); await click('import');
  await (await picker).setFiles(longFile);
  await showLibrary(page); await page.locator('[data-document-id="phone.md"] .document-card').click();
  await until(() => document.querySelector('#title').textContent === 'From my phone' && !document.querySelector('#import').disabled);
  assert.ok((await page.locator('#import-status').textContent()).includes('added'));
  await click('mode-page'); await click('start');
  await until(() => document.querySelector('#passage button[aria-current=true]')?.getAttribute('aria-label') === 'From my phone');
  assert.ok(await pane.evaluate(el => el.scrollHeight > el.clientHeight * 100), 'scrollbar spans the full document');
  assert.ok(await pane.locator('button').count() < 100, 'long document keeps DOM bounded');
  const beforeBrowse = await page.locator('#position').inputValue();
  await pane.evaluate(el => { el.dispatchEvent(new Event('wheel')); el.scrollTop = el.scrollHeight; });
  await until(() => Array.from(document.querySelectorAll('#passage button')).some(el => el.getAttribute('aria-label')?.includes('Phone line 4999')));
  assert.equal(await page.locator('#position').inputValue(), beforeBrowse, 'browsing does not move glasses');
  await page.locator('#passage button[aria-label^="Phone line 4999"]').click();
  await until(() => document.querySelector('#position-value').textContent === '100%');
  await click('start');
  await until(() => document.querySelector('#position-value').textContent === '0%');
  assert.ok(await pane.evaluate(el => el.scrollTop > el.scrollHeight / 2), 'manual browsing survives a glasses position change');
  await click('passage-current');
  await until(() => document.querySelector('#passage').scrollTop === 0);
  await until(() => !window.__inflight);
  const bodiesBeforeFont = await page.evaluate(() => window.__bridgeCalls.filter(c => c.method === 'textContainerUpgrade' && c.data.containerName === 'body').length);
  await setTextSize('26');
  await page.waitForTimeout(200);
  assert.equal(await pane.locator('button').first().evaluate(el => getComputedStyle(el).fontSize), '16.8px');
  assert.equal(await page.evaluate(() => window.__bridgeCalls.filter(c => c.method === 'textContainerUpgrade' && c.data.containerName === 'body').length), bodiesBeforeFont, 'phone text size does not change glasses');
  assert.equal(await pane.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'wrapped text fits the pane');
  await pane.evaluate(el => { el.dispatchEvent(new Event('wheel')); el.scrollTop = el.scrollHeight / 2; });
  await page.waitForTimeout(100);
  const middle = await pane.locator('button').first().getAttribute('data-row');
  await page.setViewportSize({ width: 430, height: 844 });
  await page.waitForTimeout(200);
  assert.ok(Math.abs(Number(await pane.locator('button').first().getAttribute('data-row')) - Number(middle)) < 15, 'resize preserves the browsed location');
  await page.locator('#file-picker').setInputFiles({ name: 'phone.md', mimeType: 'text/markdown', buffer: Buffer.from('# Another phone file\nKept alongside the first.') });
  await until(() => document.querySelector('#import-jobs').textContent.includes('Added as phone (2).md'));
  const savedDuplicate = await storedSnapshot();
  assert.equal(savedDuplicate.documents.find(doc => doc.id === 'phone.md').content, longFile.buffer.toString());
  assert.equal(savedDuplicate.documents.find(doc => doc.id === 'phone (2).md').content, '# Another phone file\nKept alongside the first.');
  await page.locator('#file-picker').setInputFiles([
    { name: 'good.txt', mimeType: 'text/plain', buffer: Buffer.from('A valid local note') },
    { name: 'bad.md', mimeType: 'text/markdown', buffer: Buffer.from([255, 0]) },
    { name: 'bad.pdf', mimeType: 'application/pdf', buffer: Buffer.from('Not Markdown') },
  ]);
  await until(() => document.querySelector('#imports').dataset.pending === '0');
  assert.match(await page.locator('#import-jobs').textContent(), /UTF-8/);
  assert.ok((await storedSnapshot()).documents.some(doc => doc.id === 'good.txt'));
  assert.ok(!(await storedSnapshot()).documents.some(doc => doc.id === 'bad.md'));
  // Failed native commits must not appear as successful additions or deletions.
  await page.evaluate(() => { window.__failStorage = true; });
  await page.locator('#file-picker').setInputFiles({ name: 'full.md', mimeType: 'text/markdown', buffer: Buffer.from('Cannot save') });
  await until(() => document.querySelector('#import-jobs').textContent.includes('Could not save to phone storage'));
  assert.ok(!(await storedSnapshot()).documents.some(doc => doc.id === 'full.md'));
  await showLibrary(page); await page.getByRole('button', { name: 'Delete good.txt', exact: true }).click();
  await showLibrary(page); await page.locator('[data-confirm-delete="good.txt"]').click();
  await until(() => document.querySelector('#notice').textContent.includes('Could not delete'));
  assert.ok((await storedSnapshot()).documents.some(doc => doc.id === 'good.txt'));
  await page.evaluate(() => { window.__failStorage = false; });
  await showLibrary(page); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  // Imports and deletions work while completely offline.
  await context.setOffline(true);
  await page.locator('#file-picker').setInputFiles({ name: 'offline.md', mimeType: 'text/markdown', buffer: Buffer.from('# Offline file') });
  await showLibrary(page); await page.locator('[data-document-id="offline.md"] .document-card').click();
  await until(() => document.querySelector('#title').textContent === 'Offline file' && !document.querySelector('#import').disabled);
  await showLibrary(page); await page.getByRole('button', { name: 'Delete offline.md', exact: true }).click();
  await showLibrary(page); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.locator('#title').textContent(), 'Offline file');
  await showLibrary(page); await page.getByRole('button', { name: 'Delete offline.md', exact: true }).click();
  await showLibrary(page); await page.locator('[data-confirm-delete="offline.md"]').click();
  await until(() => !document.querySelector('#import').disabled && document.querySelector('#title').textContent !== 'Offline file');
  assert.ok(!(await storedSnapshot()).documents.some(doc => doc.id === 'offline.md'));
  await context.setOffline(false);
  await showLibrary(page); await page.locator('#documents button').filter({ hasText: 'From my phone' }).click();
  await click('passage-current');
  await reopen();
  await until(() => document.querySelector('#title').textContent === 'From my phone');
  assert.equal(await page.locator('#font-size').inputValue(), '26');
  await page.setViewportSize({ width: 390, height: 844 });
  await until(() => document.querySelector('#passage button[aria-current=true]')?.getAttribute('aria-label') === 'From my phone');
  assert.equal(await page.evaluate(() => window.__maxInflight), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  await mkdir('test-results', { recursive: true });
  await pane.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/phone-passage.png' });
  await page.screenshot({ path: 'test-results/phone.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1000 }); await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
  // Table cells use the same real import, selection, search and bookmark flows.
  await page.locator('#file-picker').setInputFiles({ name: 'tables.md', mimeType: 'text/markdown', buffer: await readFile(new URL('../test/fixtures/tables.md', import.meta.url)) });
  await showLibrary(page); await page.locator('[data-document-id="tables.md"] .document-card').click();
  await until(() => document.querySelector('#title').textContent === 'Table reading test' && !document.querySelector('#import').disabled);
  assert.equal(await page.locator('#outline button').count(), 2, 'table captions do not pollute the outline');
  await click('mode-page'); await setTextSize('12');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#passage .table-row-start').first().click();
  await until(() => window.__storedBody.startsWith('[1/3] Feature: Pages\n  Status: Ready\n  Notes:'));
  await pane.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/phone-tables.png' });
  await click('tab-search'); await page.locator('#search').fill('Pause with a tap.');
  await page.locator('#search-results button').first().click();
  await click('passage-current');
  await until(() => document.querySelector('#passage button[aria-current=true]')?.getAttribute('aria-label') === '    Pause with a tap.' && window.__storedBody.startsWith('    Pause with a tap.'));
  await showTool(page, 'bookmarks'); await click('bookmark'); await click('start');
  await page.locator('#bookmarks .nav-item').click();
  await until(() => document.querySelector('#passage button[aria-current=true]')?.getAttribute('aria-label') === '    Pause with a tap.');
  await reopen();
  await until(() => document.querySelector('#title').textContent === 'Table reading test' && window.__storedBody.startsWith('    Pause with a tap.'));
  await click('start'); await click('passage-current');
  for (const width of [360, 430]) {
    await page.setViewportSize({ width, height: 844 });
    for (const size of ['12', '22', '26']) {
      await setTextSize(size);
      await page.waitForTimeout(100);
      assert.ok(await pane.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `table fits ${width}px phone at ${size}px font`);
      assert.ok(await pane.locator('button').evaluateAll(buttons => buttons.every(el => el.scrollHeight <= el.clientHeight + 1)), 'virtualized rows contain their wrapped text');
    }
  }
  console.log('PASS: table imports, native labeled records, cell search, bookmarks, reload and small-phone wrapping.');
  await runTableStressBrowser({ page, until, click, event, reopen });
  // Hold two real worker requests to model slow file providers deterministically.
  // Releasing them runs the actual chunked decoding, metadata and IDB save paths.
  if (await page.locator('#clear-imports').isVisible()) await click('clear-imports');
  await showLibrary(page); await page.locator('[data-document-id="auto.md"] .document-card').click();
  await click('start'); await click('mode-auto'); await changeRange('speed', 200); await click('play');
  await page.evaluate(() => {
    const NativeWorker = window.Worker;
    window.__heldReads = new Map(); window.__workerProgress = []; window.__originalWorker = NativeWorker;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', ({ data }) => {
          if (data.type === 'progress') window.__workerProgress.push({ file: this.fileName, ...data });
        });
      }
      postMessage(file) {
        this.fileName = file.name;
        if (file.name.startsWith('slow-')) window.__heldReads.set(file.name, () => { NativeWorker.prototype.postMessage.call(this, file); window.__heldReads.delete(file.name); });
        else super.postMessage(file);
      }
    };
  });
  const largeContent = '# Large background import\n\n' + 'Words for a large file, added while reading. '.repeat(85000);
  await page.locator('#file-picker').setInputFiles([
    { name: 'slow-large.md', mimeType: 'text/markdown', buffer: Buffer.from(largeContent) },
    { name: 'quick.md', mimeType: 'text/markdown', buffer: Buffer.from('# Quick background file') },
  ]);
  const job = name => page.locator('.import-job').filter({ has: page.locator('strong', { hasText: name }) });
  await until(() => document.querySelector('[data-document-id="quick.md"]') && document.querySelector('#imports').dataset.pending === '1');
  assert.equal(await job('slow-large.md').getAttribute('data-phase'), 'reading');
  assert.equal(await job('quick.md').getAttribute('data-phase'), 'done');
  assert.equal(await page.locator('#title').textContent(), 'Autoscroll check');
  assert.equal(await page.locator('#play').textContent(), 'Pause', 'imports do not pause playback');
  const readingPosition = await page.locator('#position').inputValue();
  await until(value => Number(document.querySelector('#position').value) > Number(value), readingPosition);
  assert.equal(await page.locator('#import').isEnabled(), true);
  await showLibrary(page); await page.getByRole('button', { name: 'Open imported quick.md', exact: true }).click();
  assert.equal(await page.locator('#title').textContent(), 'Quick background file', 'completed files can be opened while other imports are pending');
  await showLibrary(page); await page.locator('[data-document-id="auto.md"] .document-card').click(); await click('play');
  const moreFiles = page.waitForEvent('filechooser'); await click('import');
  await (await moreFiles).setFiles([
    { name: 'slow-second.md', mimeType: 'text/markdown', buffer: Buffer.from('# Second background import') },
    { name: 'queued.md', mimeType: 'text/markdown', buffer: Buffer.from('# Queued background import') },
    { name: 'invalid.pdf', mimeType: 'application/pdf', buffer: Buffer.from('Invalid file') },
  ]);
  await until(() => document.querySelector('#imports').dataset.pending === '4');
  assert.equal(await job('queued.md').getAttribute('data-phase'), 'queued');
  assert.equal(await job('slow-large.md').locator('progress').getAttribute('value'), '0');
  await page.setViewportSize({ width: 390, height: 844 });
  await showLibrary(page); await page.locator('#imports').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/phone-imports.png' });
  await showLibrary(page); await page.getByRole('button', { name: 'Delete quick.md', exact: true }).click();
  await showLibrary(page); await page.locator('[data-confirm-delete="quick.md"]').click();
  await until(() => !document.querySelector('[data-document-id="quick.md"]'));
  await click('play'); // Deletion intentionally pauses playback; resume the ongoing import check.
  await click('clear-imports');
  assert.equal(await job('quick.md').count(), 0);
  assert.equal(await job('slow-large.md').count(), 1, 'clearing finished jobs keeps active imports');
  await page.evaluate(() => window.__heldReads.get('slow-second.md')());
  await until(() => document.querySelector('#imports').dataset.pending === '1');
  assert.equal(await job('queued.md').getAttribute('data-phase'), 'done', 'later files can finish before a slow earlier file');
  assert.equal(await job('invalid.pdf').getAttribute('data-phase'), 'failed');
  await page.locator('#file-picker').setInputFiles([
    { name: 'parallel.md', mimeType: 'text/markdown', buffer: Buffer.from('# Parallel A') },
    { name: 'parallel.md', mimeType: 'text/markdown', buffer: Buffer.from('# Parallel B') },
  ]);
  await until(() => document.querySelector('[data-document-id="parallel (2).md"]'));
  await page.evaluate(() => window.__heldReads.get('slow-large.md')());
  await until(() => document.querySelector('#imports').dataset.pending === '0');
  assert.equal(await job('slow-large.md').getAttribute('data-phase'), 'done');
  const backgroundSaved = (await storedSnapshot()).documents;
  assert.equal(backgroundSaved.find(doc => doc.id === 'slow-large.md').content, largeContent);
  assert.ok(!backgroundSaved.some(doc => doc.id === 'quick.md'), 'later import commits do not resurrect a deleted file');
  assert.deepEqual(backgroundSaved.filter(doc => /^parallel(?: \(2\))?\.md$/.test(doc.id)).map(doc => doc.content).sort(), ['# Parallel A', '# Parallel B']);
  assert.ok(await page.evaluate(() => window.__workerProgress.some(p => p.file === 'slow-large.md' && p.loaded > 0 && p.loaded < p.total)), 'actual worker reports intermediate byte progress');
  assert.equal(await page.locator('#title').textContent(), 'Autoscroll check');
  assert.equal(await page.locator('#play').textContent(), 'Pause');
  await click('play'); await reopen();
  await until(() => document.querySelector('#title').textContent === 'Autoscroll check');
  assert.ok((await storedSnapshot()).documents.some(doc => doc.id === 'slow-large.md'), 'completed imports survive reopening');
  assert.equal(await page.locator('#imports').isVisible(), false, 'completed progress is session-only');
  console.log('PASS: independent background imports, Add files while busy, continued playback, per-file errors, safe deletion and duplicate names.');
  // A new browser context has no IndexedDB, localStorage or cookies. Only the
  // simulated companion app storage survives, as on a real WebView restart.
  await showTool(page, 'settings'); await page.locator('#theme-dark').click();
  await flushPhone(); await until(() => !window.__inflight);
  const restoredCount = await page.locator('#doc-count').textContent();
  const restoredPosition = await percent();
  const coldContext = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
  observe(coldContext); await installBridge(coldContext);
  const cold = await coldContext.newPage(); cold.on('pageerror', error => errors.push(error.message));
  await cold.goto(base);
  await cold.waitForFunction(() => !document.querySelector('#import').disabled);
  await expect(cold.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(cold.locator('html')).toHaveCSS('color-scheme', 'dark');
  assert.equal(await cold.locator('#doc-count').textContent(), restoredCount);
  assert.equal(await cold.locator('#title').textContent(), 'Autoscroll check');
  assert.equal(await cold.locator('#position-value').textContent(), `${restoredPosition}%`);
  assert.equal(await cold.locator('#play').textContent(), 'Start autoscroll');
  await showLibrary(cold); await cold.locator('[data-document-id="tables.md"] .document-card').click();
  await cold.locator('#tab-bookmarks').click(); await cold.locator('#bookmarks .nav-item').click();
  await cold.locator('#passage-current').click();
  await cold.waitForFunction(() => document.querySelector('#passage button[aria-current=true]')?.getAttribute('aria-label') === '    Pause with a tap.');
  assert.equal(await cold.evaluate(() => window.__maxInflight), 1, 'storage and display calls share a serial SDK lane');
  await cold.waitForTimeout(800); await coldContext.close();
  console.log('PASS: phone library, reading position and bookmarks survive a fresh WebView with all browser storage absent.');
  // Upgrade an existing downloaded library without contacting its former server.
  const migratedContext = await browser.newContext(); observe(migratedContext);
  const migrated = await migratedContext.newPage(); migrated.on('pageerror', error => errors.push(error.message));
  // Seed on a same-origin page without the app: its pagehide handler must not
  // overwrite the old preferences before the upgrade is exercised.
  await migrated.goto(base + '/migration-fixture');
  await migrated.evaluate(async () => {
    const origin = 'https://retired.example';
    const anchor = { text: 'Second paragraph.', sourceLine: 5, heading: 'Kept document', offset: 0, percent: 0 };
    localStorage.setItem('even-reader:preferences:v1', JSON.stringify({ connection: { server: origin, token: 'retired-test-credential' }, clientId: 'retired-client', selected: { server: origin, id: 'notes/kept.md' }, size: 18,
      positions: { [origin + '\nnotes/kept.md']: anchor }, bookmarks: { [origin + '\nnotes/kept.md']: [anchor] } }));
    await new Promise((resolve, reject) => {
      const open = indexedDB.open('even-reader', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('data');
      open.onsuccess = () => { const db = open.result; const tx = db.transaction('data', 'readwrite');
        tx.objectStore('data').put({ server: origin, revision: 'old', syncedAt: new Date().toISOString(), documents: [{ id: 'notes/kept.md', title: 'Kept document', content: '# Kept document\n\nFirst paragraph.\n\nSecond paragraph.\n\n' + Array.from({ length: 30 }, (_, i) => `Following paragraph ${i}.`).join('\n\n'), hash: 'old' }] }, 'snapshot');
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
      };
    });
  });
  const migratedPhone = new Map(); await installBridge(migratedContext, migratedPhone);
  await migrated.goto(base + '/#token=retired-test-credential');
  await migrated.waitForFunction(() => document.querySelector('#title').textContent === 'Kept document');
  assert.equal(new URL(migrated.url()).hash, '');
  assert.equal(await migrated.locator('#doc-count').textContent(), '1');
  await migrated.waitForFunction(() => document.querySelector('#passage button[aria-current=true]')?.getAttribute('aria-label') === 'Second paragraph.');
  assert.equal(await migrated.locator('#font-size').inputValue(), '12');
  assert.equal(await migrated.locator('#passage button').first().evaluate(el => getComputedStyle(el).fontSize), '12px');
  const migratedPrefs = await migrated.evaluate(() => JSON.parse(localStorage.getItem('even-reader:preferences:v1')));
  assert.equal(migratedPrefs.connection, undefined); assert.equal(migratedPrefs.clientId, undefined);
  assert.equal(migratedPrefs.bookmarks['https://retired.example\nnotes/kept.md'].length, 1);
  const migratedIndex = new AtomicPhoneValue({ get: async key => migratedPhone.get(key) || '' }, 'library');
  assert.equal((await migratedIndex.read()).documents[0].positionKey, 'https://retired.example\nnotes/kept.md');
  await migrated.locator('#file-picker').setInputFiles({ name: 'new.md', mimeType: 'text/markdown', buffer: Buffer.from('# New local document') });
  await migrated.waitForFunction(() => document.querySelector('#doc-count').textContent === '2' && !document.querySelector('#import').disabled);
  await migrated.reload(); await migrated.waitForFunction(() => document.querySelector('#doc-count').textContent === '2');
  await showLibrary(migrated); await migrated.locator('.document-card').filter({ hasText: 'Kept document' }).click();
  await migrated.locator('#tab-bookmarks').click(); assert.equal(await migrated.locator('#bookmarks .bookmark-row').count(), 1);
  await migratedContext.close();
  // Delete the active document during playback, then the final document, and reopen.
  await showLibrary(page); await page.locator('.document-card').filter({ hasText: 'Autoscroll check' }).click();
  await click('start'); await click('mode-auto'); await click('play');
  await showLibrary(page); await page.getByRole('button', { name: 'Delete auto.md', exact: true }).click();
  await showLibrary(page); await page.locator('[data-confirm-delete="auto.md"]').click();
  await until(() => !document.querySelector('#import').disabled && document.querySelector('#title').textContent !== 'Autoscroll check');
  assert.equal(await page.locator('#play').textContent(), 'Start autoscroll');
  for (const doc of (await storedSnapshot()).documents) {
    await showLibrary(page); await page.getByRole('button', { name: `Delete ${doc.id}`, exact: true }).click();
    await showLibrary(page); await page.locator('[data-confirm-delete]').click();
    await until(() => !document.querySelector('#import').disabled && !document.querySelector('[data-confirm-delete]'));
  }
  await until(() => document.querySelector('#doc-count').textContent === '0' && window.__storedBody.startsWith('No saved documents.'));
  assert.equal(await page.locator('#play').isDisabled(), true);
  assert.equal(await page.locator('#passage button').count(), 0);
  await reopen(); await until(() => !document.querySelector('#import').disabled);
  assert.equal(await page.locator('#doc-count').textContent(), '0', 'deletions survive reopening');
  const finalPrefs = await page.evaluate(() => JSON.parse(localStorage.getItem('even-reader:preferences:v1')));
  assert.deepEqual(finalPrefs.positions, {}); assert.deepEqual(finalPrefs.bookmarks, {});
  await until(() => document.querySelector('#connection').textContent === 'Native text connected' && window.__storedBody.startsWith('No saved documents.') && !window.__inflight);
  await event({ menuItemClickEvent: { itemID: 7 } });
  await until(() => window.__storedBody.startsWith('No saved documents.'));
  await event({ textEvent: {} });
  await event({ textEvent: { eventType: 2 } });
  await until(() => window.__storedBody.startsWith('No saved documents.'));
  const calls = await page.evaluate(() => window.__bridgeCalls);
  assert.equal(startup.data.containerTotalNum, 3);
  assert.equal(startup.data.textObject.filter(c => c.isEventCapture === 1).length, 1);
  assert.equal(startup.data.imageObject, undefined);
  assert.ok(calls.some(c => c.method === 'textContainerUpgrade'));
  assert.ok(!calls.some(c => c.method === 'updateImageRawData'));
  await writeFile('test-results/sdk-payload.json', JSON.stringify({ startup, textUpdates: calls.filter(c => c.method === 'textContainerUpgrade').length }, null, 2));
  assert.deepEqual(errors, []);
  assert.deepEqual(networkCalls, [], 'the app makes no fetch/XHR requests');
  console.log('Browser checks passed: local imports, offline deletion, persistence, storage failures, native text, navigation and serialized display calls.');
} catch (error) {
  console.error('Browser failure state:', await page.evaluate(() => ({
    title: document.querySelector('#title')?.textContent, position: document.querySelector('#position')?.value,
    connection: document.querySelector('#connection')?.textContent,
    calls: window.__bridgeCalls?.map(c => ({ method: c.method, container: c.data?.containerName })),
    diagnostics: JSON.parse(localStorage.getItem('even-reader:diagnostics:v1') || 'null')
  })).catch(() => null));
  throw error;
} finally {
  await browser.close(); await new Promise(r => server.close(r)); await rm(dir, { recursive: true, force: true });
}
