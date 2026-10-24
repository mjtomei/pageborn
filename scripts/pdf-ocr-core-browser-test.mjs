import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import { createApp } from '../server/app.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scannedPdfFixture } from '../test/fixtures/pdfs.mjs';

const dir = path.resolve('test-results/pdf-ocr-core'); await mkdir(dir, { recursive: true });
const bundle = path.join(dir, 'bundle'); const entry = path.join(dir, 'entry.js');
await writeFile(entry, `export { PdfDocument } from ${JSON.stringify(path.resolve('src/pdf.js'))};\nexport { packPdfPreparation as pack } from ${JSON.stringify(path.resolve('src/pdf-cache.js'))};`);
await build({ build: { outDir: bundle, emptyOutDir: true, lib: { entry, formats: ['es'], fileName: () => 'ocr-core.js' } } });
const server = createApp({ distDir: bundle }).listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const result = { passed: false, variants: [], errors: [] };
try {
  for (const fallback of [false, true]) {
    const context = await browser.newContext(); const page = await context.newPage();
    page.on('pageerror', error => result.errors.push(error.message));
    await page.route('**/__ocr-core', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>OCR core regression</title>' }));
    await page.goto(`http://127.0.0.1:${server.address().port}/__ocr-core`);
    const scan = await page.evaluate(async fallback => {
      if (fallback) {
        const validate = WebAssembly.validate;
        WebAssembly.validate = bytes => bytes.length === 31 && bytes[26] === 0xfd ? false : validate(bytes);
      }
      Object.assign(window, await import('/ocr-core.js'));
      const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 800;
      const c = canvas.getContext('2d'); c.fillStyle = 'white'; c.fillRect(0, 0, 600, 800); c.fillStyle = 'black'; c.font = '24px sans-serif';
      ['Offline recognition works on this scanned page.', 'The notebook is blue and has twelve pages.',
        'Footnotes and figures stay with the document.', 'Small print needs accurate recognition.'].forEach((s, i) => c.fillText(s, 30, 70 + i * 34));
      c.strokeRect(100, 250, 400, 160); c.beginPath(); c.moveTo(100, 400); c.lineTo(220, 280); c.lineTo(400, 360); c.stroke();
      c.font = '16px sans-serif'; c.fillText('1. This is a smaller footnote at the bottom.', 30, 730);
      const rgba = c.getImageData(0, 0, 600, 800).data; const rgb = new Uint8Array(600 * 800 * 3);
      for (let n = 0; n < 600 * 800; n++) rgb.set(rgba.subarray(n * 4, n * 4 + 3), n * 3);
      let data = ''; for (let n = 0; n < rgb.length; n += 8192) data += String.fromCharCode(...rgb.subarray(n, n + 8192)); return btoa(data);
    }, fallback);
    await context.setOffline(true);
    const variant = await page.evaluate(async bytes => {
      const pdf = new PdfDocument();
      try {
        const layout = await pdf.open(bytes, 'auto');
        return { core: pdf.ocr.core, warnings: pdf.warnings, prepared: pack(layout, pdf.marginMasks, pdf.pageScales) };
      } finally { await pdf.destroy(); }
    }, scannedPdfFixture(600, 800, Buffer.from(scan, 'base64')).toString('base64'));
    assert.equal(variant.core, fallback ? 'scalar' : 'simd'); assert.deepEqual(variant.warnings, []);
    assert.match(JSON.stringify(variant.prepared), /notebook is blue/i);
    result.variants.push(variant); await context.close();
  }
  assert.deepEqual(result.variants[0].prepared, result.variants[1].prepared, 'SIMD and fallback preserve text, footnotes and figure geometry');
  for (const variant of result.variants) delete variant.prepared;
  assert.deepEqual(result.errors, []); result.passed = true;
  console.log('PASS: SIMD and scalar fallback recognize identical text/layout completely offline.');
} finally {
  await writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2)); await browser.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
