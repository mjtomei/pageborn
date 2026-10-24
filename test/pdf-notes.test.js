import test from 'node:test';
import assert from 'node:assert/strict';
import { createPdfLayout, pdfAnchor, restorePdfAnchor, pdfPageTurn } from '../src/pdf-layout.js';
import { pdfNativeWindow } from '../src/pdf-native.js';
import { pdfReadingViews, nearbyPdfNote } from '../src/pdf-notes.js';
import { packPdfPreparation, unpackPdfPreparation } from '../src/pdf-cache.js';
import { SpeedReading } from '../src/speed-reading.js';

function text(value, y, annotation) {
  const lines = value.split('\n').map((text, i) => ({ text, x: 30, y: y + i * 25, width: 450, height: 20 }));
  return { kind: 'text', x: 30, y, width: 450, height: lines.length * 25, lines, text: value, annotation,
    reflow: { nativeWrap: 2, fontSize: 20, lineHeight: 25, text: value, height: lines.length * 25,
      rows: lines.map((line, i) => ({ text: line.text, y: i * 25, sourceY: line.y, start: i, end: i + 1, items: [line] })) } };
}
function fixture() {
  const note = { kind: 'footnote', number: '1', label: 'Footnote 1 — PDF page 1' };
  return createPdfLayout([
    { number: 1, blocks: [text('Body reference1\nContinue the body.', 100), text('Caption text', 220, { kind: 'caption' }),
      text(Array.from({ length: 20 }, (_, i) => `NoteOnly${i}`).join('\n'), 600, note)] },
    { number: 2, blocks: [text('The next page of body text.', 100),
      { ...text('Footnote 2 — PDF page 2', 650, { ...note, number: '2' }), annotationLabel: true },
      { kind: 'figure', x: 30, y: 680, width: 450, height: 70, lines: [], text: '', annotation: { ...note, number: '2' } }] },
  ]);
}

test('footnote views remove notes and their raster labels from the body while keeping captions and source anchors', () => {
  const full = fixture(); const before = JSON.stringify(full);
  const { body, notes } = pdfReadingViews(full);
  assert.equal(JSON.stringify(full), before, 'saved preparation is untouched');
  assert.equal(body.blocks.length, 3); assert.equal(notes.blocks.length, 3);
  assert.ok(body.blocks.every(b => b.annotation?.kind !== 'footnote'));
  assert.equal(body.blocks[1].text, 'Caption text');
  assert.equal(notes.blocks.at(-1).kind, 'figure');
  const target = full.blocks.find(b => b.page === 2 && !b.annotation);
  assert.equal(restorePdfAnchor(body, pdfAnchor(full, target.y)), Math.min(body.maxY, body.blocks.at(-1).y));
  const speed = new SpeedReading(); speed.load(body);
  assert.ok(speed.entries.every(e => !e.text?.includes('NoteOnly')));
  assert.ok(speed.entries.some(e => e.text === 'Caption'));
  const restored = unpackPdfPreparation(JSON.parse(JSON.stringify(packPdfPreparation(full, new Map(), new Map([[1, 1], [2, 1]]))))).layout;
  assert.deepEqual(pdfReadingViews(restored).body.blocks.map(b => [b.y, b.sourceY, b.text]), body.blocks.map(b => [b.y, b.sourceY, b.text]));
});

test('long notes are fully pageable, including a separately labelled image note, and open near the source page', () => {
  const { body, notes } = pdfReadingViews(fixture());
  const shown = new Set(); let y = 0;
  for (let count = 0; count < 30; count++) {
    for (const line of pdfNativeWindow(notes, y)?.content.split('\n') || []) shown.add(line);
    if (y === notes.maxY) break;
    const next = pdfPageTurn(notes, y, 1); assert.ok(next > y); y = next;
  }
  for (let i = 0; i < 20; i++) assert.ok(shown.has(`NoteOnly${i}`));
  assert.equal(nearbyPdfNote(body, notes, 0), 0);
  assert.equal(nearbyPdfNote(body, notes, body.blocks.at(-1).y), Math.min(notes.maxY, notes.blocks[1].y));
  assert.equal(pdfReadingViews(body).notes, null);
});

test('raster views bind each draw to its own layout even when previews render concurrently', async () => {
  const full = fixture(); const calls = [];
  full.pdf = { draw: async (...args) => { await Promise.resolve(); calls.push(args); } };
  const { body, notes } = pdfReadingViews(full);
  await Promise.all([body.pdf.draw(0, 258, true, { paging: true }), notes.pdf.draw(10, 80)]);
  assert.equal(calls[0][3].layout, body); assert.equal(calls[1][3].layout, notes);
  assert.equal(calls[0][3].paging, true);
});
