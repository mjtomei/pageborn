import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';
import { showLibrary, showTool, hideSettings } from './ui-helpers.mjs';

const out = path.resolve('test-results/build-profiles'); await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const servers = []; const result = { speech: 'mocked setup; real ensemble covered separately', passed: false, errors: [] }; const phoneStorage = new Map();
const diagnosticsKey = 'even-reader:diagnostics:v1';
const stale = JSON.stringify({ startedAt: 'older-debug-run', errors: [], marker: 'preserve-old-debug-log-without-reading' });
let page;
try {
  for (const [channel, folder] of [['debug', 'dist'], ['release', 'dist-release']]) {
    const build = JSON.parse(await readFile(path.join(folder, 'build-info.json'), 'utf8'));
    assert.equal(build.channel, channel); assert.equal(build.diagnostics, channel === 'debug');
    const server = createApp({ distDir: path.resolve(folder) }).listen(0, '127.0.0.1'); servers.push(server);
    await new Promise(r => server.once('listening', r));
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route('**/api/**', route => route.fulfill({ status: route.request().method() === 'OPTIONS' ? 204 : 404, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' }, body: '' }));
    const storageCalls = []; const logs = [];
    await context.exposeFunction('__phoneStorage', m => {
      // This test covers build isolation and reading; speech is exercised with
      // real weights in speech-ensemble-browser-test.mjs.
      if (m.method === 'getLocalStorage' && /^pageborne:models:v1:[a-f0-9]{64}$/.test(m.data.key)) return JSON.stringify({ id: 'fixture', chunks: 1, headers: {} });
      if (m.data.key.includes('diagnostics')) storageCalls.push({ method: m.method, key: m.data.key });
      if (m.method === 'getLocalStorage') return phoneStorage.get(m.data.key) || '';
      phoneStorage.set(m.data.key, m.data.value); return true;
    });
    await context.addInitScript(({ key, previous }) => {
      const NativeWorker = window.Worker;
      window.Worker = class {
        constructor(url, options) { if (!String(url).includes('ensemble-worker')) return new NativeWorker(url, options); }
        postMessage(data) { if (data.operation === 'prepare') queueMicrotask(() => this.onmessage({ data: { id: data.id, result: { backend: 'wasm', verified: true } } })); }
        terminate() {}
      };
      localStorage.setItem(key, previous); window.__diagnosticStorage = []; window.__frames = [];
      for (const method of ['getItem', 'setItem']) {
        const original = Storage.prototype[method];
        Storage.prototype[method] = function(...args) {
          if (args[0] === key) window.__diagnosticStorage.push(method);
          return original.apply(this, args);
        };
      }
      window.flutter_inappwebview = { async callHandler(_, payload) {
        const m = JSON.parse(payload);
        if (m.method.endsWith('LocalStorage')) return window.__phoneStorage(m);
        if (['createStartUpPageContainer', 'rebuildPageContainer', 'textContainerUpgrade', 'updateImageRawData'].includes(m.method)) window.__frames.push(m.method);
        return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
      } };
    }, { key: diagnosticsKey, previous: stale });
    page = await context.newPage(); page.on('pageerror', e => result.errors.push(e.message));
    page.on('console', m => { if (m.text().startsWith('[even-reader]')) logs.push(m.text()); });
    const nativeBefore = [...phoneStorage].filter(([k]) => k.includes('diagnostics'));
    await page.goto(`http://127.0.0.1:${server.address().port}`); await expect(page.locator('#import')).toBeEnabled();
    await expect(page.locator('#connection-state')).toHaveText('Connected');
    await expect(page.locator('#app-version')).toContainText(channel);
    assert.equal(await page.locator('#brightness-test, #brightness-dialog').count(), 0);
    if (channel === 'release') {
      assert(nativeBefore.length > 0, 'debug run generated a phone backup to test release isolation');
      assert.equal(await page.locator('#debug-export, #error-export, #debug-dialog, #speech-setup-export').count(), 0);
    }
    await showTool(page, 'settings');
    if (build.automaticTerminal) {
      await expect(page.locator('#ask-connection-settings')).toBeHidden();
      await expect(page.locator('#ask-settings-link')).toBeHidden();
      await expect(page.locator('#ask-token')).toHaveValue('');
    } else {
      await page.locator('#ask-mode').selectOption('terminal');
      await expect(page.locator('#ask-pairing-import')).toBeVisible();
    }
    await hideSettings(page);
    await showLibrary(page);
    await page.locator('#file-picker').setInputFiles([
      { name: `${channel}.md`, mimeType: 'text/markdown', buffer: Buffer.from('# Readable\n\n' + 'Reading still works without diagnostic logs. '.repeat(600)) },
      { name: `${channel}.pdf`, mimeType: 'application/pdf', buffer: pdfFixture() },
      { name: `${channel}-broken.pdf`, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nnot a document\n%%EOF') },
    ]);
    await expect(page.locator(`[data-document-id="${channel}.md"] .document-card`)).toBeVisible();
    await page.locator(`[data-document-id="${channel}.md"] .document-card`).click();
    await expect(page.locator('#bookmark')).toBeEnabled();
    const start = await page.locator('#position').inputValue();
    await page.locator('#next').click(); await expect(page.locator('#position')).not.toHaveValue(start);
    await page.locator('#preview').click(); // Preview gestures must tolerate the missing debug dialog.
    await showTool(page, 'settings'); await page.keyboard.press('Escape');
    await expect(page.locator('#library-panel')).toBeHidden();
    await showLibrary(page); await page.locator(`[data-document-id="${channel}.pdf"] .document-card`).click();
    await expect(page.locator('#bookmark')).toBeEnabled({ timeout: 30000 });
    await expect(page.locator('#pdf-passage')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__frames.length)).toBeGreaterThan(2);
    await showLibrary(page); await page.locator(`[data-document-id="${channel}-broken.pdf"] .document-card`).click();
    await expect(page.locator('#notice')).toContainText('Could not open PDF');
    if (channel === 'debug') {
      await page.locator('#error-export').click();
      const report = JSON.parse(await page.locator('#debug-text').inputValue());
      assert(report.errors.some(e => e.type === 'pdf-open-error'));
      assert(logs.length > 0); assert(storageCalls.length > 0);
      await expect.poll(() => [...phoneStorage.keys()].some(k => k.includes('diagnostics'))).toBe(true);
    } else {
      assert.deepEqual(storageCalls, []); assert.deepEqual(logs, []);
      assert.deepEqual(await page.evaluate(() => window.__diagnosticStorage), []);
      assert.equal(await page.evaluate(key => localStorage.getItem(key), diagnosticsKey), stale);
      assert.deepEqual([...phoneStorage].filter(([k]) => k.includes('diagnostics')), nativeBefore);
    }
    await page.screenshot({ path: path.join(out, `${channel}.png`) });
    result[channel] = { reading: true, pdfErrorsVisible: true, qrImportAvailable: !build.automaticTerminal, automaticTerminal: build.automaticTerminal,
      diagnostics: channel === 'debug', logExports: channel === 'debug', phoneDiagnosticCalls: storageCalls.length };
    await context.close();
  }
  assert.deepEqual(result.errors, []); result.passed = true;
} catch (error) {
  result.failure = error.stack; await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); throw error;
} finally {
  await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
  await browser.close();
  for (const server of servers) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
}
console.log(JSON.stringify(result));
