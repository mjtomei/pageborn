import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfWholePageImage, removePdfScanBorderFragments } from '../src/pdf-page-image.js';
import { createPdfLayout, PDF_SCREEN, pdfPageTurn } from '../src/pdf-layout.js';
import { pdfGalleryItems } from '../src/pdf-captions.js';
import { pdfImageFrame } from '../src/pdf-image-frame.js';

const scan = () => {
  const width = 600, height = 900, data = new Uint8ClampedArray(width * height * 4).fill(255);
  data.fill(0, 20000, 20400);
  for (let i = 20003; i < 20400; i += 4) data[i] = 255;
  return { width, height, data, images: [{ x: 0, y: 0, width, height }], text: [] };
};

test('covers and sparse title pages stay whole, fit one glasses pane and appear in the phone gallery', () => {
  const page = scan(); page.text = [{ x: 100, y: 100, width: 400, height: 30, text: 'THE PUBLIC AND ITS PROBLEMS' }];
  const result = pdfWholePageImage(page);
  assert.equal(result.blocks.length, 1); assert.equal(result.blocks[0].height, 900);
  const pages = [1, 2].map(number => ({ ...result, number, width: page.width, height: page.height }));
  for (const fitFigures of [true, false]) {
    const layout = createPdfLayout(pages, { fitFigures });
    assert.equal(layout.blocks[0].drawHeight, PDF_SCREEN);
    assert.equal(layout.blocks[0].keepTogether, true);
    assert.equal(pdfPageTurn(layout, 0, 1), layout.blocks[1].y);
    assert.deepEqual(pdfImageFrame(layout, 100, PDF_SCREEN), { y: 0, end: PDF_SCREEN, top: 0 });
    assert.deepEqual(pdfImageFrame(layout, layout.blocks[1].y, PDF_SCREEN), { y: layout.blocks[1].y, end: layout.blocks[1].y + PDF_SCREEN, top: 0 });
    const items = pdfGalleryItems(layout);
    assert.equal(items.length, 2); assert.equal(items[0].title, 'Page image · page 1');
    assert.equal(items[0].block.width, 600); assert.equal(items[0].block.height, 900);
  }
});

test('scanned paragraphs retain reflow and blank pages do not acquire an image', () => {
  const page = scan();
  page.text = Array.from({ length: 12 }, (_, n) => ({ x: 50, y: 100 + n * 20, width: 500, height: 15,
    text: 'A sentence in the body of a scanned book remains available as native text.' }));
  assert.equal(pdfWholePageImage(page), null);
  page.text = []; page.data.fill(255);
  assert.equal(pdfWholePageImage(page), null);
  page.data.fill(0); page.images[0].height = 200;
  assert.equal(pdfWholePageImage(page), null);
});

test('binding shadows after prose do not turn into several empty reflow panes', () => {
  const page = scan(); page.data.fill(255);
  const ink = (x, y, value = 0) => { const i = (y * page.width + x) * 4; page.data.fill(value, i, i + 3); };
  for (let y = 600; y < 899; y++) ink(1, y);
  for (let x = 0; x < page.width; x++) ink(x, 899);
  const body = { x: 60, y: 100, width: 480, height: 400, kind: 'text', text: 'Readable prose. '.repeat(30), lines: [] };
  const strip = { x: 0, y: 600, width: 5, height: 150, kind: 'scan', text: '', lines: [] };
  const wide = { ...strip, y: 770, width: 600, height: 130 };
  const next = { ...pdfWholePageImage({ ...page, text: [] }), number: 2 };
  const blocks = removePdfScanBorderFragments({ ...page, blocks: [body, strip, wide] });
  assert.deepEqual(blocks, [body]);
  const layout = createPdfLayout([{ number: 1, blocks }, next]);
  assert.equal(layout.blocks.length, 2);
  assert.equal(pdfPageTurn(layout, layout.pages.at(-2), 1), layout.blocks[1].y);
  const separateLines = Array.from({ length: 10 }, (_, i) => ({ ...body, y: 100 + i * 25, height: 20, text: 'The printed line remains readable.' }));
  assert.deepEqual(removePdfScanBorderFragments({ ...page, blocks: [...separateLines, wide] }), separateLines);
  // Even a faint interior stroke is evidence to retain the original image.
  ink(300, 820, 234);
  assert.deepEqual(removePdfScanBorderFragments({ ...page, blocks: [body, wide] }), [body, wide]);
});

test('border cleanup preserves figures, recognized edge text, isolated marks and sparse scans', () => {
  const page = scan(); page.data.fill(255);
  const body = { x: 60, y: 100, width: 480, height: 400, kind: 'text', text: 'Readable prose. '.repeat(30), lines: [] };
  const edge = { x: 0, y: 600, width: 5, height: 150, kind: 'scan', text: '', lines: [] };
  for (const block of [{ ...edge, kind: 'figure' }, { ...edge, fullPage: true }, { ...edge, text: 'I' },
    { ...edge, lines: [{ text: 'I' }] }, { ...edge, x: 100 }]) {
    assert.deepEqual(removePdfScanBorderFragments({ ...page, blocks: [body, block] }), [body, block]);
  }
  assert.deepEqual(removePdfScanBorderFragments({ ...page, blocks: [edge] }), [edge]);
});
