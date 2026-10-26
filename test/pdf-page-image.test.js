import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfWholePageImage } from '../src/pdf-page-image.js';
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
