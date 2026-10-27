// Real OCR, separate annotation gallery, original crop rendering and durable
// cache reload. Optional local scans stay in ignored test-results directories.
import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { scannedPdfFixture } from '../test/fixtures/pdfs.mjs';
import { showLibrary, waitForPdfReady } from './ui-helpers.mjs';

const out = process.env.PDF_ANNOTATIONS_RESULTS || 'test-results/pdf-annotations'; await mkdir(out, { recursive: true });
const server = await createServer({ mode: 'release', cacheDir: '.state/vite-pdf-annotations', plugins: [{
  name: 'annotation-test', transform(code, id) {
    if (id.endsWith('/src/main.js')) return code.replace('enabled: DEBUG', 'enabled: true')
      .replace('const opening = pdfDocument;', 'const opening = pdfDocument; window.__pdfForTest = opening;');
    if (id.endsWith('/src/speech-setup.js')) return code.replace('start(initialize) {', 'start(initialize) { this.blocked = false; return Promise.resolve();');
  },
}], server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, clearScreen: false });
await server.listen();
const engine = process.env.PDF_BROWSER || 'chromium';
const browser = await (engine === 'webkit' ? webkit.launch({ executablePath: process.env.WEBKIT_PATH })
  : chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] }));
const context = await browser.newContext({ viewport: { width: 440, height: 806 }, hasTouch: true });
const result = { engine, passed: false, errors: [] }; const storage = new Map();
await context.exposeFunction('__phoneStorage', m => {
  if (m.method === 'getLocalStorage') return storage.get(m.data.key) || '';
  storage.set(m.data.key, m.data.value); return true;
});
await context.addInitScript(() => {
  window.flutter_inappwebview = { async callHandler(_, payload) {
    const m = JSON.parse(payload); if (m.method.endsWith('LocalStorage')) return __phoneStorage(m);
    return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
  } };
});
const page = await context.newPage(); page.on('pageerror', error => result.errors.push(error.message));
try {
  await page.goto(server.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled();
  const pixels = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 600; c.height = 800;
    const ctx = c.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 600, 800);
    ctx.fillStyle = 'black'; ctx.font = '22px sans-serif';
    const lines = ['A reader opens the book in the morning.', 'The pages contain a story about a river.',
      'Water moves slowly through the valley.', 'A path follows the bank toward a town.',
      'People gather near the bridge each day.', 'They bring their questions to the library.',
      'Some choose stories about distant lands.', 'Others prefer a book about the garden.',
      'The librarian places flowers on the table.', 'Children read beneath the open window.',
      'Outside the sun shines across the water.', 'Everyone finds a place to sit and read.'];
    for (const [i, line] of lines.entries()) ctx.fillText(line, 40, 100 + i * 40);
    ctx.strokeStyle = '#555'; ctx.lineWidth = 1.5;
    for (const y of [103, 143, 183, 223]) { ctx.beginPath(); ctx.moveTo(55, y); ctx.quadraticCurveTo(180, y + 6, 365, y); ctx.stroke(); }
    // Handwritten marginal letters and a bracket; no hidden text fallback.
    ctx.lineWidth = 2; ctx.beginPath();
    ctx.moveTo(530, 250); ctx.lineTo(532, 220); ctx.lineTo(546, 247); ctx.lineTo(548, 218);
    ctx.moveTo(557, 218); ctx.lineTo(573, 218); ctx.moveTo(565, 218); ctx.lineTo(562, 250);
    ctx.moveTo(523, 270); ctx.lineTo(517, 270); ctx.lineTo(517, 385); ctx.lineTo(525, 385); ctx.stroke();
    // Disconnected binding/bottom-edge marks below the prose must not become
    // enlarged empty panes, even when their joint crop spans the whole page.
    ctx.fillStyle = '#666'; ctx.fillRect(0, 620, 4, 70); ctx.fillRect(0, 730, 4, 70); ctx.fillRect(0, 797, 600, 3);
    const data = ctx.getImageData(0, 0, 600, 800).data, rgb = [];
    for (let i = 0; i < data.length; i += 4) rgb.push(data[i], data[i + 1], data[i + 2]); return rgb;
  });
  const bytes = process.env.PDF_SAMPLE ? await readFile(process.env.PDF_SAMPLE) : scannedPdfFixture(600, 800, Buffer.from(pixels));
  await page.locator('#file-picker').setInputFiles([
    { name: 'annotations.pdf', mimeType: 'application/pdf', buffer: bytes },
    { name: 'plain.md', mimeType: 'text/markdown', buffer: Buffer.from('# Plain document\n\nOrdinary reading.') },
  ]);
  await showLibrary(page); await page.locator('[data-document-id="annotations.pdf"] .document-card').click();
  await waitForPdfReady(page, 120000);
  await writeFile(`${out}/${engine}-layout.json`, JSON.stringify(await page.evaluate(() => ({
    blocks: __pdfForTest.layout.blocks, annotations: __pdfForTest.layout.annotations, warnings: __pdfForTest.warnings,
    diagnostics: JSON.parse(localStorage.getItem('even-reader:diagnostics:v1')),
  }))));
  result.layout = await page.evaluate(() => ({
    annotations: __pdfForTest.layout.annotations.length,
    native: __pdfForTest.layout.blocks.filter(b => b.reflow).length,
    annotationInReading: __pdfForTest.layout.blocks.some(b => b.annotation?.kind === 'handwriting'),
    annotationInFigures: [...document.querySelectorAll('#pdf-gallery button')].some(b => b.dataset.figureId.startsWith('annotation:')),
  }));
  assert(result.layout.annotations > 0); assert(result.layout.native > 0);
  if (!process.env.PDF_SAMPLE) {
    assert.equal(await page.evaluate(() => __pdfForTest.layout.blocks.filter(b => b.kind === 'scan' && !b.text.trim()).length), 0);
    result.borderFragmentsRemoved = true;
  }
  assert.equal(result.layout.annotationInReading, false); assert.equal(result.layout.annotationInFigures, false);
  const gallery = page.locator('#pdf-annotations'), thumbs = gallery.locator('button'), modal = page.locator('#annotation-dialog');
  await expect(thumbs).toHaveCount(result.layout.annotations); await gallery.scrollIntoViewIfNeeded();
  await expect(thumbs.first().locator('canvas')).toHaveCount(1);
  const position = await page.locator('#position').inputValue();
  for (const width of [440, 1200]) {
    await page.setViewportSize({ width, height: 806 }); await thumbs.first().click(); await expect(modal.locator('canvas')).toHaveCount(1);
    await expect(modal.locator('.figure-image')).toHaveAttribute('data-rotated', 'false');
    assert(await modal.evaluate(dialog => {
      const stage = dialog.querySelector('.figure-stage').getBoundingClientRect(), image = dialog.querySelector('.figure-image').getBoundingClientRect();
      return image.width > 0 && image.left >= stage.left - 1 && image.right <= stage.right + 1 && image.top >= stage.top - 1 && image.bottom <= stage.bottom + 1;
    }));
    const crop = await modal.locator('canvas').evaluate(c => c.toDataURL());
    await writeFile(`${out}/${engine}-crop.png`, Buffer.from(crop.split(',')[1], 'base64'));
    await page.screenshot({ path: `${out}/${engine}-${width}.png` });
    await modal.locator('.figure-close').click(); await expect(modal).toBeHidden(); await expect(modal.locator('canvas')).toHaveCount(0);
    assert.equal(await page.locator('#position').inputValue(), position);
  }
  await page.reload(); await waitForPdfReady(page, 120000);
  await expect(thumbs).toHaveCount(result.layout.annotations);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('even-reader:diagnostics:v1')).pdf.cached), true);
  if (!process.env.PDF_SAMPLE) assert.equal(await page.evaluate(() => __pdfForTest.layout.blocks.filter(b => b.kind === 'scan' && !b.text.trim()).length), 0);
  await thumbs.first().click(); await expect(modal.locator('canvas')).toHaveCount(1); await modal.locator('.figure-close').click();
  await showLibrary(page); await page.locator('[data-document-id="plain.md"] .document-card').click();
  await expect(gallery).toBeHidden(); await expect(thumbs).toHaveCount(0); await expect(modal).toBeHidden();
  assert.deepEqual(result.errors, []); result.passed = true;
} catch (error) { result.failure = error.stack; throw error; }
finally { await writeFile(`${out}/${engine}.json`, JSON.stringify(result, null, 2)); await browser.close(); await server.close(); console.log(JSON.stringify(result)); }
