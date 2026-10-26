import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfRasterGeometry, sharpenPdfText, PdfRaster, PDF_RASTER_TILE } from '../src/pdf-raster.js';

test('display crops use PDF resolution, preserve adjacent tile coordinates and bound working canvas size', () => {
  const block = { x: 120.25, sourceY: 430.5, width: 192, scale: 3, drawHeight: 20000 };
  const a = pdfRasterGeometry(block, 0, 1.5); const b = pdfRasterGeometry(block, 1, 1.5);
  assert.equal(a.scale, 9);
  assert.equal(block.x * block.scale * 2 + a.transform[4], 4);
  assert.equal(block.sourceY * block.scale * 2 + a.transform[5], 4);
  assert.equal(a.transform[5] - b.transform[5], PDF_RASTER_TILE * 2);
  assert.ok(a.renderWidth * a.renderHeight < 1_000_000, 'a long block never allocates a full high-resolution page');
});

test('text sharpening preserves paper and flat tones while sharpening antialiased edges', () => {
  const width = 9; const height = 5; const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  const flat = pixels.slice(); sharpenPdfText(flat, width, height); assert.deepEqual(flat, pixels);
  for (let y = 0; y < height; y++) for (const [x, value] of [[3, 160], [4, 32], [5, 160]]) {
    pixels.fill(value, (y * width + x) * 4, (y * width + x) * 4 + 3);
  }
  const before = pixels.slice(); sharpenPdfText(pixels, width, height);
  assert.ok(pixels[(2 * width + 4) * 4] < before[(2 * width + 4) * 4]);
  assert.equal(pixels[(2 * width + 1) * 4], 255);
  assert.ok(pixels.every((value, i) => i % 4 !== 3 || value === 255));
});

test('raster work is serialized, coalesced and bounded, and closed documents cancel queued work', async () => {
  const raster = new PdfRaster(null, new Map(), true); const block = {}; let active = 0; let calls = 0;
  raster.render = async (_block, index) => {
    assert.equal(++active, 1); calls++; await new Promise(resolve => setTimeout(resolve, 1)); active--;
    return { index };
  };
  const first = raster.tile(block, 0); assert.equal(first, raster.tile(block, 0));
  await first; await raster.tile(block, 0); assert.equal(calls, 1);
  await Promise.all(Array.from({ length: 20 }, (_, i) => raster.tile(block, i)));
  assert.equal(raster.cache.size, 12);
  const pending = raster.tile(block, 40); raster.destroy();
  await assert.rejects(pending, /PDF closed/); assert.equal(raster.cache.size, 0);
  await assert.rejects(raster.tile(block, 0), /PDF closed/);
});

test('moving between scanned pages releases decoded images and revisiting renders them again', async () => {
  const originalDocument = globalThis.document; const cleaned = []; const rendered = [];
  globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage() {} }) }) };
  const pages = [1, 2].map(number => ({
    getViewport: () => ({}),
    render: () => { rendered.push(number); return { promise: Promise.resolve(), cancel() {}, _internalRenderTask: { _useRequestAnimationFrame: true } }; },
    cleanup: () => { cleaned.push(number); },
  }));
  const raster = new PdfRaster({ getPage: async number => pages[number - 1] }, new Map([[1, 1], [2, 1]]), false);
  const first = { page: 1, x: 0, sourceY: 0, width: 576, scale: 1, drawHeight: 900 };
  const second = { ...first, page: 2 };
  try {
    await raster.tile(first, 0); await raster.tile(second, 0);
    assert.deepEqual(cleaned, [1]);
    await raster.tile(first, 0); // Cached pixels do not need to decode again.
    assert.deepEqual(rendered, [1, 2]);
    await raster.tile(first, 1);
    assert.deepEqual(rendered, [1, 2, 1]); assert.deepEqual(cleaned, [1, 2]);
  } finally { raster.destroy(); globalThis.document = originalDocument; }
});

test('PDF shared-resource cleanup waits for rendering and gates new tiles', async () => {
  const { PdfRaster } = await import('../src/pdf-raster.js');
  const raster = new PdfRaster({}, new Map(), false), calls = [];
  let releaseRender, releaseCleanup;
  raster.render = async block => { calls.push(`render-${block.page}`); if (block.page === 1) await new Promise(r => { releaseRender = r; }); return { width: 1, height: 1 }; };
  const first = raster.tile({ page: 1 }, 0);
  const cleaning = raster.cleanup(async () => { calls.push('cleanup'); await new Promise(r => { releaseCleanup = r; }); });
  const second = raster.tile({ page: 2 }, 0);
  await new Promise(r => setImmediate(r)); assert.deepEqual(calls, ['render-1']);
  releaseRender(); await first; await new Promise(r => setImmediate(r)); assert.deepEqual(calls, ['render-1', 'cleanup']);
  releaseCleanup(); await cleaning; await second; assert.deepEqual(calls, ['render-1', 'cleanup', 'render-2']);
  raster.destroy(); await raster.cleanup(() => { throw Error('Closed PDFs cannot clean again'); });
});

test('rapid scrolling drops queued tiles and aborts the active PDF render', async () => {
  const originalDocument = globalThis.document; let rejectRender, cancelled = 0, rendered = 0;
  globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage() {} }) }) };
  const page = { getViewport: () => ({}), render: () => {
    rendered++;
    return { promise: new Promise((_, reject) => { rejectRender = reject; }),
      cancel: () => { cancelled++; rejectRender(new Error('render cancelled')); },
      _internalRenderTask: { _useRequestAnimationFrame: true } };
  } };
  const raster = new PdfRaster({ getPage: async () => page }, new Map([[1, 1]]), false);
  const block = { page: 1, x: 0, sourceY: 0, width: 576, scale: 1, drawHeight: 3000 };
  const active = new AbortController(), queued = new AbortController();
  try {
    const first = assert.rejects(raster.tile(block, 0, active.signal), /cancelled/);
    const second = assert.rejects(raster.tile(block, 1, queued.signal), /preview closed/);
    await new Promise(resolve => setImmediate(resolve));
    queued.abort(); active.abort(); await Promise.all([first, second]);
    assert.equal(cancelled, 1); assert.equal(rendered, 1); assert.equal(raster.cache.size, 0);
    assert.equal(raster.work.jobs.length, 0);
  } finally { raster.destroy(); globalThis.document = originalDocument; }
});
