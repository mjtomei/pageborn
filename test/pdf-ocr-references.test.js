import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfOcrReference } from '../src/pdf-ocr-references.js';

function word(text, raised = 0) {
  return { text, symbols: [...text].map((char, i) => ({ text: char,
    bbox: { x0: i * 10, x1: i * 10 + 8, y0: 10, y1: i >= text.length - raised ? 22 : 30 } })) };
}
test('OCR preserves raised reference geometry inside words, including digit recognition errors', () => {
  for (const [text, length] of [['claim.12', 2], ['grounds.?', 1], ['credo,!', 1], ['liable.2°', 2], ['defects.!®#', 3]]) {
    const ref = pdfOcrReference(word(text, length));
    assert.equal(ref.text, text.slice(-length)); assert.equal(ref.start, text.length - length); assert.equal(ref.end, text.length);
  }
});
test('baseline numbers, normal punctuation, exponents and quotation marks are not reference candidates', () => {
  for (const value of [word('version12'), word('really?'), word('x2', 1), word('cm2', 1), word('claims’', 1), word('year1995')]) {
    assert.equal(pdfOcrReference(value), null);
  }
  const damaged = word('claim.12', 2); damaged.symbols.pop();
  assert.equal(pdfOcrReference(damaged), null);
});

test('separate raised words and overlapping OCR artifacts retain the actual glyph bounds', () => {
  assert.equal(pdfOcrReference(word('12', 2), { baseline: 30, size: 20 }).text, '12');
  assert.equal(pdfOcrReference(word('12'), { baseline: 30, size: 20 }), null);
  const value = word('defects.!®#', 3);
  value.symbols.at(-1).bbox = { ...value.symbols.at(-2).bbox, x0: 97, x1: 98, y1: 30 };
  const ref = pdfOcrReference(value);
  assert.equal(ref.text, '!®#'); assert.equal(ref.bbox.y1, 22);
  assert.equal(pdfOcrReference(word('Delaware.”!7', 2)).text, '!7');
});
