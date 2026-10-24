import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import QRCode from 'qrcode';
import { createServer } from 'vite';
import { showTool } from './ui-helpers.mjs';

const dir = path.resolve('test-results/ask-pairing'); await mkdir(dir, { recursive: true });
const requests = []; const token = 'qr-test+token/with=encoded&characters';
const app = express();
app.use((req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  requests.push({ url: req.url, authorization: req.get('authorization') }); next();
});
app.get('/api/info', (req, res) => req.get('authorization') === `Bearer ${token}` ? res.json({ provider: req.query.provider }) : res.sendStatus(401));
const api = app.listen(0, '127.0.0.1'); await new Promise(r => api.once('listening', r));
const endpoint = `http://127.0.0.1:${api.address().port}`;
const pairing = endpoint + '/?' + new URLSearchParams({ token, defaultProvider: 'codex', name: 'Pairing test' });
const png = await QRCode.toBuffer(pairing, { width: 800, margin: 4 });
const inverted = await QRCode.toBuffer(pairing, { width: 1800, margin: 6, color: { dark: '#ffffff', light: '#000000' } });
const asset = { path: '/private/qr.png', name: 'qr.png', mimeType: 'image/png', size: png.length, base64: png.toString('base64') };
process.env.PAGEBORNE_ASK_ORIGINS = endpoint;
const vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, clearScreen: false }); await vite.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const result = { passed: false, errors: [] }; const pages = [];
async function open(native = false) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); pages.push(page);
  page.on('pageerror', e => result.errors.push(e.message));
  if (native) {
    const storage = new Map();
    await page.exposeFunction('__storage', ({ method, data }) => {
      if (method === 'getLocalStorage') return storage.get(data.key) || '';
      storage.set(data.key, data.value); return true;
    });
    await page.addInitScript(image => {
      window.__cameraCalls = []; window.__captureMode = 'image'; window.__asset = image;
      window.flutter_inappwebview = { async callHandler(_name, serialized) {
        const m = JSON.parse(serialized);
        if (m.method.endsWith('LocalStorage')) return window.__storage(m);
        if (['captureImageFromCamera', 'pickImageFromAlbum'].includes(m.method)) {
          window.__cameraCalls.push(m.method);
          if (window.__captureMode === 'cancel') return null;
          if (window.__captureMode === 'error') throw new Error('private-camera-details-123');
          if (window.__captureMode === 'defer') return new Promise(resolve => { window.__finishCapture = resolve; });
          return window.__asset;
        }
        return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
      } };
    }, asset);
  }
  await page.goto(vite.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled();
  if (native) await expect(page.locator('#connection-state')).toHaveText('Connected');
  await showTool(page, 'settings'); await page.locator('#ask-mode').selectOption('terminal');
  await expect(page.locator('#ask-endpoint')).toHaveValue('');
  await expect(page.locator('#ask-token')).toHaveValue('');
  return page;
}
const importUrl = async (page, url) => {
  await page.locator('#ask-pairing-url').fill(url); await page.locator('#ask-pairing-use').click();
};
const checkImported = async page => {
  await expect(page.locator('#ask-pairing-status')).toContainText('Connection details imported');
  await expect(page.locator('#ask-endpoint')).toHaveValue(endpoint);
  await expect(page.locator('#ask-token')).toHaveValue(token);
  await expect(page.locator('#ask-agent')).toHaveValue('codex');
  await expect(page.locator('#ask-pairing-url')).toHaveValue('');
};
try {
  const page = await open();
  await importUrl(page, pairing); await checkImported(page); assert.equal(requests.length, 0);
  await page.locator('#ask-config-save').click(); await expect(page.locator('#ask-config-status')).toContainText('Saved for all documents');
  assert.deepEqual(requests, []);
  await page.reload(); await expect(page.locator('#import')).toBeEnabled(); await showTool(page, 'settings');
  await expect(page.locator('#ask-endpoint')).toHaveValue(endpoint); await expect(page.locator('#ask-token')).toHaveValue(token);
  await expect(page.locator('#ask-pairing-url')).toHaveValue(''); result.urlImportSaveReload = true;

  for (const buffer of [png, inverted]) {
    await page.locator('#ask-token').fill('old');
    const chooser = page.waitForEvent('filechooser'); await page.locator('#ask-qr-choose').click();
    await (await chooser).setFiles({ name: 'qr.png', mimeType: 'image/png', buffer }); await checkImported(page);
  }
  result.screenshotAndInvertedQr = true;
  await page.locator('#ask-qr-file').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not a PNG') });
  await expect(page.locator('#ask-pairing-status')).toContainText('Could not open that image');
  await expect(page.locator('#ask-token')).toHaveValue(token);
  const notPairing = await QRCode.toBuffer('https://example.com?token=secret#invalid-fragment');
  await page.locator('#ask-qr-file').setInputFiles({ name: 'other.png', mimeType: 'image/png', buffer: notPairing });
  await expect(page.locator('#ask-pairing-status')).toContainText('without a password or fragment');
  await expect(page.locator('#ask-token')).toHaveValue(token);
  await importUrl(page, 'https://another.example'); await expect(page.locator('#ask-token')).toHaveValue('');
  await expect(page.locator('#ask-agent')).toHaveValue('codex');
  assert.equal(requests.length, 0); result.invalidQrPreservesFieldsAndBareUrlClearsToken = true;

  const phone = await open(true);
  assert.deepEqual(await phone.evaluate(() => window.__cameraCalls), []);
  for (const button of ['#ask-qr-scan', '#ask-qr-choose']) { await phone.locator(button).click(); await checkImported(phone); }
  assert.deepEqual(await phone.evaluate(() => window.__cameraCalls), ['captureImageFromCamera', 'pickImageFromAlbum']);
  assert.equal(requests.length, 0);
  await phone.locator('#ask-config-save').click(); await expect(phone.locator('#ask-config-status')).toContainText('Saved for all documents');
  await phone.reload(); await expect(phone.locator('#import')).toBeEnabled(); await showTool(phone, 'settings');
  await expect(phone.locator('#ask-token')).toHaveValue(token); result.nativeSdkCameraAlbumAndPersistentSettings = true;
  await phone.locator('#ask-pairing-import').scrollIntoViewIfNeeded();
  await phone.screenshot({ path: path.join(dir, 'pairing-phone.png') });
  assert(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  await phone.evaluate(() => { window.__captureMode = 'cancel'; }); await phone.locator('#ask-qr-scan').click();
  await expect(phone.locator('#ask-pairing-status')).toContainText('cancelled'); await expect(phone.locator('#ask-token')).toHaveValue(token);
  await phone.evaluate(() => { window.__captureMode = 'error'; }); await phone.locator('#ask-qr-scan').click();
  await expect(phone.locator('#ask-pairing-status')).toContainText('Check camera access');
  assert(!(await phone.locator('#ask-pairing-status').textContent()).includes('private-camera-details'));
  for (const cancel of ['button', 'edit', 'mode', 'close', 'forget']) {
    await phone.evaluate(() => { window.__captureMode = 'defer'; window.__finishCapture = null; });
    await phone.locator('#ask-qr-scan').click(); await phone.waitForFunction(() => !!window.__finishCapture);
    if (cancel === 'button') await phone.locator('#ask-qr-cancel').click();
    if (cancel === 'edit') {
      await phone.locator('#ask-pairing-url').fill('https://edited.example');
      await expect(phone.locator('#ask-pairing-url')).toHaveValue('https://edited.example');
    }
    if (cancel === 'mode') await phone.locator('#ask-mode').selectOption('provider');
    if (cancel === 'close') await phone.locator('#settings-done').click();
    if (cancel === 'forget') await phone.locator('#ask-config-clear').click();
    const before = await phone.locator('#ask-endpoint').inputValue();
    await phone.evaluate(() => window.__finishCapture(window.__asset));
    // Drain the SDK promise chain and give image decoding time to detect a stale result.
    await phone.waitForTimeout(150);
    await expect(phone.locator('#ask-endpoint')).toHaveValue(before);
    if (cancel === 'close') await showTool(phone, 'settings');
    await phone.locator('#ask-mode').selectOption('terminal');
  }
  await expect(phone.locator('#ask-token')).toHaveValue(''); result.cancelForgetEditAndLateNativeResult = true;
  await importUrl(phone, 'https://unlisted.example?token=test'); await phone.locator('#ask-config-save').click();
  await expect(phone.locator('#ask-config-status')).toContainText('not enabled in this app build');
  assert.equal(requests.length, 0); result.hostAllowlistStillEnforced = true;
  for (const p of pages) {
    const diagnostics = await p.evaluate(() => localStorage.getItem('even-reader:diagnostics:v1') || '');
    assert(!diagnostics.includes(token)); assert(!diagnostics.includes(png.toString('base64')));
  }
  assert.deepEqual(result.errors, []); result.noSecretsOrImagesInDiagnostics = true; result.passed = true;
} catch (error) {
  result.failure = error.message;
  for (let i = 0; i < pages.length; i++) await pages[i].screenshot({ path: path.join(dir, `failure-${i}.png`) });
  throw error;
} finally {
  await writeFile(path.join(dir, 'results.json'), JSON.stringify(result, null, 2));
  await browser.close(); await vite.close(); api.closeAllConnections(); await new Promise(r => api.close(r));
}
console.log(JSON.stringify(result));
