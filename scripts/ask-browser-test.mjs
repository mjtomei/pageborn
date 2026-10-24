import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readdir, access, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { createAiBridge } from '../ai/server.js';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';
import { showLibrary, showTool, hideSettings, waitForPdfReady } from './ui-helpers.mjs';
const dir = path.resolve('test-results/ask'); await mkdir(dir, { recursive: true });
const requests = []; const token = 'test-only-bridge-token-123456789'; let delayed = false; let release;
const bridge = createAiBridge({ token, provider: 'openai-compatible', baseUrl: 'http://mock.invalid/v1', model: 'test-model',
  transcription: { baseUrl: 'http://mock.invalid/v1', model: 'test-speech' } }, { fetcher: async (url, options) => {
  if (url.endsWith('/audio/transcriptions')) { assert((await options.body.get('file').arrayBuffer()).byteLength > 44); return Response.json({ text: 'Explain this passage in simple words.' }); }
  const input = JSON.parse(options.body); requests.push(input);
  if (delayed) await new Promise(r => { release = r; });
  return Response.json({ choices: [{ message: { content: 'Test answer about this passage. ' + 'A useful explanation with enough detail for several display pages. '.repeat(32) } }] });
} }).listen(0, '127.0.0.1'); await new Promise(r => bridge.once('listening', r));
const endpoint = `http://127.0.0.1:${bridge.address().port}`; process.env.PAGEBORNE_ASK_ORIGINS = endpoint;
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, clearScreen: false }); await server.listen();
const cache = path.join(os.homedir(), '.cache/ms-playwright');
const candidates = [process.env.CHROME_PATH, chromium.executablePath(), ...(await readdir(cache)).filter(n => /^chromium-\d+$/.test(n)).flatMap(n => [path.join(cache, n, 'chrome-linux/chrome'), path.join(cache, n, 'chrome-linux64/chrome')])].filter(Boolean);
const executablePath = (await Promise.all(candidates.map(async f => { try { await access(f); return f; } catch { return null; } }))).find(Boolean);
const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); const errors = []; page.on('pageerror', e => errors.push(e.message));
const storage = new Map(); await page.exposeFunction('__storage', ({ method, data }) => { if (method === 'getLocalStorage') return storage.get(data.key) || ''; storage.set(data.key, data.value); return true; });
await page.addInitScript(() => {
  window.__body = ''; window.__status = ''; window.__micCalls = []; window.__micDelay = 0;
  window.flutter_inappwebview = { async callHandler(_name, serialized) {
    const m = JSON.parse(serialized);
    if (m.method.endsWith('LocalStorage')) return window.__storage(m);
    if (m.method === 'audioControl') { window.__micCalls.push(m.data); if (m.data.isOpen) await new Promise(r => setTimeout(r, window.__micDelay)); return true; }
    if (['createStartUpPageContainer', 'rebuildPageContainer'].includes(m.method)) {
      window.__body = m.data.textObject.find(t => t.containerName === 'body')?.content || '';
      window.__status = m.data.textObject.find(t => t.containerName === 'status')?.content || '';
      return m.method === 'createStartUpPageContainer' ? 0 : true;
    }
    if (m.method === 'textContainerUpgrade') { if (m.data.containerName === 'body') window.__body = m.data.content; if (m.data.containerName === 'status') window.__status = m.data.content; }
    if (m.method === 'updateImageRawData') return 0;
    return true;
  } };
});
const event = detail => page.evaluate(detail => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail })), detail);
const body = () => page.evaluate(() => window.__body);
const status = () => page.evaluate(() => window.__status);
const hold = () => event({ sysEvent: { eventType: 9 } }); const lift = () => event({ sysEvent: { eventType: 10 } });
const tap = () => event({ textEvent: { eventType: 0 } }); const back = () => event({ textEvent: { eventType: 3 } });
const answer = async () => { await expect(page.locator('#ask-answer')).toContainText('Test answer'); await expect.poll(status).toMatch(/^Ask · Swipe/); };
const result = { passed: false };
try {
  await page.goto(server.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled();
  await page.locator('#file-picker').setInputFiles([
    { name: 'reading.md', mimeType: 'text/markdown', buffer: Buffer.from('# Title\n\n' + Array.from({ length: 80 }, (_, i) => `Paragraph ${i}: ${'The reader is thinking about the argument. '.repeat(16)}`).join('\n\n')) },
    { name: 'paper.pdf', mimeType: 'application/pdf', buffer: pdfFixture('annotations') },
  ]);
  await expect(page.locator('#doc-count')).toHaveText('2'); await page.locator('[data-document-id="reading.md"] .document-card').click();
  await expect(page.locator('#bookmark')).toBeEnabled();
  await showTool(page, 'settings'); await page.locator('#ask-legacy-option').evaluate(el => el.hidden = false); await page.locator('#ask-mode').selectOption('bridge'); await page.locator('#ask-endpoint').fill(endpoint); await page.locator('#ask-token').fill(token); await page.locator('#ask-config-save').click();
  await expect(page.locator('#ask-config-status')).toContainText('Saved for all documents');
  await page.locator('#speech-backend').selectOption('remote');
  await hideSettings(page);
  await page.locator('#position').evaluate(el => { el.value = '400'; el.dispatchEvent(new Event('input')); });
  const position = await page.locator('#position').inputValue();
  await hold(); await expect(page.locator('#ask-status')).toContainText('Listening…');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { audioEvent: { audioPcm: new Uint8Array(16000).fill(25), source: 'glasses' } } })));
  await lift(); await answer(); assert.equal(requests.length, 1); assert.match(requests[0].messages[1].content, /Reading context/);
  await page.screenshot({ path: path.join(dir, 'phone-answer.png'), fullPage: true });
  const first = await body(); await event({ textEvent: { eventType: 2 } }); await expect.poll(body).not.toBe(first);
  assert.equal(await page.locator('#position').inputValue(), position);
  await page.locator('#ask-question').fill('Why does that follow?'); await page.locator('#ask-send').click(); await expect.poll(() => requests.length).toBe(2); await answer(); assert.equal(requests[1].messages.length, 5);
  await tap(); await expect(page.locator('#ask-panel')).toBeHidden(); assert.equal(await page.locator('#position').inputValue(), position);
  result.voiceAndFollowups = true; result.pagingAndReturn = true;
  // Release while the SDK is still opening the mic. There is no hidden
  // recording after the error and no inference request with empty audio.
  await page.evaluate(() => { window.__micDelay = 300; window.__micCalls = []; });
  await hold(); await expect(page.locator('#ask-status')).toHaveText('Starting microphone…'); await lift();
  await expect(page.locator('#ask-panel')).toBeHidden();
  await expect(page.locator('#ask-status')).not.toHaveText(/No speech/);
  await expect.poll(() => page.evaluate(() => window.__micCalls.map(x => x.isOpen))).toEqual([true, false]); assert.equal(requests.length, 2);
  result.earlyReleaseStopsMicrophone = true;
  // Late network results must not replace a document selected while waiting.
  delayed = true; await page.locator('#ask-open').click(); await page.locator('#ask-question').fill('Wait for this answer'); await page.locator('#ask-send').click(); await expect.poll(() => requests.length).toBe(3);
  await showLibrary(page); await page.locator('[data-document-id="paper.pdf"] .document-card').click(); release(); delayed = false;
  await waitForPdfReady(page); await expect(page.locator('#ask-panel')).toBeHidden(); await expect.poll(status).not.toMatch(/^Ask/); result.cancelOnDocumentChange = true;
  // Settings are global; ask works with reflowed PDF text too.
  await page.locator('#position').evaluate(el => { el.value = '500'; el.dispatchEvent(new Event('input')); }); const pdfPosition = await page.locator('#position').inputValue();
  await event({ menuItemClickEvent: { itemID: 10 } }); await expect(page.locator('#ask-context')).toContainText('PDF page');
  await page.locator('#ask-question').fill('What is this paragraph about?'); await page.locator('#ask-send').click(); await answer(); await tap();
  assert.equal(await page.locator('#position').inputValue(), pdfPosition); result.pdfContextAndReturn = true;
  for (const mode of ['auto', 'speed']) {
    await page.locator(`#mode-${mode}`).evaluate(el => el.click());
    await page.locator('#position').evaluate(el => { el.value = '350'; el.dispatchEvent(new Event('input')); });
    const anchor = async () => page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); return JSON.parse(localStorage.getItem('even-reader:preferences:v1')).positions; });
    const saved = await anchor();
    await event({ menuItemClickEvent: { itemID: 10 } });
    await page.locator('#ask-question').fill('Explain this word group'); await page.locator('#ask-send').click(); await answer();
    await tap(); await expect(page.locator('#ask-panel')).toBeHidden(); assert.deepEqual(await anchor(), saved);
    await expect(page.locator('#play')).not.toHaveText('Pause');
  }
  result.exactAutoAndSpeedReturn = true;
  // Cold WebView reload uses the shared phone settings; credentials never
  // appear in diagnostics.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await page.waitForTimeout(650); await page.reload(); await expect(page.locator('#import')).toBeEnabled();
  await showTool(page, 'settings'); await expect(page.locator('#ask-endpoint')).toHaveValue(endpoint); await expect(page.locator('#ask-token')).toHaveValue(token);
  const diagnostics = await page.evaluate(() => localStorage.getItem('even-reader:diagnostics:v1')); assert(!diagnostics.includes(token)); assert(!diagnostics.includes('Why does that follow?'));
  result.sharedSettingsPersist = true; result.noCredentialsOrQuestionsInDiagnostics = true;
  // Real mouse/touchpad gestures exercise the same dispatcher as SDK events.
  await hideSettings(page); await showLibrary(page); await page.locator('[data-document-id="reading.md"] .document-card').click();
  await page.locator('#mode-page').evaluate(el => el.click()); await page.locator('#start').click();
  const point = async () => { await page.locator('#preview').scrollIntoViewIfNeeded(); const r = await page.locator('#preview').boundingBox(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  const swipe = async (dx, dy) => { const p = await point(); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + dx, p.y + dy, { steps: 5 }); await page.mouse.up(); };
  const previewTap = () => page.locator('#preview').click();
  await previewTap(); await expect(page.locator('#page-number')).toHaveValue('2');
  await swipe(-65, 0); await expect(page.locator('#page-number')).toHaveValue('3');
  await swipe(65, 0); await expect(page.locator('#page-number')).toHaveValue('2');
  await swipe(0, 65); await expect(page.locator('#page-number')).toHaveValue('3');
  await swipe(0, -65); await expect(page.locator('#page-number')).toHaveValue('2');
  const doubleTapPosition = await page.locator('#position').inputValue();
  await page.locator('#preview').dblclick(); await expect.poll(body).toContain('Choose document');
  await expect(page.locator('#library-panel')).toHaveAttribute('data-open', 'false');
  await previewTap(); await expect(page.locator('#title')).toContainText('Title');
  await expect(page.locator('#position')).toHaveValue(doubleTapPosition); // no first-tap page turn
  for (const mode of ['auto', 'speed']) {
    await page.locator(`#mode-${mode}`).evaluate(el => el.click());
    const rate = () => page.locator('#speed-value').textContent(); const original = await rate(); const position = await page.locator('#position').inputValue();
    await event({ textEvent: { eventType: 2 } }); const nativeNext = await rate();
    await event({ textEvent: { eventType: 1 } }); await expect.poll(rate).toBe(original);
    await swipe(0, 65); await expect.poll(rate).toBe(nativeNext); await expect(page.locator('#position')).toHaveValue(position);
    await swipe(65, 0); await expect.poll(rate).toBe(original);
    await page.locator('#preview').focus(); await page.keyboard.press('ArrowDown'); await expect.poll(rate).toBe(nativeNext);
    await page.keyboard.press('ArrowUp'); await expect.poll(rate).toBe(original);
  }
  result.previewSwipesMatchNativeAndKeyboard = true;
  // A quick tap then a sustained press opens the same app menu, not Ask or a page turn.
  const savedMenuPosition = await page.locator('#position').inputValue(); let p = await point();
  await page.mouse.click(p.x, p.y); await page.mouse.down(); await page.waitForTimeout(650);
  await expect(page.locator('#preview-menu-toggle')).toHaveAttribute('aria-expanded', 'true'); await page.mouse.up();
  await expect.poll(body).toContain('Pageborne menu'); await expect(page.locator('#ask-panel')).toBeHidden();
  await expect(page.locator('#position')).toHaveValue(savedMenuPosition);
  await swipe(0, 65); await expect(page.locator('#preview')).toHaveAttribute('aria-label', /Go to position/); await previewTap();
  await expect.poll(status).toContain('Swipe 5%'); await swipe(0, 65); await previewTap(); await expect.poll(status).not.toContain('Swipe 5%');
  result.previewMenuAndPositionPicker = true;
  // Hold/release starts microphone capture while held, sends once on release.
  await page.evaluate(() => { window.__micDelay = 0; window.__micCalls = []; });
  const count = requests.length; const readingPlace = await page.locator('#position').inputValue(); p = await point();
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.waitForTimeout(650);
  await expect(page.locator('#ask-status')).toContainText('Listening…'); assert.equal(requests.length, count);
  await event({ audioEvent: { audioPcm: new Uint8Array(16000).fill(25), source: 'glasses' } }); await page.mouse.up(); await answer();
  assert.equal(requests.length, count + 1); const answerPage = await body(); await swipe(0, 65); await expect.poll(body).not.toBe(answerPage);
  await previewTap(); await expect(page.locator('#ask-panel')).toBeHidden(); await expect(page.locator('#position')).toHaveValue(readingPlace);
  // A lost pointer/blur cancels a recording, without submitting any captured audio.
  await page.evaluate(() => { window.__micCalls = []; }); p = await point(); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.waitForTimeout(650);
  await expect(page.locator('#ask-status')).toContainText('Listening'); await event({ audioEvent: { audioPcm: new Uint8Array(16000).fill(25) } });
  await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.mouse.up();
  await expect(page.locator('#ask-panel')).toBeHidden(); await expect.poll(() => page.evaluate(() => window.__micCalls.map(x => x.isOpen))).toEqual([true, false]); assert.equal(requests.length, count + 1);
  // Keyboard hold releases even if focus moves into the question field.
  await page.locator('#preview').focus(); await page.keyboard.down('a'); await expect(page.locator('#ask-status')).toContainText('Listening');
  await event({ audioEvent: { audioPcm: new Uint8Array(16000).fill(25) } }); await page.locator('#ask-question').focus(); await page.keyboard.up('a'); await answer(); assert.equal(requests.length, count + 2); await tap();
  // Text/list envelopes carry long presses too (not only sysEvent).
  await event({ textEvent: { eventType: 9 } }); await expect(page.locator('#ask-status')).toContainText('Listening');
  await event({ audioEvent: { audioPcm: new Uint8Array(16000).fill(25) } }); await event({ listEvent: { eventType: 10 } }); await answer(); assert.equal(requests.length, count + 3); await tap();
  // Touch events cover mobile pointer capture, vertical swipes and multitouch cancellation.
  const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  await page.locator('#mode-page').evaluate(el => el.click()); await page.locator('#start').click(); p = await point();
  const touch = async (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((q, i) => ({ x: q.x, y: q.y, id: i + 1 })) });
  await touch('touchStart', [p]); await touch('touchMove', [{ x: p.x, y: p.y + 60 }]); await touch('touchEnd', []);
  await expect(page.locator('#page-number')).toHaveValue('2');
  const sentBeforePinch = requests.length; await page.evaluate(() => { window.__micCalls = []; });
  await touch('touchStart', [p]); await page.waitForTimeout(650); await expect(page.locator('#ask-status')).toContainText('Listening');
  await touch('touchStart', [p, { x: p.x + 40, y: p.y }]); await touch('touchEnd', []);
  await expect(page.locator('#ask-panel')).toBeHidden(); assert.equal(requests.length, sentBeforePinch);
  await expect.poll(() => page.evaluate(() => window.__micCalls.map(x => x.isOpen))).toEqual([true, false]);
  await touch('touchStart', [p]); await touch('touchEnd', []); await expect(page.locator('#page-number')).toHaveValue('3');
  await cdp.detach();
  result.previewHoldsCancellationAndNativeEnvelopes = true;
  // New document navigation cancels a pending tap rather than applying it later.
  const pageBeforeCancel = await page.locator('#page-number').inputValue();
  await previewTap(); await page.locator('#mode-page').evaluate(el => el.click()); await page.waitForTimeout(400);
  await expect(page.locator('#page-number')).toHaveValue(pageBeforeCancel);
  assert.deepEqual(errors, []); result.passed = true;
} catch (error) {
  result.failure = error.message; result.askStatus = await page.locator('#ask-status').textContent(); result.micCalls = await page.evaluate(() => window.__micCalls); console.log(JSON.stringify(result)); await page.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }); throw error;
} finally {
  result.errors = errors; await writeFile(path.join(dir, 'browser-results.json'), JSON.stringify(result, null, 2));
  await browser.close(); await server.close(); bridge.closeAllConnections(); await new Promise(r => bridge.close(r));
}
console.log(JSON.stringify(result));
