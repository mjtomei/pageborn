import test from 'node:test';
import assert from 'node:assert/strict';
import { createPdfLayout, pdfPageTurn } from '../src/pdf-layout.js';
import { pdfNativeWindow, pdfAutoStep, pdfImageEnd, PdfAutoscroll, pdfEntryLines } from '../src/pdf-native.js';
import { byteLength, TEXT_BYTES, VISIBLE_LINES } from '../src/native-text.js';
import { Reader } from '../src/reader.js';

const prose = (name, count) => {
  let text = ''; const rows = [];
  for (let i = 0; i < count; i++) {
    if (text) text += ' ';
    const start = text.length, row = `${name} row ${i}`; text += row;
    rows.push({ text: row, y: i * 25, items: [], start, end: text.length });
  }
  return { x: 0, y: 0, width: 500, height: 100, kind: 'text', text, lines: [],
    reflow: { text, fontSize: 20, lineHeight: 25, height: count * 25, rows } };
};
const figure = { x: 0, y: 0, width: 576, height: 200, kind: 'figure', text: '', lines: [] };
const make = blocks => createPdfLayout([{ number: 1, blocks }]);

test('manual reading pace ignores quick or slow full-page images before and between text panes', () => {
  const cover = { ...figure, fullPage: true, height: 800 };
  const layout = make([...Array(6).fill(cover), prose('Before', 18), cover, prose('After', 54)]);
  const read = imageSeconds => {
    const reader = new Reader();
    reader.setDocument(layout.maxY, 0, layout.pages, (y, direction) => pdfPageTurn(layout, y, direction));
    reader.setSpeedDocument(layout);
    let imagePanes = 0, textPanes = 0;
    while (textPanes < 5) {
      const text = pdfNativeWindow(layout, reader.y);
      reader.tick(text ? 9 : imageSeconds); reader.pageStep(1);
      if (text) textPanes++; else imagePanes++;
      assert.equal(reader.pagesRead, textPanes, 'only text advances count toward warm-up');
      if (textPanes < 5) assert.equal(reader.pageRemainingSeconds, undefined);
    }
    assert.equal(imagePanes, 7); assert.equal(reader.pageReadWords, 135); assert.equal(reader.pageReadSeconds, 45);
    assert.equal(reader.pageRemainingSeconds, 27, '81 remaining words at the measured three words per second');
    const before = reader.pageWordsFrom(reader.y);
    reader.jump(reader.y + 7);
    assert.equal(reader.pageWordsFrom(reader.y), before, 'a jump inside a row retains its visible words');
    return reader.pageRemainingSeconds;
  };
  assert.equal(read(.05), read(120), 'time spent on images cannot change the measured text pace');
});

test('image-only PDFs never learn a fictitious word rate from page turns', () => {
  const layout = make(Array(8).fill({ ...figure, fullPage: true, height: 800 }));
  const reader = new Reader();
  reader.setDocument(layout.maxY, 0, layout.pages, (y, direction) => pdfPageTurn(layout, y, direction));
  reader.setSpeedDocument(layout);
  for (let i = 0; i < 7; i++) { reader.tick(2); reader.pageStep(1); }
  assert.equal(reader.pagesRead, 0); assert.equal(reader.pageReadWords, 0);
  assert.equal(reader.pageReadSeconds, 0); assert.equal(reader.pageRemainingSeconds, undefined);
});

test('a scanned divider does not create an almost-empty image page before native text', () => {
  const divider = { x: 53, y: 78, width: 794, height: 3, text: '', lines: [], kind: 'scan' };
  const layout = make([divider, prose('Readable first page', 20)]);
  assert.equal(layout.blocks.length, 1); assert.match(pdfNativeWindow(layout, 0).content, /Readable first page/);
  assert.equal(make([divider]).blocks.length, 1, 'scan mode preserves source pixels');
  assert.equal(make([{ ...divider, height: 7 }, prose('Body', 20)]).blocks.length, 1, 'crop padding around a thin rule is ignored');
  assert.equal(make([{ ...divider, kind: 'figure' }, prose('Body', 20)]).blocks.length, 2, 'figures are retained');
  assert.equal(make([{ ...divider, lines: [{ text: 'x = 2', x: 53, y: 78 }] }, prose('Body', 20)]).blocks.length, 2, 'mathematics is retained');
});

test('PDF native pages include every line, stop at figures and return to text in both directions', () => {
  const layout = make([prose('Before', 21), figure, prose('After', 23)]);
  const seen = new Set(); let sawImage = false;
  for (const y of layout.pages) {
    const window = pdfNativeWindow(layout, y);
    if (window) {
      assert.ok(window.content.split('\n').length <= VISIBLE_LINES);
      assert.ok(byteLength(window.content) <= TEXT_BYTES);
      for (const row of window.content.split('\n')) seen.add(row);
      if (y < layout.blocks[1].y) assert.doesNotMatch(window.content, /After/);
    } else sawImage = true;
  }
  for (const name of ['Before', 'After']) for (let i = 0; i < (name === 'Before' ? 21 : 23); i++) assert.ok(seen.has(`${name} row ${i}`));
  assert.ok(sawImage);
  assert.equal(pdfImageEnd(layout, layout.blocks[1].y), layout.blocks[2].y);
  assert.equal(pdfPageTurn(layout, layout.blocks[1].y, 1), layout.blocks[2].y);
  assert.equal(pdfPageTurn(layout, layout.blocks[2].y, -1), layout.blocks[1].y);
  assert.equal(pdfNativeWindow(layout, layout.maxY).content.split('\n').at(-1), 'After row 22');
});

test('native PDF autoscroll follows actual rows and lands on both sides of image boundaries', () => {
  const layout = make([prose('Before', 12), figure, prose('After', 15)]);
  const reader = new Reader(); reader.setDocument(layout.maxY, 0, layout.pages, null, y => pdfAutoStep(layout, y));
  reader.setMode('auto'); reader.setSpeed(200); reader.togglePlay(); const positions = [0];
  for (let i = 0; i < 100 && reader.playing; i++) { reader.tick(.31); positions.push(reader.y); }
  for (const row of layout.blocks[0].reflow.rows) assert.ok(positions.includes(row.y));
  assert.ok(positions.includes(layout.blocks[1].y)); assert.ok(positions.includes(layout.blocks[2].y));
  assert.equal(reader.y, layout.maxY);
});

test('reflowed PDF page turns have zero overlap, including after a phone jump', () => {
  const layout = make([prose('Body', 40), figure]);
  for (const y of [0, 127, 300]) {
    const before = pdfNativeWindow(layout, y);
    const nextY = pdfPageTurn(layout, y, 1);
    const after = pdfNativeWindow(layout, nextY);
    assert.equal(after.start, before.end);
    assert.equal(after.start - before.start, VISIBLE_LINES);
    assert.equal(pdfAutoStep(layout, y), layout.nativeRuns[0].rows[before.start + 1].y, 'autoscroll still advances one row');
  }
});

test('phone jumps into native PDF text keep progress, byte bounds and following figures reachable', () => {
  const block = prose('UTF8', 25); block.reflow.rows.forEach(row => { row.text = '漢'.repeat(50); });
  const layout = make([block, figure, prose('End', 2)]);
  const middle = pdfNativeWindow(layout, 127);
  assert.ok(byteLength(middle.content) <= TEXT_BYTES); assert.ok(middle.nextY > 127);
  let y = 127;
  while (pdfNativeWindow(layout, y)) { const next = pdfPageTurn(layout, y, 1); assert.ok(next > y); y = next; }
  assert.equal(y, layout.blocks[1].y);
});

function growingReader(blocks, lines) {
  const layout = make(blocks); const auto = new PdfAutoscroll(layout, lines); const reader = new Reader();
  reader.setDocument(layout.maxY, 0, layout.pages, null, auto); reader.setMode('auto'); reader.setSpeed(200); reader.togglePlay();
  for (let i = 0; !auto.window(reader.y) && i < 100; i++) reader.tick(.31);
  return { layout, auto, reader };
}

test('after an image, three native lines enter at the bottom before any text leaves the top', () => {
  const { auto, reader, layout } = growingReader([figure, prose('After', 20)]);
  const y = layout.blocks[1].y;
  for (let lines = 3; lines <= 9; lines++) {
    const frame = auto.window(reader.y);
    assert.equal(reader.y, y, 'first unread source line stays fixed while filling');
    assert.equal(frame.end - frame.start, lines); assert.equal(frame.padding, 9 - lines);
    assert.deepEqual(frame.content.split('\n'), [...Array(9 - lines).fill(''), ...Array.from({ length: lines }, (_, i) => `After row ${i}`)]);
    reader.tick(.31);
  }
  assert.equal(reader.y, y + 25);
  assert.equal(auto.window(reader.y).content.split('\n')[0], 'After row 1');
});

test('initial line count supports one-line entry and the previous full-screen behavior', () => {
  for (const lines of [1, 4, 9]) {
    const { auto, reader } = growingReader([figure, prose('After', 20)], lines);
    assert.equal(auto.window(reader.y).end, lines);
    assert.equal(auto.window(reader.y).padding, 9 - lines);
    assert.equal(Boolean(auto.window(reader.y).reveal), lines < 9);
  }
  assert.equal(pdfEntryLines(undefined), 3); assert.equal(pdfEntryLines(null), 3);
  assert.equal(pdfEntryLines(NaN), 3); assert.equal(pdfEntryLines(0), 1); assert.equal(pdfEntryLines(20), 9);
});

test('delayed display, pause and suspension cannot consume unseen reveal steps', () => {
  const { auto, reader } = growingReader([figure, prose('After', 20)]);
  const first = auto.window(reader.y);
  reader.tick(1, true); reader.tick(30); assert.deepEqual(auto.window(reader.y), first);
  reader.pause(); reader.tick(1); assert.deepEqual(auto.window(reader.y), first);
  reader.togglePlay(); reader.tick(.31);
  assert.equal(auto.window(reader.y).end, 4);
  assert.notEqual(auto.window(reader.y).reveal, first.reveal, 'same source y has distinct display identities');
});

test('a short final text run finishes revealing and can resume even at maximum source position', () => {
  for (const count of [2, 5, 9]) {
    const { auto, reader, layout } = growingReader([figure, prose('Tail', count)]);
    assert.equal(reader.y, layout.maxY);
    assert.equal(reader.playing, count > 3);
    if (count > 3) {
      reader.pause(); assert.equal(reader.canAutoAdvance, true); reader.togglePlay(); assert.equal(reader.playing, true);
      for (let i = 3; i < count; i++) reader.tick(.31);
    }
    assert.equal(reader.playing, false); assert.equal(reader.canAutoAdvance, false);
    assert.equal(auto.window(reader.y).end, count);
    assert.equal(auto.window(reader.y).content.split('\n').at(-1), `Tail row ${count - 1}`);
  }
});

test('manual jumps and mode changes cancel the entry animation, while the next figure starts it again', () => {
  const { auto, reader, layout } = growingReader([figure, prose('First', 12), figure, prose('Last', 12)]);
  const textY = reader.y; reader.jump(textY);
  assert.equal(auto.window(reader.y).padding, 0); assert.equal(auto.window(reader.y).end, 9);
  reader.jump(layout.blocks[2].y); reader.togglePlay();
  for (let i = 0; !auto.window(reader.y) && i < 100; i++) reader.tick(.31);
  assert.equal(auto.window(reader.y).end, 3);
  reader.setMode('page'); assert.equal(auto.window(reader.y).end, 9);
  reader.setMode('auto'); assert.equal(auto.window(reader.y).end, 9);
});

test('entry padding respects UTF-8 limits, including on the final text screen', () => {
  const block = prose('UTF8', 12); block.reflow.rows.forEach(row => { row.text = '漢'.repeat(50); });
  const { auto, reader } = growingReader([figure, block], 1);
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const window = auto.window(reader.y);
    assert.ok(byteLength(window.content) <= TEXT_BYTES);
    assert.ok(window.content.split('\n').length <= VISIBLE_LINES);
    for (let row = window.start; row < window.end; row++) seen.add(row);
    if (!reader.playing) break;
    reader.tick(.31);
  }
  assert.equal(seen.size, 12);
});

test('short text between figures rises through empty rows instead of losing its first line early', () => {
  const { auto, reader } = growingReader([figure, prose('Short', 2), figure, prose('After', 12)]);
  const y = reader.y;
  for (let padding = 7; padding >= 0; padding--) {
    const frame = auto.window(reader.y);
    assert.equal(reader.y, y); assert.equal(frame.padding, padding);
    assert.deepEqual(frame.content.split('\n').slice(padding), ['Short row 0', 'Short row 1']);
    reader.tick(.31);
  }
  assert.equal(auto.window(reader.y).content, 'Short row 1');
});
