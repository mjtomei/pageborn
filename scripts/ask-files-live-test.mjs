// Opt-in proof that a real Codex agent can navigate files outside the prompt.
// The browser supplies the new file routes to its own test directory; ordinary
// inference goes to the existing Terminal. No server restart is required.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { paperFilesStatus, paperFileChunk, commitPaperFiles } from '../integrations/even-terminal/pageborne-files.js';
import { backToReading, showLibrary } from './ui-helpers.mjs';

if (process.env.PAGEBORNE_LIVE_ASK !== '1') throw new Error('Set PAGEBORNE_LIVE_ASK=1 to create a dedicated live Terminal file-reading conversation.');
const out = path.resolve('test-results/ask-files-live'); await mkdir(out, { recursive: true });
const baseDir = await mkdtemp(path.join(tmpdir(), 'pageborne-live-paper-'));
const vite = await createServer({ mode: 'debug', server: { host: '127.0.0.1', port: 0 }, clearScreen: false }); await vite.listen();
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, recordVideo: { dir: path.join(out, 'recording') } });
const page = await context.newPage(); const prompts = []; let chunks = 0;
const result = { passed: false, errors: [] }; page.on('pageerror', error => result.errors.push(error.message));
await page.route('**/api/info?*', async route => {
  const response = await route.fetch(); const info = await response.json();
  await route.fulfill({ response, json: { ...info, pageborne: { ...info.pageborne, documents: 1 } } });
});
const actions = { status: paperFilesStatus, chunk: paperFileChunk, commit: commitPaperFiles };
await page.route('**/api/pageborne/files/*', async route => {
  const action = new URL(route.request().url()).pathname.split('/').at(-1); if (action === 'chunk') chunks++;
  try { await route.fulfill({ json: await actions[action](route.request().postDataJSON(), { baseDir }) }); }
  catch { await route.fulfill({ status: 400, json: { error: 'Test file route failed' } }); }
});
page.on('request', req => { if (new URL(req.url()).pathname === '/api/prompt') prompts.push(req.postDataJSON()); });
try {
  await page.goto(vite.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled(); await showLibrary(page);
  const source = '# Synthetic navigation check\n\nOpening position. The reference facts are elsewhere in this paper.\n\n'
    + Array.from({ length: 120 }, (_, i) => `## Section ${i}\n\n` + (i === 85 ? 'The cedar marker has a count of thirty-one. ' : i === 110 ? 'The calibration phrase is violet lantern. ' : 'A neutral paragraph for a document navigation test. ').repeat(8)).join('\n\n');
  await page.locator('#file-picker').setInputFiles({ name: 'live-file-navigation.md', mimeType: 'text/markdown', buffer: Buffer.from(source) });
  await page.locator('[data-document-id="live-file-navigation.md"] .document-card').click(); await expect(page.locator('#ask-open')).toBeEnabled();
  await page.locator('#ask-open').click(); await page.locator('#ask-question').fill('Find the calibration phrase elsewhere in this paper. Read the attached local files and answer with the exact phrase and a source line reference. Do not edit files or access the network.');
  await page.locator('#ask-send').click();
  await expect(page.locator('#ask-answer')).toContainText('violet lantern', { timeout: 180000 });
  await expect(page.locator('#ask-status')).toHaveAttribute('data-busy', 'false', { timeout: 180000 });
  assert.equal(prompts.length, 1); assert(!prompts[0].text.includes('violet lantern')); assert(!prompts[0].text.includes('Reading context (source material)'));
  const uploaded = chunks; result.firstAnswer = await page.locator('#ask-answer').innerText();
  await backToReading(page); await page.locator('#position').evaluate(el => { el.value = '500'; el.dispatchEvent(new Event('input')); }); await page.waitForTimeout(150);
  await page.locator('#ask-open').click(); await page.locator('#ask-question').fill('Now find the count associated with the cedar marker elsewhere in the same paper. Give the count and a source reference.'); await page.locator('#ask-send').click();
  await expect(page.locator('#ask-answer')).toContainText(/thirty.one|31/, { timeout: 180000 });
  await expect(page.locator('#ask-status')).toHaveAttribute('data-busy', 'false', { timeout: 180000 });
  assert.equal(prompts.length, 2); assert.equal(chunks, uploaded); assert(!prompts[1].text.includes('thirty-one')); assert(!prompts[1].text.includes('Paper files (read them as needed'));
  result.followupAnswer = await page.locator('#ask-answer').innerText();
  result.promptCharacters = prompts.map(p => p.text.length); result.fileChunks = chunks; result.reusedUploads = true;
  await page.screenshot({ path: path.join(out, 'conversation.png') });
  assert.deepEqual(result.errors, []); result.passed = true;
} catch (error) { result.failure = error.message; result.status = await page.locator('#ask-status').innerText().catch(() => 'Unavailable'); await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); throw error; }
finally {
  await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
  await context.close(); await browser.close(); await vite.close(); await rm(baseDir, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: result.passed, promptCharacters: result.promptCharacters, reusedUploads: result.reusedUploads }));
