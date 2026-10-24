import test from 'node:test';
import assert from 'node:assert/strict';
import { createPdfLayout, pdfAnchor } from '../src/pdf-layout.js';
import { updatePdfReader } from '../src/pdf-progress.js';
import { reflowPdfBlock } from '../src/pdf-reflow.js';
import { Reader } from '../src/reader.js';
import { statusText } from '../src/glasses.js';
import { packPdfPreparation } from '../src/pdf-cache.js';

function page(number) {
  const lines = Array.from({ length: 15 }, (_, i) => ({ x: 40, y: 100 + i * 20, width: 480, height: 14,
    text: `Page ${number} line ${i} has repeated words and a unique position.` }));
  const block = { x: 40, y: 100, width: 480, height: 300, kind: 'text', lines, text: lines.map(l => l.text).join(' ') };
  block.reflow = reflowPdfBlock(block, { fontSize: 20, measure: text => text.length * 10 });
  block.reflow.nativeWrap = 1;
  return { number, width: 600, height: 800, blocks: [block] };
}
const layout = n => createPdfLayout(Array.from({ length: n }, (_, i) => page(i + 1)));

test('preparing more PDF pages preserves the session average and dwell while extending the estimate', () => {
  const reader = new Reader(), first = layout(5), next = layout(10);
  updatePdfReader(reader, null, first, null, 3);
  for (let i = 0; i < 5; i++) { reader.tick(1); reader.pageStep(1); }
  assert.equal(reader.pagesRead, 5);
  const estimate = reader.pageRemainingSeconds, anchor = pdfAnchor(first, reader.y);
  reader.tick(.75);
  updatePdfReader(reader, first, next, null, 3);
  assert.equal(reader.pagesRead, 5); assert.equal(reader.pageReadSeconds, 5); assert.equal(reader.pageDwellSeconds, .75);
  assert.deepEqual(pdfAnchor(next, reader.y).pdf, anchor.pdf);
  assert(reader.pageRemainingSeconds > estimate);
  updatePdfReader(reader, null, next, anchor, 3);
  assert.equal(reader.pageRemainingSeconds, undefined, 'a fresh PDF opening resets the average');
});

test('incremental pages retain exact reading source, playback and elapsed dwell', () => {
  const reader = new Reader(); const first = layout(1); const next = layout(3);
  updatePdfReader(reader, null, first, null, 3);
  reader.setMode('auto'); reader.jump(150); reader.togglePlay(); reader.elapsed = .23;
  const anchor = pdfAnchor(first, reader.y);
  updatePdfReader(reader, first, next, null, 3);
  assert.deepEqual(pdfAnchor(next, reader.y).pdf, anchor.pdf);
  assert.equal(reader.playing, true); assert.equal(reader.elapsed, .23);
  assert.equal(reader.maxY, next.maxY);
  reader.pause(); updatePdfReader(reader, next, layout(4), null, 3);
  assert.equal(reader.playing, false, 'user pause is preserved');
});

test('growing PDFs preserve the exact word within a row, even when earlier text changes length', () => {
  const reader = new Reader(); const first = layout(2);
  updatePdfReader(reader, null, first, null, 3); reader.setMode('speed'); reader.setWordGroup(1);
  reader.speedReading.seek(193); reader.syncWords(); reader.togglePlay(); reader.elapsed = .01;
  const saved = reader.speedReading.saved;
  const pages = [page(1), page(2), page(3)];
  pages[0].blocks[0].reflow.rows.unshift({ text: 'An added caption with several words', y: 0, items: [] });
  const next = createPdfLayout(pages);
  updatePdfReader(reader, first, next, null, 3);
  assert.equal(reader.speedReading.saved.key, saved.key);
  assert.equal(reader.speedReading.saved.text, saved.text);
  assert.notEqual(reader.speedReading.saved.index, saved.index);
  assert.equal(reader.playing, true); assert.equal(reader.elapsed, .01);
});

test('incremental layouts preserve gradual entry after images and do not resume paused reading', () => {
  const reader = new Reader(); const first = layout(1);
  updatePdfReader(reader, null, first, null, 3); reader.setMode('auto'); reader.jump(50);
  reader.autoPosition.fill = { y: 50, padding: 4 };
  updatePdfReader(reader, first, layout(2), null, 3);
  assert.deepEqual(reader.autoPosition.fill, { y: 50, padding: 4 });
  assert.equal(reader.playing, false);
});

test('a partial end is never labeled as the end of a complete document', () => {
  const partial = layout(1); partial.preparation = { complete: false, readyPages: 1, totalPages: 28 };
  assert.match(statusText({ layout: partial, y: partial.maxY, mode: 'page' }), /Preparing more.*1\/28/);
  assert.doesNotMatch(statusText({ layout: partial, mode: 'speed', finished: true }), /restart|Finished/);
  partial.preparation.failed = true;
  assert.match(statusText({ layout: partial, mode: 'speed', finished: true }), /Preparation stopped/);
  assert.throws(() => packPdfPreparation(partial, new Map(), new Map()), /incomplete/);
});
