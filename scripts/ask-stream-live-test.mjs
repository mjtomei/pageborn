// Explicit opt-in: creates one new conversation on the configured Terminal.
// Only a synthetic passage is sent. Existing conversations are never selected.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { backToReading, showLibrary } from './ui-helpers.mjs';

if (process.env.PAGEBORNE_LIVE_ASK !== '1') throw new Error('Set PAGEBORNE_LIVE_ASK=1 to create a dedicated live Terminal test conversation.');
const out = path.resolve('test-results/ask-stream-live'); await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, recordVideo: { dir: path.join(out, 'recording'), size: { width: 1280, height: 1000 } } });
const page = await context.newPage(); const result = { passed: false, posts: 0, errors: [] };
page.on('pageerror', e => result.errors.push(e.message));
page.on('response', async response => {
  if (new URL(response.url()).pathname === '/api/prompt' && response.request().method() === 'POST') {
    result.posts++; const data = await response.json().catch(() => ({})); result.sessionId = data.sessionId; result.acceptedStatus = response.status();
  }
});
try {
  await page.goto(process.env.PAGEBORNE_PREVIEW || 'http://127.0.0.1:3461'); await expect(page.locator('#import')).toBeEnabled();
  await showLibrary(page); await page.locator('#file-picker').setInputFiles({ name: 'pageborne-live-stream-check.md', mimeType: 'text/markdown', buffer: Buffer.from('# Pageborne live streaming check\n\n' + Array.from({ length: 30 }, (_, i) => `Paragraph ${i}. A reader keeps a blue notebook with twelve pages. Each page holds one question about a book, supporting quotations, and a later reflection. The notebook is a fictional example for this interface test.`).join('\n\n')) });
  await page.locator('[data-document-id="pageborne-live-stream-check.md"] .document-card').click(); await expect(page.locator('#bookmark')).toBeEnabled();
  await page.locator('#next').click(); await page.waitForTimeout(200); const original = await page.locator('#position').inputValue();
  await page.evaluate(() => {
    window.__partialLengths = [];
    new MutationObserver(() => { const answer = document.querySelector('#ask-answer'); if (answer?.textContent && answer.getAttribute('aria-busy') === 'true') window.__partialLengths.push(answer.textContent.length); }).observe(document.querySelector('#ask-messages'), { childList: true, subtree: true, characterData: true });
  });
  await page.locator('#ask-open').click(); await expect(page.locator('#ask-settings-link')).toBeHidden();
  await page.locator('#ask-question').fill('For this interface test, explain the notebook method in six short numbered paragraphs, about 240 words total. Mention its color and number of pages. Use only the supplied passage and attached paper files. You may read those files, but do not edit files or access the network.');
  await page.locator('#ask-send').click();
  await expect.poll(() => page.evaluate(() => window.__partialLengths.length), { timeout: 180000 }).toBeGreaterThan(0);
  await expect(page.locator('#ask-status')).toHaveAttribute('data-busy', 'true');
  await page.screenshot({ path: path.join(out, 'partial-answer.png') });
  await backToReading(page); await expect(page.locator('#position')).toHaveValue(original);
  await page.locator('#next').click(); await page.waitForTimeout(200); const continued = await page.locator('#position').inputValue();
  await expect(page.locator('#ask-footer')).toHaveText('Ask · Reply ready', { timeout: 180000 });
  await expect(page.locator('#ask-panel')).toBeHidden(); await expect(page.locator('#position')).toHaveValue(continued);
  await page.screenshot({ path: path.join(out, 'reply-notification.png') });
  await page.locator('#ask-footer').click(); await expect(page.locator('#ask-answer')).toContainText(/blue/i);
  await expect(page.locator('#ask-answer')).toContainText(/twelve|12/i); await expect(page.locator('#ask-status')).toHaveAttribute('data-busy', 'false');
  await expect(page.locator('#ask-footer')).toHaveText('Ask · No new replies');
  result.partialLengths = await page.evaluate(() => window.__partialLengths); result.answer = await page.locator('#ask-answer').innerText();
  await page.screenshot({ path: path.join(out, 'completed-answer.png') }); await backToReading(page); await expect(page.locator('#position')).toHaveValue(continued);
  assert.equal(result.posts, 1); assert.deepEqual(result.errors, []); result.readingPositionPreserved = true; result.passed = true;
} catch (error) {
  result.failure = error.message; result.status = await page.locator('#ask-status').innerText().catch(() => 'unavailable');
  await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {}); throw error;
} finally {
  await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
  await context.close(); await copyFile(await page.video().path(), path.join(out, 'live-stream-and-return.webm')); await browser.close();
}
console.log(JSON.stringify({ passed: result.passed, posts: result.posts, partialLengths: result.partialLengths, readingPositionPreserved: result.readingPositionPreserved }));
