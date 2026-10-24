// Exercise the phone UI and glasses SDK text updates with deterministic replies.
// Real speech models and physical BLE timing are outside this UI regression.
import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { showLibrary } from './ui-helpers.mjs';

process.env.PAGEBORNE_ASK_ORIGINS = 'https://history.test';
const out = 'test-results/ask-history'; await mkdir(out, { recursive: true });
const vite = await createServer({ cacheDir: '.state/vite-ask-history', server: { host: '127.0.0.1', port: 0 }, clearScreen: false }); await vite.listen();
const results = [];
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch(engine === chromium ? { executablePath: '/usr/bin/google-chrome', headless: true }
      : { headless: true, ...(process.env.WEBKIT_PATH ? { executablePath: process.env.WEBKIT_PATH } : {}) });
    let page;
    const result = { engine: engine.name(), passed: false, errors: [], physicalGlasses: false }; results.push(result);
    try {
      page = await browser.newPage({ viewport: { width: 440, height: 806 } });
      page.on('pageerror', error => result.errors.push(error.message));
      const storage = new Map(), prompts = [];
      await page.exposeFunction('__storage', ({ method, data }) => method === 'getLocalStorage' ? storage.get(data.key) || '' : (storage.set(data.key, data.value), true));
      await page.addInitScript(() => {
        if (!localStorage.getItem('even-reader:preferences:v1')) localStorage.setItem('even-reader:preferences:v1', JSON.stringify({ ask: { mode: 'provider', provider: 'openai-compatible', baseUrl: 'https://history.test', model: 'fixture' } }));
        const NativeWorker = Worker;
        window.Worker = class {
          constructor(url, options) { if (!String(url).includes('speech-worker')) return new NativeWorker(url, options); }
          postMessage(data) { if (data.operation === 'prepare') queueMicrotask(() => this.onmessage?.({ data: { id: data.id, result: { model: data.model, backend: data.backend } } })); }
          terminate() {}
        };
        window.__body = ''; window.__status = '';
        window.flutter_inappwebview = { async callHandler(_, payload) {
          const m = JSON.parse(payload);
          if (m.method.endsWith('LocalStorage')) return window.__storage(m);
          const texts = m.method === 'textContainerUpgrade' ? [m.data] : m.data?.textObject || [];
          for (const t of texts) {
            if (t.containerName === 'body') window.__body = t.content;
            if (t.containerName === 'status') window.__status = t.content;
          }
          return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
        } };
      });
      await page.route('https://history.test/**', async route => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        prompts.push(route.request().postDataJSON());
        const n = prompts.length;
        await route.fulfill({ headers, json: { choices: [{ message: { content:
          `REPLY${n} start.\n\n${'A detailed explanation that can be scrolled on the glasses. '.repeat(14)}\n\nREPLY${n} end.` } }] } });
      });
      const body = () => page.evaluate(() => window.__body);
      const event = eventType => page.evaluate(eventType => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { sysEvent: { eventType } } })), eventType);
      const openPaper = async name => {
        await showLibrary(page); await page.locator(`[data-document-id="${name}"] .document-card`).click();
        await expect(page.locator('#bookmark')).toBeEnabled();
      };
      const traverse = async direction => {
        await expect(page.locator('#previous')).toHaveAttribute('aria-label', 'Previous conversation page');
        const seen = [await body()], control = page.locator(direction === 1 ? '#previous' : '#next');
        for (let n = 0; n < 100; n++) {
          if (await control.isDisabled()) break;
          const before = await body(); await event(direction); await expect.poll(body).not.toBe(before);
          const frame = await body(); assert(Buffer.byteLength(frame) <= 900); seen.push(frame);
        }
        await expect(control).toBeDisabled(); return seen.join('\n');
      };
      await page.goto(vite.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled();
      await page.locator('#file-picker').setInputFiles(['first', 'second'].map(name => ({ name: `${name}.md`, mimeType: 'text/markdown', buffer: Buffer.from(`# ${name}\n\nA passage to read.`) })));
      await openPaper('first.md'); await page.locator('#ask-open').click();
      for (let i = 1; i <= 6; i++) {
        await page.locator('#ask-question').fill(`QUESTION${i}`); await page.locator('#ask-send').click();
        await expect(page.locator('#ask-answer')).toContainText(`REPLY${i} end.`);
        await expect.poll(body).toContain(`REPLY${i} end.`);
      }
      assert.doesNotMatch(await page.evaluate(() => window.__status), /Swipe|\d+\/\d+/);
      const tail = await body();
      await page.locator('#preview').screenshot({ path: `${out}/${engine.name()}-tail.png` });
      await event(9); await expect.poll(() => page.evaluate(() => window.__status)).toContain('Listening');
      await expect.poll(body).toBe(tail.split('\n').slice(-8).join('\n'));
      await page.locator('#preview').screenshot({ path: `${out}/${engine.name()}-recording-tail.png` });
      await event(3); await expect.poll(body).toBe(tail);
      await event(1); await expect.poll(body).not.toBe(tail); const older = await body();
      await event(9); await expect.poll(() => page.evaluate(() => window.__status)).toContain('Listening');
      await expect.poll(body).toBe(older.split('\n').slice(0, 8).join('\n'));
      await event(3); await expect.poll(body).toBe(older);
      result.recordingMovesFollowedTail = true; result.recordingPreservesScrolledView = true;
      const backward = await traverse(1), forward = await traverse(2);
      for (let i = 1; i <= 6; i++) {
        assert(backward.includes(`QUESTION${i}`)); assert(forward.includes(`QUESTION${i}`));
        assert(forward.includes(`REPLY${i} start.`)); assert(forward.includes(`REPLY${i} end.`));
      }
      assert(!backward.includes('\nYou\n')); assert(!forward.includes('\nAssistant\n'));
      const alignment = await page.locator('.ask-message-text').evaluateAll(els => els.map(el => ({role:el.parentElement.className, align:getComputedStyle(el).textAlign, maxWidth:getComputedStyle(el.parentElement).maxWidth})));
      assert(alignment.every(item => item.align === (item.role.includes('user') ? 'right' : 'left')));
      assert(alignment.every(item => item.maxWidth === '92%'));
      const oldBody = await body(); await event(1); await expect.poll(body).not.toBe(oldBody); const place = await body();
      await event(0); await expect(page.locator('#ask-panel')).toBeHidden();
      await page.locator('#ask-open').click(); await expect.poll(body).toBe(place);
      await event(0); await openPaper('second.md'); await page.locator('#ask-open').click();
      await expect(page.locator('.ask-message')).toHaveCount(0); await expect.poll(body).toContain('Hold to speak');
      await event(0); await openPaper('first.md'); await page.locator('#ask-open').click();
      await expect.poll(body).toBe(place);
      await page.reload(); await expect(page.locator('#import')).toBeEnabled(); await openPaper('first.md');
      await page.locator('#ask-open').click(); await expect(page.locator('.ask-message')).toHaveCount(12);
      await expect.poll(body).toContain('REPLY6 end.');
      assert((await traverse(1)).includes('QUESTION1'));
      assert.equal(prompts.length, 6, 'Navigation and reload must not submit messages');
      assert.deepEqual(result.errors, []);
      await page.screenshot({ path: `${out}/${engine.name()}-history.png`, fullPage: true });
      Object.assign(result, { passed: true, fullRetainedHistory: true, longAnswers: true, sdkSwipes: true, returnToPlace: true, paperIsolation: true, reload: true, prompts: prompts.length });
    } catch (error) {
      result.failure = error.stack;
      await page?.screenshot({ path: `${out}/${engine.name()}-failure.png`, fullPage: true }).catch(() => {});
      throw error;
    } finally { await browser.close(); }
  }
} finally { await vite.close(); await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2)); }
console.log(JSON.stringify(results));
