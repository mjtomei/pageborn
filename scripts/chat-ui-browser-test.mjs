import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';
import { showLibrary, waitForPdfReady } from './ui-helpers.mjs';

const out = path.resolve('test-results/chat-ui'); await mkdir(out, { recursive: true });
process.env.PAGEBORNE_ASK_ORIGINS = 'https://ui-chat.test';
const vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, clearScreen: false }); await vite.listen();
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const result = { passed: false, sizes: [], errors: [] }; const requests = [];
page.on('pageerror', error => result.errors.push(error.message));
await page.addInitScript(() => {
  if (!localStorage.getItem('even-reader:preferences:v1')) localStorage.setItem('even-reader:preferences:v1', JSON.stringify({
    ask: { mode: 'provider', provider: 'openai-compatible', baseUrl: 'https://ui-chat.test/v1', model: 'test', apiKey: 'fixture-key' },
  }));
});
await page.route('https://ui-chat.test/**', async route => {
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } });
  requests.push(route.request().postDataJSON());
  await route.fulfill({ json: { choices: [{ message: { content: `Answer ${requests.length}.\n\n` + 'A clear explanation of the paper’s argument and its supporting evidence.\n\n'.repeat(28) } }] }, headers: { 'Access-Control-Allow-Origin': '*' } });
});
const open = async file => {
  await showLibrary(page); await page.locator(`[data-document-id="${file}"] .document-card`).click();
  await expect(page.locator('#ask-open')).toBeEnabled(); if (file.endsWith('.pdf')) await waitForPdfReady(page);
};
async function tab(name) {
  await page.locator(`#tab-${name}`).click();
  await page.locator('#tool-panel').evaluate(el => { for (const pane of el.querySelectorAll('.navigation-content, #search-results')) pane.scrollTop = 10000; });
  await page.locator('.reader-content').evaluate(el => el.scrollTop = el.scrollHeight);
  await page.locator(`#tab-${name}`).click();
  await page.waitForTimeout(80);
  const boxes = await page.evaluate(() => {
    const panel = document.querySelector('#tool-panel').getBoundingClientRect();
    const content = document.querySelector('.reader-content').getBoundingClientRect();
    const tabs = document.querySelector('.reader-sticky').getBoundingClientRect();
    return { top: panel.top, bottom: tabs.bottom, visibleTop: content.top, visibleBottom: content.bottom,
      scroll: [...document.querySelectorAll('#tool-panel .navigation-content, #search-results')].filter(el => el.checkVisibility()).map(el => el.scrollTop) };
  });
  assert(boxes.top >= boxes.visibleTop && boxes.top < boxes.visibleBottom, JSON.stringify(boxes));
  assert(boxes.top >= boxes.bottom - 2, JSON.stringify(boxes)); assert(boxes.top - boxes.bottom < 20, JSON.stringify(boxes));
  assert(boxes.scroll.every(top => top === 0), JSON.stringify(boxes));
}
try {
  await page.goto(vite.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled();
  await page.locator('#file-picker').setInputFiles([
    { name: 'guide.md', mimeType: 'text/markdown', buffer: Buffer.from('# Guide\n\n' + Array.from({ length: 60 }, (_, i) => `## Section ${i}\n\nA passage to read and understand.\n\n`).join('')) },
    { name: 'paper.pdf', mimeType: 'application/pdf', buffer: pdfFixture('annotations') },
  ]);
  for (const [name, width, height] of [['phone', 390, 844], ['small-phone', 320, 568], ['landscape', 844, 390], ['desktop', 1440, 1000], ['narrow-desktop', 1100, 800]]) {
    await page.setViewportSize({ width, height });
    for (const file of ['guide.md', 'paper.pdf']) {
      await open(file);
      const preview = file.endsWith('.pdf') ? '#pdf-passage' : '#passage';
      await page.waitForTimeout(80);
      const size = await page.locator(preview).evaluate(el => {
        const reader = document.querySelector('.reader-content'); const p = el.getBoundingClientRect(), r = reader.getBoundingClientRect();
        return { height: p.height, available: reader.clientHeight, leftGutter: p.left - r.left, rightGutter: r.right - p.right };
      });
      assert(size.height >= 180 && size.height <= Math.max(180, size.available * .6) + 1, JSON.stringify(size));
      assert(size.leftGutter >= 12 && size.rightGutter >= 12, JSON.stringify(size));
      await page.locator('.reader-content').evaluate(el => el.scrollTop = 1);
      const content = await page.locator('.reader-content').boundingBox();
      await page.mouse.move(content.x + 2, content.y + 50); await page.mouse.wheel(0, 160);
      if (await page.locator('.reader-content').evaluate(el => el.scrollHeight > el.clientHeight + 2)) await expect.poll(() => page.locator('.reader-content').evaluate(el => el.scrollTop)).toBeGreaterThan(1);
      await tab('outline'); await tab('search'); await page.locator('#search').fill('passage'); await tab('search'); await tab('bookmarks');
      if (file.endsWith('.pdf')) await tab('pdf');
    }
    await open('guide.md'); await page.locator('#ask-open').click(); await expect(page.locator('#tool-panel')).toBeHidden();
    for (let i = 1; i <= 2; i++) {
      const count = requests.length;
      await page.locator('#ask-question').fill(`Question ${name} ${i}`); await page.locator('#ask-send').click();
      await expect(page.locator('#ask-answer')).toContainText(`Answer ${count + 1}.`);
      await expect(page.locator('#ask-question')).toHaveValue('');
    }
    await expect(page.locator('.ask-message-user').last()).toContainText(`Question ${name} 2`);
    const inputBefore = await page.locator('#ask-form').boundingBox();
    await page.locator('#ask-history').evaluate(el => el.scrollTop = 0); await page.waitForTimeout(80);
    assert.deepEqual(await page.locator('#ask-form').boundingBox(), inputBefore);
    await page.screenshot({ path: path.join(out, `${name}-history.png`) });
    await expect(page.locator('#ask-latest')).toBeVisible(); await page.locator('#ask-latest').click();
    // Even on short screens the main scroller can bring the composer above the dock.
    await page.locator('#ask-question').scrollIntoViewIfNeeded();
    const input = await page.locator('#ask-question').boundingBox(), dock = await page.locator('#reader-controls').boundingBox();
    assert(input.y >= 0 && input.y + input.height <= dock.y + 1, JSON.stringify({ input, dock }));
    assert(await page.locator('#ask-history').evaluate(el => el.clientHeight > 80));
    await page.screenshot({ path: path.join(out, `${name}-chat.png`) });
    await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: path.join(out, `${name}-chat-dark.png`) }); await page.emulateMedia({ colorScheme: 'light' });
    await page.locator('#tab-outline').click(); await expect(page.locator('#ask-panel')).toBeHidden();
    await page.locator('#ask-open').click(); await expect(page.locator('#tool-panel')).toBeHidden();
    const count = await page.locator('.ask-message-user').count();
    await page.reload(); await expect(page.locator('#import')).toBeEnabled(); await open('guide.md'); await page.locator('#ask-open').click();
    await expect(page.locator('.ask-message-user')).toHaveCount(count);
    await open('paper.pdf'); await page.locator('#ask-open').click(); await expect(page.locator('.ask-message-user')).toHaveCount(0);
    result.sizes.push({ name, width, height, tabs: true, previews: true, composer: true, history: true });
  }
  await open('guide.md'); await page.locator('#ask-open').click();
  await page.locator('#ask-history').focus(); await page.locator('#ask-history').press('Home');
  await expect(page.locator('#ask-panel')).toBeVisible();
  await expect.poll(() => page.locator('#ask-history').evaluate(el => el.scrollTop)).toBe(0);
  const before = requests.length; await page.locator('#ask-question').fill('Keyboard'); await page.locator('#ask-question').press('Shift+Enter');
  assert.equal(requests.length, before); await page.locator('#ask-question').press('Enter');
  await expect.poll(() => requests.length).toBe(before + 1);
  assert.deepEqual(result.errors, []); result.passed = true;
} catch (error) { result.failure = error.stack; await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); throw error; }
finally { await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2)); await browser.close(); await vite.close(); }
console.log(JSON.stringify(result));
