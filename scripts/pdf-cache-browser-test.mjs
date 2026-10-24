import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { access, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';
import { waitForPdfReady, showLibrary, showTool } from './ui-helpers.mjs';

const dir = path.resolve(process.env.CACHE_RESULTS || 'test-results/pdf-cache'); await mkdir(dir, { recursive: true });
const server = createApp({ distDir: path.resolve('dist') }).listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const cache = path.join(os.homedir(), '.cache/ms-playwright');
const cached = (await readdir(cache).catch(() => [])).filter(name => /^chromium-\d+$/.test(name));
const candidates = [process.env.CHROME_PATH, chromium.executablePath(), ...cached.flatMap(name => [path.join(cache, name, 'chrome-linux/chrome'), path.join(cache, name, 'chrome-linux64/chrome')])].filter(Boolean);
const executablePath = (await Promise.all(candidates.map(async file => { try { await access(file); return file; } catch { return null; } }))).find(Boolean);
const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
const page = await context.newPage(); const result = { passed: false, errors: [] };
page.on('pageerror', error => result.errors.push(error.message));
const diagnostic = () => page.evaluate(() => JSON.parse(localStorage.getItem('even-reader:diagnostics:v1')));
const ready = () => waitForPdfReady(page, 30000);
const cacheData = async action => page.evaluate(async action => {
  const db = await new Promise((resolve, reject) => { const req = indexedDB.open('even-reader', 1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  return new Promise((resolve, reject) => {
    const tx = db.transaction('data', action === 'damage' ? 'readwrite' : 'readonly'); const store = tx.objectStore('data'); let result = []; let changed = false;
    const request = store.openCursor();
    request.onsuccess = () => { const cursor = request.result; if (!cursor) return;
      if (String(cursor.key).includes(':pdf-cache:body:') && cursor.value) {
        result.push(cursor.key); if (action === 'damage' && !changed) { cursor.update('truncated'); changed = true; }
      }
      cursor.continue();
    };
    tx.oncomplete = () => { db.close(); resolve(result); }; tx.onerror = () => reject(tx.error);
  });
}, action);
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`); await expect(page.locator('#import')).toBeEnabled();
  await page.locator('#file-picker').setInputFiles({ name: 'mixed.pdf', mimeType: 'application/pdf', buffer: pdfFixture() });
  await showLibrary(page); await page.locator('[data-document-id="mixed.pdf"] .document-card').click(); await ready();
  assert.equal((await diagnostic()).pdf.cached, false); assert.equal((await diagnostic()).counts['pdf-cache-saved'], 1);
  await showTool(page, 'search'); await page.locator('#search').fill('FigureStart'); await page.locator('#search-results button').first().click();
  await expect.poll(async () => Number(await page.locator('#position').inputValue())).toBeGreaterThan(0);
  const position = await page.locator('#position').inputValue();
  await page.waitForTimeout(250);
  const before = await page.locator('#preview').evaluate(canvas => canvas.toDataURL());
  await page.reload(); await ready();
  assert.equal((await diagnostic()).pdf.cached, true);
  assert.equal((await diagnostic()).counts['pdf-cache-hit'], 1);
  await expect(page.locator('#position')).toHaveValue(position);
  await expect.poll(() => page.locator('#preview').evaluate(canvas => canvas.toDataURL())).toBe(before);
  result.figurePixelsAndPositionPreserved = true;
  await showTool(page, 'pdf'); await page.locator('#pdf-margin-notes').check(); await ready();
  assert.equal((await diagnostic()).pdf.cached, false, 'formatting settings invalidate preparation');
  await page.reload(); await ready(); assert.equal((await diagnostic()).pdf.cached, true);
  result.changedSettingsPrepareOnce = true;
  assert.ok((await cacheData('damage')).length);
  await page.reload(); await ready();
  assert.equal((await diagnostic()).pdf.cached, false, 'corrupt preparation is rebuilt from the original file');
  assert.equal((await diagnostic()).counts['pdf-cache-read-error'], 1);
  await page.reload(); await ready(); assert.equal((await diagnostic()).pdf.cached, true);
  result.corruptCacheRepaired = true;
  await showLibrary(page);
  await page.locator('[data-document-id="mixed.pdf"] .document-delete').click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('#doc-count')).toHaveText('0');
  assert.equal((await cacheData('read')).length, 0, 'deleting a PDF clears preparation chunks');
  result.deleteClearsCache = true;
  await page.locator('#file-picker').setInputFiles({ name: 'mixed.pdf', mimeType: 'application/pdf', buffer: pdfFixture('table') });
  await page.locator('[data-document-id="mixed.pdf"] .document-card').click(); await ready();
  assert.equal((await diagnostic()).pdf.cached, false);
  await showTool(page, 'search'); await page.locator('#search').fill('Row0Label'); await expect(page.locator('#search-results button').first()).toContainText('Row0Label');
  result.sameFilenameGetsNewContent = true;
  assert.deepEqual(result.errors, []); result.passed = true;
  console.log('PASS: cached image pixels/positions, setting invalidation, corruption recovery, deletion and same-name replacement.');
} catch (error) { result.error = error.stack; result.diagnostic = await diagnostic().catch(() => null); throw error; }
finally { await writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2)); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
