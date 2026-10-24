import test from 'node:test';
import assert from 'node:assert/strict';
import { reflowPdfBlock, pdfTextRows, joinPdfTextTails, joinPdfTextFragments } from '../src/pdf-reflow.js';
import { createPdfLayout, pdfAnchor, restorePdfAnchor, pdfPageTurn, PDF_SCREEN, analyzePdfPage } from '../src/pdf-layout.js';

const line = (text, y, x = 50, width = 490) => ({ text, x, y, width, height: 12 });

test('a detached descender reconnects to text, but separate strokes and figures remain visible', () => {
  const width = 300; const pixels = new Uint8ClampedArray(width * 200 * 4).fill(255);
  for (let y = 40; y < 56; y++) pixels.fill(0, (y * width + 100) * 4, (y * width + 100) * 4 + 3);
  const title = { x: 50, y: 30, width: 200, height: 20, kind: 'text', text: 'Giving Reasons', lines: [{ ...line('Giving Reasons', 30), height: 22 }] };
  const tail = { x: 99, y: 50, width: 8, height: 6, kind: 'scan', text: '', lines: [] };
  const joined = joinPdfTextFragments([title, tail], pixels, width);
  assert.equal(joined.length, 1); assert.equal(joined[0].height, 26); assert.equal(title.height, 20);
  for (const separate of [{ ...tail, y: 52 }, { ...tail, kind: 'figure' }, { ...tail, height: 35 }, { ...tail, x: 120 }]) {
    assert.equal(joinPdfTextFragments([title, separate], pixels, width).length, 2);
  }
});

test('a detached heading ascender rejoins its text without swallowing a separate ornament', () => {
  const width = 300; const pixels = new Uint8ClampedArray(width * 200 * 4).fill(255);
  for (let y = 30; y < 45; y++) pixels.fill(0, (y * width + 100) * 4, (y * width + 100) * 4 + 3);
  const head = { x: 98, y: 30, width: 8, height: 4, kind: 'scan', text: '', lines: [] };
  const title = { x: 90, y: 34, width: 90, height: 12, kind: 'text', text: 'Abstract', lines: [{ ...line('Abstract', 30, 90, 90), height: 16 }] };
  const joined = joinPdfTextFragments([head, title], pixels, width);
  assert.equal(joined.length, 1); assert.equal(joined[0].y, 30); assert.equal(joined[0].height, 16);
  assert.equal(title.y, 34); assert.equal(joinPdfTextFragments([{ ...head, y: 26 }, title], pixels, width).length, 2);
});

test('short top-aligned asterisks retain their transcript when its font center falls below the ink', () => {
  const width = 300, height = 200, data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const x of [130, 145, 160]) for (let y = 70; y < 74; y++) for (let xx = x; xx < x + 4; xx++) data.fill(0, (y * width + xx) * 4, (y * width + xx) * 4 + 3);
  const text = [{ ...line('* * *', 68, 130, 34), height: 16 }];
  const result = analyzePdfPage({ width, height, data, text });
  assert.equal(result.blocks.length, 1); assert.equal(result.blocks[0].text, '* * *');
  assert.equal(reflowPdfBlock(result.blocks[0]).text, '* * *');
});
function prose() {
  const lines = Array.from({ length: 20 }, (_, i) => line(`Paragraph line ${i} has enough words to wrap onto several readable screen lines.`, 50 + i * 16));
  return { x: 49, y: 48, width: 492, height: 330, lines, kind: 'text', fillWidth: true, text: lines.map(l => l.text).join(' ') };
}

test('PDF prose wraps at readable sizes without losing long Unicode words', () => {
  const block = prose(); block.lines[4].text += ' ' + '𝒙'.repeat(120);
  const small = reflowPdfBlock(block, { fontSize: 20 }); const large = reflowPdfBlock(block, { fontSize: 28 });
  assert.ok(large.rows.length > small.rows.length);
  assert.equal(large.rows.map(r => r.text).join('').replace(/\s/g, ''), block.lines.map(l => l.text).join('').replace(/\s/g, ''));
  assert.ok(large.rows.every(row => [...row.text].length * 28 * .52 <= 552));
  assert.ok(large.rows.every(row => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(row.text)));
});

test('font runs join within words, hyphenation joins lines, and paragraphs remain separate', () => {
  const lines = [line('inter', 50, 50, 25), line('esting words at the end of a para-', 50, 75, 300),
    line('graph can continue here without a dash.', 66), line('A new paragraph keeps its own space.', 100)];
  assert.equal(pdfTextRows(lines)[0].text, 'interesting words at the end of a para-');
  const result = reflowPdfBlock({ ...prose(), lines });
  assert.equal(result.text, 'interesting words at the end of a paragraph can continue here without a dash.\n\nA new paragraph keeps its own space.');
  for (const hyphen of ['‐', '\u00ad']) {
    lines[1].text = `esting words at the end of a para${hyphen} `;
    assert.equal(reflowPdfBlock({ ...prose(), lines }).text, result.text);
  }
  const compound = [line('The narrower principle follows the stipulated-to-', 50), line('be-sound broader principle.', 66)];
  assert.match(reflowPdfBlock({ ...prose(), lines: compound }).text, /stipulated-to-be-sound/);
});

test('short embedded paragraph endings and headings use the selected reflow size', () => {
  for (const text of ['or explanations.', 'traditionally recognized?', 'I', 'Giving Reasons', '1869, 364).', '50']) {
    const block = { ...prose(), lines: [line(text, 50)] };
    const result = reflowPdfBlock(block, { fontSize: 20 });
    assert.equal(result.text, text); assert.equal(result.fontSize, 20);
  }
  assert.equal(reflowPdfBlock({ ...prose(), lines: [line('x = 2', 50)] }), null);
  assert.equal(reflowPdfBlock({ ...prose(), lines: [{ ...line('OCR', 50), confidence: 45 }] }), null);
});

test('a split paragraph tail rejoins the body and keeps hyphenation intact', () => {
  const first = { ...prose(), y: 48, height: 30, lines: [line('This is a sufficiently long paragraph with a divided word.', 50), line('The argument connects gener-', 66)] };
  first.text = first.lines.map(t => t.text).join(' ');
  const tail = { ...prose(), y: 82, height: 15, lines: [line('ality to rationality.', 82)] }; tail.text = tail.lines[0].text;
  const joined = joinPdfTextTails([first, tail]);
  assert.equal(joined.length, 1); assert.equal(first.lines.length, 2, 'source blocks are not mutated');
  assert.match(reflowPdfBlock(joined[0]).text, /generality to rationality/);
  assert.equal(joinPdfTextTails([first, { ...tail, x: 90 }]).length, 2, 'indented text remains separate');
  assert.equal(joinPdfTextTails([first, { ...tail, kind: 'figure' }]).length, 2);
});

test('double-spaced source lines continue without blank paragraphs while new paragraphs stay separate', () => {
  const first = { ...prose(), y: 48, height: 16, lines: [line('This is a sufficiently long source line that ends in the middle of', 50)] };
  first.text = first.lines[0].text;
  const tail = { ...prose(), y: 80, height: 16, lines: [line('a sentence that continues across the source line break.', 82)] };
  tail.text = tail.lines[0].text;
  const joined = joinPdfTextTails([first, tail]);
  assert.equal(joined.length, 1);
  assert.equal(reflowPdfBlock(joined[0]).text, first.text + ' ' + tail.text);
  assert.equal(tail.lines[0].continuation, undefined, 'source text is not mutated');
  assert.equal(joinPdfTextTails([first, { ...tail, lines: [line('A new paragraph starts here.', 82)], text: 'A new paragraph starts here.' }]).length, 2);
  assert.equal(joinPdfTextTails([first, { ...tail, y: 120 }]).length, 2, 'a larger paragraph gap stays separate');
});

test('approximate embedded text boxes can reflow a scanned line without accepting unexplained graphics', () => {
  const width = 300; const pixels = new Uint8ClampedArray(width * 100 * 4).fill(255);
  const block = { x: 10, y: 10, width: 280, height: 60, kind: 'text', lines: [line('A paragraph with an approximate embedded text box.', 22, 20, 240)] };
  for (let y = 17; y < 31; y++) for (let x = 15; x < 257; x++) pixels.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
  assert.ok(reflowPdfBlock(block, { pixels, pageWidth: width }));
  for (let y = 45; y < 65; y++) for (let x = 15; x < 270; x++) pixels.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
  assert.equal(reflowPdfBlock(block, { pixels, pageWidth: width }), null);
});

test('a thin footnote separator does not force a text block to remain a scan', () => {
  const width = 300; const pixels = new Uint8ClampedArray(width * 100 * 4).fill(255);
  const block = { x: 10, y: 10, width: 280, height: 60, kind: 'text', lines: [line('A footnote with its first line.', 20, 20, 240), line('And a short second line.', 40, 20, 200)] };
  const rect = (x, y, w, h) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) pixels.fill(0, (yy * width + xx) * 4, (yy * width + xx) * 4 + 3); };
  rect(10, 10, 280, 2); rect(20, 22, 240, 2); rect(20, 42, 200, 2);
  assert.ok(reflowPdfBlock(block, { pixels, pageWidth: width }));
  rect(10, 56, 280, 14);
  assert.equal(reflowPdfBlock(block, { pixels, pageWidth: width }), null, 'a thick unexplained graphic is retained');
});

test('figures, low-confidence OCR, displayed math and unruled tables remain images', () => {
  assert.equal(reflowPdfBlock({ ...prose(), kind: 'figure' }), null);
  assert.equal(reflowPdfBlock({ ...prose(), lines: [ { ...line('OCR words are not reliable enough to replace the scan.', 50), confidence: 40 } ] }), null);
  assert.equal(reflowPdfBlock({ ...prose(), lines: [line('alpha = beta ∑ gamma ∫ delta √ epsilon', 50)] }), null);
  const lines = Array.from({ length: 6 }, (_, n) => [line('Long row label', 50 + n * 16, 50, 100), line('Value here', 50 + n * 16, 350, 60)]).flat();
  assert.equal(reflowPdfBlock({ ...prose(), lines }), null);
});

test('recognized labels cannot replace a scan containing unexplained figure ink', () => {
  const width = 100; const pixels = new Uint8ClampedArray(width * 100 * 4).fill(255);
  const block = { x: 0, y: 0, width, height: 100, kind: 'scan', lines: [line('Four words are enough to label a figure.', 10, 10, 80)] };
  for (let y = 12; y < 20; y++) for (let x = 12; x < 88; x++) pixels.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
  assert.ok(reflowPdfBlock(block, { pixels, pageWidth: width }));
  for (let y = 40; y < 80; y++) for (let x = 5; x < 95; x++) pixels.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
  assert.equal(reflowPdfBlock(block, { pixels, pageWidth: width }), null);
});

test('reflow bookmarks retain text position across sizes and return to source image coordinates', () => {
  const block = prose();
  const trailing = { ...block, y: 500 };
  const make = fontSize => createPdfLayout([{ number: 1, blocks: [{ ...block, reflow: reflowPdfBlock(block, { fontSize }) }, trailing] }], { textSize: fontSize });
  const first = make(24); const y = first.blocks[0].reflow.rows[17].y + 3;
  const anchor = pdfAnchor(first, y); assert.equal(restorePdfAnchor(make(24), anchor), y);
  const large = make(28); const restored = restorePdfAnchor(large, anchor);
  const row = large.blocks[0].reflow.rows.findLast(row => row.y <= restored);
  assert.ok(row.start <= anchor.pdf.textOffset && row.end >= anchor.pdf.textOffset - 1);
  // A renderer upgrade changes wrapping even when the preview font is unchanged.
  large.blocks[0].reflow.fontSize = 24; large.blocks[0].reflow.nativeWrap = 1;
  assert.equal(restorePdfAnchor(large, anchor), restored);
  const raster = createPdfLayout([{ number: 1, blocks: [block, trailing] }]);
  const imageY = restorePdfAnchor(raster, anchor);
  assert.ok(Math.abs(pdfAnchor(raster, imageY).pdf.y - anchor.pdf.y) < 1);
});

test('paging defers a fitting figure intact and keeps oversized figures scrollable', () => {
  const make = (width, height, fitFigures = true) => createPdfLayout([{ number: 1, blocks: [
    { ...prose(), height: 90 },
    { x: 50, y: 180, width, height, fillWidth: true, kind: 'figure', lines: [], text: '' },
    { ...prose(), y: 700 },
  ] }], { fitFigures });
  const layout = make(400, 260); const figure = layout.blocks[1];
  assert.equal(figure.drawHeight, PDF_SCREEN); assert.equal(figure.keepTogether, true);
  assert.equal(pdfPageTurn(layout, 0, 1), figure.y);
  assert.ok(pdfPageTurn(layout, figure.y, 1) <= figure.y + PDF_SCREEN);
  assert.equal(make(400, 900).blocks[1].keepTogether, false);
  assert.equal(make(400, 260, false).blocks[1].keepTogether, false);
});

test('tiny scan debris does not become an oversized screen', () => {
  const width = 600; const height = 800; const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const rect = (x, y, w, h) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) data.fill(0, (yy * width + xx) * 4, (yy * width + xx) * 4 + 3); };
  rect(60, 40, 2, 150); rect(400, 220, 20, 12); rect(250, 300, 250, 100);
  const page = analyzePdfPage({ width, height, data }); const layout = createPdfLayout([{ number: 1, ...page }]);
  assert.ok(layout.blocks.every(b => b.scale <= 4));
  assert.ok(layout.blocks.every(b => b.width >= 5));
  assert.ok(layout.blocks.find(b => b.sourceY > 200 && b.sourceY < 230).scale <= 2);
});

test('shifted italic scan words stay in their source line without merging the next line', () => {
  const lines = [line('Alpha', 50, 50, 55), line('italic', 58, 120, 45), line('omega', 50, 180, 55),
    line('Another line stays separate.', 68, 50, 300)];
  const rows = pdfTextRows(lines);
  assert.deepEqual(rows.map(row => row.text), ['Alpha italic omega', 'Another line stays separate.']);
  assert.equal(rows.flatMap(row => row.items).length, lines.length);
});

test('wide justified spaces without aligned column gutters remain prose', () => {
  const lines = Array.from({ length: 6 }, (_, n) => [line('Some words before a justified gap', 50 + n * 16, 50, 40 + n * 60),
    line('and the rest of this sentence.', 50 + n * 16, 140 + n * 60, 90)]).flat();
  assert.ok(reflowPdfBlock({ ...prose(), lines }), 'varying gaps are not a table');
  const table = Array.from({ length: 6 }, (_, n) => [line('A table row label', 50 + n * 16, 50, 100),
    line('First value', 50 + n * 16, 250, 50), line('Second value', 50 + n * 16, 420, 80)]).flat();
  assert.equal(reflowPdfBlock({ ...prose(), lines: table }), null, 'aligned two- and three-column table gutters remain protected');
});
