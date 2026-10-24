import test from 'node:test';
import assert from 'node:assert/strict';
import { reflowPdfBlock } from '../src/pdf-reflow.js';
import { labelPdfAnnotation } from '../src/pdf-annotations.js';
import { createPdfLayout, pdfAnchor, restorePdfAnchor, pdfPageTurn } from '../src/pdf-layout.js';
import { pdfReadingViews } from '../src/pdf-notes.js';
import { pdfNativeWindow } from '../src/pdf-native.js';
import { speedEntries } from '../src/speed-reading.js';
import { packPdfPreparation, unpackPdfPreparation } from '../src/pdf-cache.js';

const measure = text => text.length * 10;
const item = (text, x, y = 100, height = 20) => ({ text, x, y, height, width: text.length * height / 2 });
function block(lines, annotation) {
  const result = { kind: 'text', x: 30, y: Math.min(...lines.map(line => line.y)), width: 500,
    height: Math.max(...lines.map(line => line.y + line.height)) - Math.min(...lines.map(line => line.y)),
    lines, text: lines.map(line => line.text).join(' '), annotation };
  result.reflow = reflowPdfBlock(result, { measure });
  return labelPdfAnnotation(result, measure);
}
function layout(body, number = '12') {
  const note = block([item(`${number}. An explanatory note about this claim.`, 30, 680)],
    { kind: 'footnote', number, label: `Footnote ${number} — PDF page 1` });
  return createPdfLayout([{ number: 1, blocks: [body, block([item('Following paragraphs remain in source order. '.repeat(30), 30, 200)]), note] }]);
}
const text = layout => layout.blocks.flatMap(block => block.reflow?.rows.map(row => row.text) || []).join('\n');

test('raised references and their note labels are bracketed, including cached preparations and speed reading', () => {
  const full = layout(block([item('There are 12 examples of this claim.', 30), item('12', 373, 98, 12)]));
  const before = JSON.stringify(full); const { body, notes } = pdfReadingViews(full, { measure });
  assert.match(text(body), /There are 12 examples of this claim\.\[12\]/);
  assert.match(text(notes), /Footnote \[12\] — PDF page 1\n\[12\] An explanatory/);
  assert.equal(JSON.stringify(full), before);
  assert.ok(speedEntries(body).some(entry => entry.text === 'claim.[12]'));
  const cached = unpackPdfPreparation(JSON.parse(JSON.stringify(packPdfPreparation(full, new Map(), new Map([[1, 1]]))))).layout;
  const restored = pdfReadingViews(cached, { measure });
  assert.equal(text(restored.body), text(body)); assert.equal(text(restored.notes), text(notes));
});

test('baseline counts, years, unknown markers, captions, equations and existing brackets stay unchanged', () => {
  for (const lines of [
    [item('There are 12 examples in 2012.', 30)],
    [item('A supported claim.', 30), item('13', 201, 98, 12)],
    [item('A supported claim.[12]', 30)],
    [item('The expression x^', 30), item('12', 192, 98, 12)],
    [item('The expression x¹² remains mathematical.', 30)],
    [item('The expression x', 30), item('12', 182, 98, 12)],
  ]) {
    const full = layout(block(lines));
    assert.equal(text(pdfReadingViews(full, { measure }).body).split('\n')[0], text(full).split('\n')[0]);
  }
  const caption = block([item('Figure 12: A caption.', 30)], { kind: 'caption' });
  assert.equal(text(pdfReadingViews(layout(caption), { measure }).body).split('\n')[0], 'Figure 12: A caption.');
  const otherPage = layout(block([item('A claim.', 30), item('12', 113, 98, 12)]));
  otherPage.blocks.at(-1).page = 2;
  assert.doesNotMatch(text(pdfReadingViews(otherPage, { measure }).body), /\[12\]/);
});

test('Unicode superscripts and raised OCR word boxes match known notes', () => {
  const unicode = pdfReadingViews(layout(block([item('The supported claim¹² remains readable.', 30)])), { measure });
  assert.match(text(unicode.body), /claim\[12\] remains/);
  const words = [item('The supported claim.', 30), item('12', 233, 98, 12)];
  const ocr = { ...item('The supported claim.12', 30), words, confidence: 95 };
  assert.match(text(pdfReadingViews(layout(block([ocr])), { measure }).body), /claim\.\[12\]/);
  const inline = { ...item('The supported claim.12', 30), confidence: 95,
    words: [{ ...item('The supported claim.12', 30), references: [{ start: 20, end: 22, number: '12' }] }] };
  const original = layout(block([inline]));
  const saved = unpackPdfPreparation(JSON.parse(JSON.stringify(packPdfPreparation(original, new Map(), new Map([[1, 1]]))))).layout;
  assert.match(text(pdfReadingViews(saved, { measure }).body), /claim\.\[12\]/);
});

test('brackets rewrap long rows without losing text or source anchors and remain pageable', () => {
  const prefix = 'A supported claim in a very long sentence ends here!!';
  const full = layout(block([item(prefix, 30), item('12', 30 + prefix.length * 10, 98, 12)]));
  const original = full.blocks[0];
  const { body } = pdfReadingViews(full, { measure });
  const changed = body.blocks[0];
  assert.ok(changed.reflow.rows.length > original.reflow.rows.length);
  assert.ok(changed.reflow.rows.every(row => measure(row.text) <= 552));
  assert.equal(changed.reflow.rows.map(row => row.text).join(' ').replace(/\s/g, ''), (prefix + '[12]').replace(/\s/g, ''));
  assert.equal(restorePdfAnchor(body, pdfAnchor(full, original.y)), 0);
  for (const row of changed.reflow.rows) assert.ok(row.start >= 0 && row.end <= original.reflow.text.length);
  assert.match(pdfNativeWindow(body, 0).content, /\[12\]/);
  let y = 0;
  for (let i = 0; y < body.maxY && i < 100; i++) { const next = pdfPageTurn(body, y, 1); assert.ok(next > y); y = next; }
  assert.equal(y, body.maxY);
});
