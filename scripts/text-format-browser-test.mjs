// Exercise file import, native frames and the web reader with identical TXT/MD
// originals. Speech/desktop IO is mocked; source bytes must survive reopening.
import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { displayProbe } from './display-probe.mjs';
import { showLibrary } from './ui-helpers.mjs';

const content = ['# Wrapped reading', '', 'This sentence continues',
  'across a source line, with **emphasis** intact.', '', 'A second paragraph stays separate.', '',
  '- First item', '- Second item', '', '```text', 'first code line', 'second code line', '```', '',
  '## Later section', '', 'Another paragraph for reading.'].join('\r\n');
const out = 'test-results/text-format'; await mkdir(out, { recursive: true });
const reports = [];
try {
  for (const platform of ['glasses', 'web']) {
    const server = await createServer({ mode: platform === 'web' ? 'web' : 'release', plugins: [displayProbe(), {
      name: 'text-fixtures', transform(code, id) {
        if (id.endsWith('/src/speech-setup.js')) return code.replace('start(initialize) {', 'start(initialize) { this.blocked = false; return Promise.resolve();');
      }, configureServer(vite) {
        vite.middlewares.use('/web/config', (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{}'); });
      },
    }], cacheDir: `.state/vite-text-format-${platform}`, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, clearScreen: false });
    await server.listen();
    try { for (const engine of process.env.TEXT_FORMAT_BROWSER === 'chromium' ? [chromium] : [chromium, webkit]) {
      const browser = await engine.launch({ headless: true, executablePath: engine === chromium ? '/usr/bin/google-chrome' : process.env.WEBKIT_PATH });
      const page = await browser.newPage({ viewport: { width: 440, height: 806 } });
      const report = { platform, engine: engine.name(), errors: [], passed: false }; reports.push(report);
      page.on('pageerror', error => report.errors.push(error.message));
      try {
        if (platform === 'glasses') {
          const values = new Map();
          await page.exposeFunction('__storage', ({ method, data }) => method === 'getLocalStorage' ? values.get(data.key) || '' : (values.set(data.key, data.value), true));
          await page.addInitScript(() => {
            window.__body = '';
            window.flutter_inappwebview = { async callHandler(_, payload) {
              const m = JSON.parse(payload);
              if (m.method.endsWith('LocalStorage')) return window.__storage(m);
              for (const box of m.method === 'textContainerUpgrade' ? [m.data] : m.data?.textObject || []) {
                if (box.containerName === 'body') window.__body = box.content;
                if (new TextEncoder().encode(box.content).length >= 1000) throw Error('Native text exceeds firmware limit');
              }
              return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
            } };
          });
        }
        const nativeRows = () => page.evaluate(() => window.__displayFrame?.layout?.rows.map(r => ({ text: r.text, sourceLine: r.sourceLine, kind: r.kind })));
        const open = async id => {
          await page.evaluate(() => { window.__previousTextLayout = window.__displayFrame?.layout; window.__previousProse = document.querySelector('.web-prose'); });
          await showLibrary(page);
          await page.locator(`[data-document-id="${id}"] .document-card`).click();
          await expect(page.locator('#doc-path')).toHaveText(id);
          if (platform === 'glasses') {
            await expect.poll(() => page.evaluate(() => !!window.__displayFrame?.layout && !window.__displayFrame.picker
              && window.__displayFrame.layout !== window.__previousTextLayout)).toBe(true);
            await expect.poll(() => page.evaluate(() => window.__body)).toContain('Wrapped reading');
          } else {
            await expect.poll(() => page.evaluate(() => !!document.querySelector('.web-prose') && document.querySelector('.web-prose') !== window.__previousProse)).toBe(true);
            await expect(page.locator('.web-prose h1')).toHaveText('Wrapped reading');
          }
        };
        await page.goto(server.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled();
        for (const ext of ['md', 'txt']) {
          await page.locator('#file-picker').setInputFiles({ name: `wrapped.${ext}`, mimeType: ext === 'txt' ? 'text/plain' : 'text/markdown', buffer: Buffer.from(content) });
          await expect(page.locator(`[data-document-id="wrapped.${ext}"]`)).toBeVisible();
        }
        await open('wrapped.md');
        const expected = platform === 'glasses' ? await nativeRows() : await page.locator('.web-prose').innerHTML();
        await open('wrapped.txt');
        if (platform === 'glasses') {
          await expect.poll(nativeRows).toEqual(expected);
          const text = await page.evaluate(() => window.__body);
          assert.match(text, /This sentence continues across/);
          assert.match(text, /intact\.\n\nA second paragraph/);
          assert(expected.some(r => r.text === 'first code line' && r.kind === 'code'));
          assert(expected.some(r => r.text === 'second code line' && r.kind === 'code'));
        } else {
          await expect.poll(() => page.locator('.web-prose').innerHTML()).toBe(expected);
          await expect(page.locator('.web-prose p').first()).toHaveText('This sentence continues across a source line, with emphasis intact.');
          await expect(page.locator('.web-prose strong')).toHaveText('emphasis');
          await expect(page.locator('.web-prose li')).toHaveCount(2);
          await expect(page.locator('.web-prose pre')).toHaveText('first code line\nsecond code line\n');
        }
        await page.waitForTimeout(700); await page.reload(); await expect(page.locator('#import')).toBeEnabled();
        await open('wrapped.txt');
        if (platform === 'glasses') await expect.poll(nativeRows).toEqual(expected);
        else await expect.poll(() => page.locator('.web-prose').innerHTML()).toBe(expected);
        const stored = await page.evaluate(async platform => {
          if (platform === 'web') {
            const { LocalLibrary } = await import('/src/library.js');
            return (await new LocalLibrary().read()).documents.map(doc => doc.content);
          }
          const { AtomicPhoneValue, readChunks } = await import('/src/phone-storage.js');
          const kv = { get: key => window.__storage({ method: 'getLocalStorage', data: { key } }) };
          const catalog = await new AtomicPhoneValue(kv, 'library').read();
          return Promise.all(catalog.documents.map(doc => readChunks(kv, doc.body)));
        }, platform);
        assert.deepEqual(stored, [content, content]); assert.deepEqual(report.errors, []);
        await page.screenshot({ path: `${out}/${platform}-${engine.name()}.png` });
        report.passed = true;
      } catch (error) { report.failure = error.stack; await page.screenshot({ path: `${out}/${platform}-${engine.name()}-failure.png` }); throw error; }
      finally { await browser.close(); }
    } } finally { await server.close(); }
  }
} finally { await writeFile(`${out}/results.json`, JSON.stringify(reports, null, 2)); }
console.log(JSON.stringify(reports));
