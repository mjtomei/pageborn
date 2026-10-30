// Exercise the real IndexedDB migration/transactions and delayed native storage.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { PhoneLibrary } from '../src/phone-storage.js';
import { readLocalFile } from '../src/library.js';
import { displayProbe } from './display-probe.mjs';
import { showLibrary } from './ui-helpers.mjs';

const out = 'test-results/library-storage'; await mkdir(out, { recursive: true });
const server = await createServer({ mode: 'release', plugins: [displayProbe(), {
  name: 'storage-fixtures', transform(code, id) {
    if (id.endsWith('/src/speech-setup.js')) return code.replace('start(initialize) {', 'start(initialize) { this.blocked = false; return Promise.resolve();');
  }, configureServer(vite) {
    vite.middlewares.use('/storage-fixture', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Storage test</title>'); });
  },
}], cacheDir: '.state/vite-library-storage', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, clearScreen: false });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
const report = { passed: false, errors: [] };
try {
  const page = await browser.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  const base = server.resolvedUrls.local[0]; await page.goto(base + 'storage-fixture');
  report.browserStorage = await page.evaluate(async () => {
    const { LocalLibrary, readLocalFile } = await import('/src/library.js');
    const old = { server: 'https://old.example', documents: [
      { id: 'old.md', title: 'Old', bytes: 12, words: 2, content: '# Saved text', addedAt: 123 },
    ] };
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('even-reader', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('data');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    let oldTabClosed = false; db.onversionchange = () => { oldTabClosed = true; db.close(); };
    await new Promise((resolve, reject) => {
      const tx = db.transaction('data', 'readwrite'); tx.objectStore('data').put(old, 'snapshot'); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
    });
    const a = new LocalLibrary({ lazy: true }), b = new LocalLibrary({ lazy: true });
    const reads = [], get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) { reads.push(key); return get.call(this, key); };
    const check = (condition, message) => { if (!condition) throw Error(message); };
    const migrated = await a.read();
    check(oldTabClosed, 'old-version tab closed before migration');
    check(migrated.documents[0].positionKey === 'https://old.example\nold.md', 'position identity');
    check(!('content' in migrated.documents[0]), 'metadata only');
    check(!reads.some(key => key.startsWith('document:')), 'no body reads at startup');
    check((await a.loadDocument(migrated.documents[0])).content === '# Saved text', 'legacy body');
    reads.length = 0; await b.read();
    check(!reads.some(key => key.startsWith('document:')), 'no eager reads after migration');
    const doc = await readLocalFile(new File(['parallel body'], 'same.txt'));
    await Promise.all([a.save(doc), b.save(doc)]);
    const saved = await a.read();
    check(saved.documents.map(doc => doc.id).join('|') === 'old.md|same.txt|same (2).txt', 'concurrent tabs retain both imports');
    const expected = saved.documents[0];
    await b.put(await readLocalFile(new File(['new body'], 'old.md')), expected);
    let refused = false;
    try { await a.put(await readLocalFile(new File(['stale'], 'old.md')), expected); } catch { refused = true; }
    check(refused, 'stale tab write refused');
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) { if (key === 'document:fail.txt') throw new DOMException('full', 'QuotaExceededError'); return put.call(this, value, key); };
    let quota = false;
    try { await a.save(await readLocalFile(new File(['failed'], 'fail.txt'))); } catch (error) { quota = error.name === 'QuotaExceededError'; }
    IDBObjectStore.prototype.put = put;
    check(quota, 'quota error surfaced');
    const final = await b.read();
    check(final.documents.length === 3, 'failed save leaves catalog unchanged');
    check((await b.loadDocument(final.documents[0])).content === 'new body', 'other tab update preserved');
    check((await new LocalLibrary().read()).documents.every(doc => typeof doc.content === 'string'), 'legacy full-read API works');
    Object.defineProperty(crypto, 'subtle', { value: undefined, configurable: true });
    try {
      await a.save(await readLocalFile(new File(['plain HTTP still imports'], 'http.txt')));
      const http = (await a.read()).documents.find(doc => doc.id === 'http.txt');
      check((await a.loadDocument(http)).content === 'plain HTTP still imports', 'imports work without secure-context hashing');
    } finally { delete crypto.subtle; }
    return { migration: true, oldTabClosed: true, lazyStartup: true, concurrentTabs: true, staleWrites: true, failedSaveAtomic: true, insecureContextImport: true };
  });
  await page.close();
  const context = await browser.newContext({ viewport: { width: 440, height: 806 } });
  const values = new Map(), reads = []; let held, release;
  const kv = { get: async key => values.get(key) || '', set: async (key, value) => { values.set(key, value); } };
  const phone = new PhoneLibrary(kv, { lazy: true }); await phone.read();
  for (const name of ['slow', 'fast']) await phone.save(await readLocalFile(new File([`# ${name}\n\n${name} document text. `.repeat(3000)], `${name}.txt`)));
  const slow = phone.snapshot.documents.find(doc => doc.id === 'slow.txt');
  await context.exposeFunction('__storage', async ({ method, data }) => {
    if (method === 'setLocalStorage') return values.set(data.key, data.value), true;
    reads.push(data.key);
    if (data.key === slow.revision + ':0' && !held) { held = true; await new Promise(resolve => release = resolve); }
    return kv.get(data.key);
  });
  await context.addInitScript(() => {
    window.flutter_inappwebview = { async callHandler(_, payload) {
      const m = JSON.parse(payload);
      if (m.method.endsWith('LocalStorage')) return window.__storage(m);
      return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
    } };
  });
  const ui = await context.newPage(); ui.on('pageerror', error => report.errors.push(error.message));
  await ui.goto(base); await expect(ui.locator('#import')).toBeEnabled();
  assert(!reads.some(key => key.includes(':doc:')), 'native startup reads no bodies');
  await ui.locator('[data-document-id="slow.txt"] .document-card').click();
  await expect.poll(() => !!held).toBe(true);
  await expect(ui.locator('#ask-open')).toBeDisabled();
  await showLibrary(ui); await ui.locator('[data-document-id="fast.txt"] .document-card').click();
  release();
  await expect.poll(() => ui.evaluate(() => window.__displayFrame?.layout?.blocks?.some(block => block.text?.includes('fast')))).toBe(true);
  assert.equal(reads.filter(key => key.startsWith(slow.revision + ':')).length, 1, 'stale selection stops between chunks');
  await expect(ui.locator('#doc-path')).toHaveText('fast.txt');
  const activeId = await ui.evaluate(() => JSON.parse(localStorage.getItem('even-reader:preferences:v1')).selected.id);
  assert.equal(activeId, 'fast.txt');
  await ui.locator('#next').click();
  await expect.poll(() => ui.locator('#position').inputValue()).not.toBe('0');
  const position = await ui.locator('#position').inputValue();
  await ui.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await ui.waitForTimeout(700);
  reads.length = 0; await ui.reload(); await expect(ui.locator('#import')).toBeEnabled();
  await expect.poll(() => ui.evaluate(() => window.__displayFrame?.layout?.blocks?.some(block => block.text?.includes('fast')))).toBe(true);
  assert(!reads.some(key => key.startsWith(slow.revision + ':')), 'reload opens only the selected original');
  await expect(ui.locator('#position')).toHaveValue(position);
  report.nativeStorage = { textPositionRestored: true, lazyStartup: true, cancelSelection: true, askBlockedDuringLoad: true, selectedOnlyOnReload: true };
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.failure = error.stack; throw error; }
finally { await writeFile(`${out}/results.json`, JSON.stringify(report, null, 2)); await browser.close(); await server.close(); }
console.log(JSON.stringify(report));
