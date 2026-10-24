// Chrome UI stress check. Live inference is opt-in and uses only synthetic
// test passages. It never attaches to the user's existing agent conversations.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { createServer } from 'vite';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';
import { showLibrary, showTool, hideSettings, backToReading } from './ui-helpers.mjs';

const dir = path.resolve(process.env.LOADING_RESULTS || 'test-results/loading-ask-chrome');
await mkdir(dir, { recursive: true });
const result = { passed: false, errors: [], cancellations: [], liveTerminal: Boolean(process.env.LIVE_TERMINAL_STATE) };
let fixture;
let endpoint; let token;
if (process.env.LIVE_TERMINAL_STATE) {
  const state = JSON.parse(await readFile(process.env.LIVE_TERMINAL_STATE, 'utf8'));
  endpoint = `http://127.0.0.1:${state.port}`; token = state.token;
} else {
  const app = express(); app.use(express.json());
  app.use((_req, res, next) => { res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' }); next(); });
  app.options('/{*path}', (_req, res) => res.sendStatus(204));
  app.get('/v1/models', (_req, res) => res.json({ data: [{ id: 'fixture' }] }));
  app.post('/v1/chat/completions', (_req, res) => res.json({ choices: [{ message: { content: 'The blue notebook holds twelve pages.' } }] }));
  fixture = app.listen(0, '127.0.0.1'); await new Promise(resolve => fixture.once('listening', resolve));
  endpoint = `http://127.0.0.1:${fixture.address().port}`; token = 'fixture';
}
process.env.PAGEBORNE_ASK_ORIGINS = endpoint;
const vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, clearScreen: false }); await vite.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: process.env.SHOW_BROWSER !== '1',
  env: { ...process.env, ...(process.env.SHOW_BROWSER === '1' ? { DISPLAY: ':0', XAUTHORITY: '/run/user/1000/gdm/Xauthority' } : {}) }, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, recordVideo: { dir: path.join(dir, 'recording'), size: { width: 1100, height: 900 } } });
await context.addInitScript(() => {
  const NativeWorker = window.Worker; window.__workers = { active: 0, created: 0 };
  window.Worker = class extends NativeWorker {
    constructor(...args) { super(...args); window.__workers.active++; window.__workers.created++; }
    terminate() { if (!this.closedByTest) { this.closedByTest = true; window.__workers.active--; } return super.terminate(); }
  };
  const post = NativeWorker.prototype.postMessage; const pending = [];
  window.__holdPages = false; window.__held = 0;
  NativeWorker.prototype.postMessage = function (...args) {
    if (window.__holdPages && args[0]?.action === 'GetPage' && args[0].data.pageIndex > 0) { pending.push([this, args]); window.__held++; }
    else post.apply(this, args);
  };
  window.__release = () => { window.__holdPages = false; for (const [worker, args] of pending.splice(0)) worker.postMessage(...args); };
  window.__longTasks = [];
  new PerformanceObserver(list => { for (const e of list.getEntries()) window.__longTasks.push(e.duration); }).observe({ type: 'longtask', buffered: true });
});
const page = await context.newPage();
page.on('pageerror', e => result.errors.push(e.message)); page.on('crash', () => result.errors.push('Chrome page crashed'));
page.on('response', response => {
  if (response.url().startsWith(endpoint) && response.request().method() === 'POST') console.log(`Chrome: Ask POST returned HTTP ${response.status()}.`);
});
const cdp = await context.newCDPSession(page);
const open = async file => { await showLibrary(page); await page.locator(`[data-document-id="${file}"] .document-card`).click(); };
const flush = () => page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); return JSON.parse(localStorage.getItem('even-reader:preferences:v1')).positions; });
const ask = async (question, expected) => {
  await page.locator('#ask-open').click(); await page.locator('#ask-question').fill(question); await page.locator('#ask-send').click();
  await expect(page.locator('#ask-send')).toBeEnabled({ timeout: 180000 });
  assert.match(await page.locator('#ask-answer').innerText(), expected, await page.locator('#ask-status').innerText());
};
try {
  await page.goto(vite.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled();
  const files = [
    { name: 'loading-test.pdf', mimeType: 'application/pdf', buffer: pdfFixture('repeated-text') },
    { name: 'ask-test.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notebook test\n\nThe project uses a blue notebook. The notebook has twelve pages.') },
  ];
  if (process.env.PDF_SAMPLE) files.push({ name: 'scan-test.pdf', mimeType: 'application/pdf', buffer: await readFile(process.env.PDF_SAMPLE) });
  await page.locator('#file-picker').setInputFiles(files); await expect(page.locator('#doc-count')).toHaveText(String(files.length));
  await open('ask-test.md'); await showTool(page, 'settings');
  if (result.liveTerminal) {
    await page.locator('#ask-mode').selectOption('terminal'); await page.locator('#ask-endpoint').fill(endpoint);
    await page.locator('#ask-token').fill(token); await page.locator('#ask-agent').selectOption('codex');
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'pageborne-ask-ui-test-'));
    await page.locator('#ask-cwd').fill(workspace); result.testWorkspace = workspace;
  } else {
    await page.locator('#ask-provider-url').fill(endpoint + '/v1'); await page.locator('#ask-model').fill('fixture'); await page.locator('#ask-api-key').fill(token);
  }
  await page.locator('#ask-config-save').click(); await expect(page.locator('#ask-config-status')).toContainText('Saved for all documents');
  result.connectionSaved = true; console.log('Chrome: Ask connection saved.');
  await hideSettings(page);
  const beforeAsk = await flush();
  await ask('What color is the notebook? Answer in one short sentence. Do not use tools or change files.', /blue/i);
  result.markdownAnswer = true; console.log('Chrome: Markdown Ask returned an answer.');
  await page.screenshot({ path: path.join(dir, 'markdown-answer.png'), fullPage: true });
  await backToReading(page); assert.deepEqual(await flush(), beforeAsk);

  await page.evaluate(() => { window.__holdPages = true; }); await open('loading-test.pdf');
  await expect(page.locator('#notice-text')).toContainText('1 of', { timeout: 30000 });
  await expect(page.locator('#pdf-passage canvas').first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__held)).toBeGreaterThan(0);
  const partial = await flush();
  await ask('Briefly describe the visible passage in one sentence. Do not use tools or change files.', /\S/);
  result.partialPdfAsk = true; console.log('Chrome: Ask works while later PDF pages are stalled.');
  await page.screenshot({ path: path.join(dir, 'partial-pdf-answer.png'), fullPage: true });
  await backToReading(page); assert.deepEqual(await flush(), partial);
  await showLibrary(page);
  const start = performance.now();
  await page.locator('[data-document-id="ask-test.md"] .document-card').click();
  await expect(page.locator('#title')).toHaveText('Notebook test');
  result.partialCancelMs = Math.round(performance.now() - start);
  await expect.poll(() => page.evaluate(() => window.__workers.active)).toBe(0);
  await page.evaluate(() => window.__release());
  await expect(page.locator('#passage')).toContainText('blue notebook');

  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  for (let i = 0; i < 12; i++) {
    const created = await page.evaluate(() => window.__workers.created);
    await open(process.env.PDF_SAMPLE ? 'scan-test.pdf' : 'loading-test.pdf');
    await expect.poll(() => page.evaluate(() => window.__workers.created)).toBeGreaterThan(created);
    await page.waitForTimeout([20, 200, 600][i % 3]);
    await showLibrary(page);
    const clickAt = performance.now();
    await page.locator('[data-document-id="ask-test.md"] .document-card').click();
    await expect(page.locator('#title')).toHaveText('Notebook test');
    await expect(page.locator('#passage')).toContainText('blue notebook');
    await expect.poll(() => page.evaluate(() => window.__workers.active), { timeout: 10000 }).toBe(0);
    result.cancellations.push({ round: i + 1, ms: Math.round(performance.now() - clickAt), activeWorkers: 0 });
    console.log(`Chrome: loading/cancellation ${i + 1}/12 passed with one click.`);
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  result.longTasks = await page.evaluate(() => ({ count: window.__longTasks.length, maxMs: Math.round(Math.max(0, ...window.__longTasks)) }));
  if (process.env.PDF_SAMPLE) {
    await page.evaluate(() => { window.__holdPages = true; window.__held = 0; }); await open('scan-test.pdf');
    await expect(page.locator('#notice-text')).toContainText('1 of', { timeout: 120000 });
    await expect(page.locator('#pdf-passage canvas').first()).toBeVisible();
    await page.screenshot({ path: path.join(dir, 'real-scan-partial.png'), fullPage: true }); result.realScanPartial = true;
    await open('ask-test.md'); await expect.poll(() => page.evaluate(() => window.__workers.active)).toBe(0); await page.evaluate(() => window.__release());
  }
  assert.deepEqual(result.errors, []); result.passed = true;
  console.log(JSON.stringify({ passed: true, liveTerminal: result.liveTerminal, cancellations: result.cancellations.length, partialPdfAsk: true, realScanPartial: result.realScanPartial, longTasks: result.longTasks }));
} catch (error) {
  result.error = error.stack;
  result.askStatus = await page.locator('#ask-status').innerText().catch(() => 'unavailable');
  await page.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  await context.close(); await browser.close(); await vite.close(); fixture?.closeAllConnections(); fixture?.close();
}
