// Opt-in real Claude test. Supply only an owner created specifically for this test.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { backToReading, showLibrary, showTool, hideSettings } from './ui-helpers.mjs';

if (!process.env.LIVE_TERMINAL_STATE || !process.env.LIVE_CLAUDE_BINDING) throw new Error('Provide a pairing file and a dedicated test owner binding.');
const state = JSON.parse(await readFile(process.env.LIVE_TERMINAL_STATE, 'utf8'));
const binding = JSON.parse(await readFile(process.env.LIVE_CLAUDE_BINDING, 'utf8'));
assert.match(binding.cwd, /pageborne-claude-test-/);
const endpoint = `http://127.0.0.1:${state.port}`;
const dir = path.resolve(process.env.CLAUDE_RESULTS || 'test-results/ask-claude-live'); await mkdir(dir, { recursive: true });
process.env.PAGEBORNE_ASK_ORIGINS = endpoint;
const vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, clearScreen: false }); await vite.listen();
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: process.env.SHOW_BROWSER !== '1',
  env: { ...process.env, DISPLAY: ':0', XAUTHORITY: '/run/user/1000/gdm/Xauthority' }, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, recordVideo: { dir: path.join(dir, 'recording') } });
const page = await context.newPage(); const result = { passed: false, errors: [] };
page.on('pageerror', error => result.errors.push(error.message));
const flush = () => page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); return JSON.parse(localStorage.getItem('even-reader:preferences:v1')).positions; });
const send = async question => {
  await page.locator('#ask-question').fill(question);
  const submitted = page.waitForResponse(r => r.url().includes('/api/prompt?') && r.request().method() === 'POST');
  await page.locator('#ask-send').click(); assert.ok((await submitted).ok());
};
try {
  await page.goto(vite.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled();
  await page.locator('#file-picker').setInputFiles({ name: 'claude-test.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notebook test\n\nThe project uses a blue notebook. The notebook has twelve pages.\n\n' + 'This is a synthetic reading passage for testing. '.repeat(100)) });
  await showLibrary(page); await page.locator('[data-document-id="claude-test.md"] .document-card').click();
  await showTool(page, 'settings');
  await page.locator('#ask-mode').selectOption('terminal'); await page.locator('#ask-endpoint').fill(endpoint);
  await page.locator('#ask-token').fill(state.token); await page.locator('#ask-agent').selectOption('claude');
  await page.locator('#ask-config-save').click(); await expect(page.locator('#ask-config-status')).toContainText('Saved for all documents');
  await hideSettings(page); const before = await flush();
  await page.locator('#ask-open').click(); await page.locator('.ask-details').evaluate(el => el.open = true); await page.locator('#ask-paper-session summary').click(); await page.locator('#ask-sessions-refresh').click();
  await expect(page.locator(`#ask-session-choice option[value="${binding.localId}"]`)).toHaveCount(1, { timeout: 30000 });
  await page.locator('#ask-session-choice').selectOption(binding.localId); await page.locator('#ask-session-use').click();
  result.sessionAttached = true;
  await send('What color is the notebook? Answer in one short sentence. Do not use tools or change files.');
  await expect(page.locator('#ask-send')).toBeEnabled({ timeout: 180000 });
  assert.match(await page.locator('#ask-answer').innerText(), /blue/i, await page.locator('#ask-status').innerText());
  result.answer = await page.locator('#ask-answer').innerText();
  await page.screenshot({ path: path.join(dir, 'claude-answer.png'), fullPage: true });
  console.log('PASS: real Claude answer through Chrome.');
  await backToReading(page); assert.deepEqual(await flush(), before); result.returnPosition = true;
  await page.locator('#ask-open').click();
  await send('How many pages does that notebook have? Answer in one short sentence. Do not use tools or change files.');
  // Leave while Claude is thinking; let the reading-screen footer collect it.
  await backToReading(page);
  await expect(page.locator('#ask-footer')).toContainText('Reply ready', { timeout: 180000 });
  await page.locator('#ask-footer').click();
  assert.match(await page.locator('#ask-answer').innerText(), /twelve|12/i);
  result.followup = await page.locator('#ask-answer').innerText(); result.backgroundReply = true;
  await page.screenshot({ path: path.join(dir, 'claude-followup.png'), fullPage: true });
  await backToReading(page); assert.deepEqual(await flush(), before);
  await page.reload(); await expect(page.locator('#ask-open')).toBeEnabled();
  await page.locator('#ask-open').click();
  await expect(page.locator('#ask-session-label')).toContainText(binding.localId);
  await send('Remind me of the notebook color and page count in one short sentence. Do not use tools or change files.');
  await expect(page.locator('#ask-send')).toBeEnabled({ timeout: 180000 });
  const restored = await page.locator('#ask-answer').innerText(); assert.match(restored, /blue/i); assert.match(restored, /twelve|12/i);
  result.sessionRestored = true;
  assert.deepEqual(result.errors, []); result.passed = true;
  console.log('PASS: Claude follow-up, background reply indicator, exact return position and reload.');
} catch (error) {
  result.error = error.stack; result.status = await page.locator('#ask-status').innerText().catch(() => 'unavailable');
  await page.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {}); throw error;
} finally {
  await writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  await context.close(); await copyFile(await page.video().path(), path.join(dir, 'chrome-claude-ask.webm'));
  await browser.close(); await vite.close();
}
