import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfScanMarks, pdfUnderlineBlock } from '../src/pdf-scan-marks.js';
import { createPdfLayout } from '../src/pdf-layout.js';
import { pdfAnnotationItems, pdfGalleryItems } from '../src/pdf-captions.js';
import { packPdfPreparation, unpackPdfPreparation } from '../src/pdf-cache.js';

function fixture() {
  const width = 600, height = 800, data = new Uint8ClampedArray(width * height * 4).fill(255);
  const rect = (x, y, w, h) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    const at = (yy * width + xx) * 4; data[at] = data[at + 1] = data[at + 2] = 0;
  } };
  const text = Array.from({ length: 12 }, (_, i) => ({ text: 'This printed paragraph remains readable even when someone underlines it.',
    x: 80, y: 100 + i * 40, width: 400, height: 20, confidence: 96 }));
  for (const row of text) for (let x = row.x; x < row.x + row.width; x += 20) rect(x, row.y, 12, 16);
  return { width, height, data, text, rect };
}
test('underline hallucinations are removed without losing printed words; margin handwriting is captured as pixels', () => {
  const p = fixture(); p.rect(100, 123, 300, 2);
  p.text.push({ x: 100, y: 122, width: 300, height: 12, text: '— eer 5 =', confidence: 25 });
  for (let x = 520; x < 575; x += 10) p.rect(x, 155, 6, 15);
  p.text.push({ x: 520, y: 155, width: 55, height: 18, text: 'PoBlit', confidence: 13 });
  const result = pdfScanMarks(p);
  assert.equal(result.text.length, 12); assert.ok(result.text.every(line => line.text.startsWith('This printed')));
  assert.equal(result.annotations.length, 1); assert.ok(result.annotations[0].x > 500);
  assert.equal(result.masks.length, 1);
  assert.equal(pdfUnderlineBlock({ x: 100, y: 122, width: 300, height: 3, kind: 'scan', lines: [] }, result.text), true);
  assert.equal(pdfUnderlineBlock({ x: 100, y: 122, width: 300, height: 30, kind: 'scan', lines: [] }, result.text), false);
});
test('low confidence alone cannot delete a real word, heading, figure or note reference', () => {
  const p = fixture(); const name = { x: 100, y: 123, width: 80, height: 20, text: 'John', confidence: 30 };
  p.text.push(name); p.rect(100, 123, 12, 20); p.rect(140, 123, 12, 20);
  assert.ok(pdfScanMarks(p).text.includes(name));
  p.text = p.text.slice(0, 2);
  assert.deepEqual(pdfScanMarks(p).annotations, []);
});
test('wavy underline artifacts can touch a footer glyph, while underlined words remain', () => {
  const p = fixture();
  for (let x = 100; x < 400; x++) p.rect(x, 123 + Math.floor(x / 60) % 3, 1, 2);
  p.rect(280, 124, 7, 15);
  const artifact = { x: 100, y: 122, width: 300, height: 18, text: '— eer 5 -', confidence: 34 };
  p.text.push(artifact);
  assert.ok(!pdfScanMarks(p).text.includes(artifact));
  const name = { ...artifact, text: 'John' }; p.text[p.text.length - 1] = name;
  assert.ok(pdfScanMarks(p).text.includes(name));
});
test('thin pencil strokes and detached glyph strokes stay inside the saved crop', () => {
  const p = fixture(); p.rect(520, 150, 1, 24); p.rect(521, 150, 14, 1);
  p.rect(520, 160, 15, 1); p.rect(534, 151, 1, 9);
  p.rect(550, 150, 1, 20); p.rect(551, 169, 12, 1);
  const [crop] = pdfScanMarks(p).annotations;
  assert.ok(crop.y < 150 && crop.y + crop.height > 174);
  assert.ok(crop.x < 520 && crop.x + crop.width > 562);
});
test('annotation gallery is separate from reading/figures and survives preparation cache reload', () => {
  const note = { x: 520, y: 150, width: 60, height: 80, kind: 'figure', text: '', lines: [], annotation: { kind: 'handwriting' } };
  const body = { x: 80, y: 100, width: 400, height: 500, kind: 'text', text: 'Printed words', lines: [] };
  const layout = createPdfLayout([{ number: 1, blocks: [body], annotations: [note] }]);
  assert.equal(layout.blocks.length, 1); assert.deepEqual(pdfGalleryItems(layout), []);
  const item = pdfAnnotationItems(layout)[0]; assert.equal(item.block.sourceY, 150); assert.equal(item.page, 1);
  const saved = packPdfPreparation(layout, new Map(), new Map([[1, 1.5]]));
  const restored = unpackPdfPreparation(JSON.parse(JSON.stringify(saved))).layout;
  assert.deepEqual(pdfAnnotationItems(restored), pdfAnnotationItems(layout));
  saved.layout.annotations[0].width = NaN;
  assert.throws(() => unpackPdfPreparation(saved), /annotations are incomplete/);
});
