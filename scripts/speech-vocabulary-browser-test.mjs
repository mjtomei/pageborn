// Exercise actual reading-position -> dictation wiring with controlled model
// responses. Checks the visible hint list against the actual Tiny worker request.
import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { showLibrary, showSettings, hideSettings, backToReading } from './ui-helpers.mjs';

const server = await createServer({ cacheDir: '.state/vite-vocabulary', clearScreen: false, server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const origin = new URL(server.resolvedUrls.local[0]).origin;
const results = [];
try {
  for (const [engine, type, options] of [
    ['Chrome', chromium, { executablePath: '/usr/bin/google-chrome' }],
    ['WebKit', webkit, { executablePath: process.env.WEBKIT_PATH }],
  ]) {
    const browser = await type.launch({ headless: true, ...options });
    try {
      const page = await browser.newPage({ viewport: { width: 440, height: 806 } });
      const errors = [], unexpected = [], storage = new Map();
      page.on('pageerror', error => errors.push(error.message));
      await page.exposeFunction('__storage', ({ method, data }) => method === 'getLocalStorage' ? storage.get(data.key) || '' : (storage.set(data.key, data.value), true));
      await page.addInitScript(() => {
        const NativeWorker = Worker;
        window.__vocabularies = []; window.__speechPrepares = 0;
        window.Worker = class {
          constructor(url, options) { if (!String(url).includes('speech-worker')) return new NativeWorker(url, options); }
          postMessage(data) {
            if (data.operation === 'cancel') return;
            if (data.operation === 'prepare') window.__speechPrepares++;
            const result = { model: data.model, backend: data.backend, loadMs: 0 };
            if (data.operation === 'transcribe') {
              window.__vocabularies.push([...data.vocabulary]);
              Object.assign(result, { text: 'A question about this passage.', words: [], seconds: .2, transcribeMs: 1 });
            }
            setTimeout(() => this.onmessage?.({ data: { id: data.id, result } }), 0);
          }
          terminate() {}
        };
        window.flutter_inappwebview = { async callHandler(_, payload) {
          const message = JSON.parse(payload);
          if (message.method.endsWith('LocalStorage')) return window.__storage(message);
          return ['createStartUpPageContainer', 'updateImageRawData'].includes(message.method) ? 0 : true;
        } };
      });
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
        unexpected.push(url.origin); return route.abort();
      });
      await page.goto(origin); await expect(page.locator('#import')).toBeEnabled();
      const popup = page.locator('dialog:has(#speech-vocabulary-preview)');
      const hints = id => page.locator(id).inputValue().then(value => value ? value.split('\n') : []);
      const inspect = async () => { await showSettings(page); await page.locator('#speech-vocabulary-show').click(); await expect(popup).toBeVisible(); return hints('#speech-vocabulary-preview'); };
      const closeHints = async () => { await popup.getByRole('button', { name: 'Close', exact: true }).click(); await hideSettings(page); };
      await showSettings(page); await page.locator('#speech-vocabulary').fill('JEV, O’Connor'); await page.locator('#speech-vocabulary').blur();
      assert.deepEqual(await inspect(), ['JEV', "O'Connor"]);
      await expect(page.locator('#speech-vocabulary-last-status')).toContainText('No local transcription');
      assert.equal(await page.evaluate(() => window.__speechPrepares), 0, 'inspecting hints does not load speech models');
      await page.keyboard.press('Escape'); await expect(popup).toBeHidden(); await expect(page.locator('#speech-vocabulary-show')).toBeFocused(); await hideSettings(page);
      const text = '# Vocabulary\n\nqubit\n\n' + ('the and there are words here. '.repeat(15) + '\n\n').repeat(30) + 'axion\n';
      await page.locator('#file-picker').setInputFiles({ name: 'vocabulary.md', mimeType: 'text/markdown', buffer: Buffer.from(text) });
      await showLibrary(page); await page.locator('[data-document-id="vocabulary.md"] .document-card').click();
      const capture = async () => {
        const before = await page.evaluate(() => window.__vocabularies.length);
        await page.locator('#ask-open').click(); await page.locator('#ask-voice').click();
        await expect(page.locator('#ask-status')).toContainText('Listening');
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { audioEvent: { audioPcm: new Uint8Array(6400), source: 'glasses' } } })));
        await page.locator('#ask-voice').click();
        await expect(page.locator('#ask-review-cancel')).toBeVisible();
        await expect(page.locator('#ask-question')).toHaveValue('A question about this passage.');
        await expect.poll(() => page.evaluate(() => window.__vocabularies.length)).toBeGreaterThan(before);
        const requests = await page.evaluate(start => window.__vocabularies.slice(start), before);
        assert(requests.length >= 1); for (const words of requests) assert.deepEqual(words, requests[0]);
        await page.locator('#ask-review-cancel').click(); await backToReading(page);
        return requests[0];
      };
      const preview = await inspect(); await closeHints();
      const first = await capture(); assert.deepEqual(first, preview, 'visible list exactly matches the worker request'); assert.equal(first[0], 'JEV'); assert(first.includes('qubit')); assert(!first.includes('axion'));
      await page.locator('#position').evaluate(input => { input.value = '1000'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
      await expect(page.locator('#position-value')).toHaveText('100%');
      const moved = await inspect(); assert(moved.includes('axion')); assert(!moved.includes('qubit'));
      await page.locator('#speech-vocabulary-last summary').click(); assert.deepEqual(await hints('#speech-vocabulary-last-terms'), first, 'last-used snapshot is not recalculated after moving');
      await page.locator('#font-size').evaluate(el => { el.value = '26'; el.dispatchEvent(new Event('change')); });
      assert(await popup.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'popup fits at large app text size');
      await mkdir('test-results/speech-vocabulary', { recursive: true });
      await popup.screenshot({ path: `test-results/speech-vocabulary/${engine}-hints.png` });
      await closeHints();
      const last = await capture(); assert.deepEqual(last, moved); assert.equal(last[0], 'JEV'); assert(last.includes('axion')); assert(!last.includes('qubit'));
      await showSettings(page); await page.locator('#speech-context-vocabulary').uncheck(); await hideSettings(page);
      assert.deepEqual(await inspect(), ['JEV', "O'Connor"]); await closeHints();
      assert.deepEqual(await capture(), ['JEV', "O'Connor"]);
      await showSettings(page); await page.locator('#speech-backend').selectOption('remote');
      assert.deepEqual(await inspect(), []); await expect(page.locator('#speech-vocabulary-source')).toContainText('None are sent to the speech provider');
      assert.deepEqual(await hints('#speech-vocabulary-last-terms'), ['JEV', "O'Connor"]); await closeHints();
      assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
      results.push({ engine, passed: true, movedWithReadingPosition: true, previewMatchesWorker: true, lastTranscriptionSnapshot: true, noModelLoadForPreview: true, remoteDoesNotSendHints: true, manualPriority: true, contextToggle: true, offline: true });
    } finally { await browser.close(); }
  }
} finally {
  await mkdir('test-results/speech-vocabulary', { recursive: true });
  await writeFile('test-results/speech-vocabulary/results.json', JSON.stringify(results, null, 2));
  await server.close();
}
console.log(JSON.stringify(results, null, 2));
