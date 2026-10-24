import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfBodySize, separatePdfAnnotations, pdfSectionOrder, labelPdfAnnotation, pdfFootnoteStyle } from '../src/pdf-annotations.js';
import { reflowPdfBlock } from '../src/pdf-reflow.js';
import { createPdfLayout, pdfAnchor, restorePdfAnchor } from '../src/pdf-layout.js';
import { pdfNativeWindow } from '../src/pdf-native.js';
import { packPdfPreparation, unpackPdfPreparation } from '../src/pdf-cache.js';
import { pdfReadingViews } from '../src/pdf-notes.js';
const measure = text => text.length * 10;
const line = (text, y, height = 16, x = 60, width = 470) => ({ text, x, y, width, height });
const block = lines => ({ x: Math.min(...lines.map(l => l.x)), y: lines[0].y - 2, width: Math.max(...lines.map(l => l.width)),
  height: lines.at(-1).y + lines.at(-1).height - lines[0].y + 4, lines, text: lines.map(l => l.text).join(' '), kind: 'text' });
const prose = (text, y) => block([line(text + ' A body sentence with enough words to establish its size and source reference.', y), line('The next line continues the argument without interruption by smaller notes.', y + 22)]);
const heading = (text, y) => block([line(text, y, 18, 250, 100)]);
const page = (number, blocks) => ({ number, blocks, width: 600, height: 800 });
const prepare = pages => {
  const bodySize = pdfBodySize(pages);
  for (const p of pages) {
    p.blocks = separatePdfAnnotations(p, { bodySize, measure, pixels: p.pixels, pageWidth: p.width });
    for (const b of p.blocks) { b.reflow = reflowPdfBlock(b, { measure }); if (b.reflow) b.reflow.nativeWrap = 1; }
  }
  const order = pdfSectionOrder(pages).flatMap(e => {
    const b = labelPdfAnnotation(e.block, measure); return b.annotationLabel ? [{ ...e, block: b }, e] : [{ ...e, block: b }];
  });
  return createPdfLayout(pages, { readingOrder: order });
};

test('footnotes follow their titled section across pages, with original note numbers and source labels', () => {
  const pages = [page(1, [heading('I', 100), prose('First reference1', 200), block([line('1. Footnote starts here with an explanation.', 700, 12)])]),
    page(2, [prose('BodyContinuation with reference2', 110), heading('II', 300), prose('New section reference3', 350),
      block([line('the earlier footnote continues across a page.', 660, 12), line('2. Another note belonging to Section I.', 688, 12), line('3. A note belonging to Section II.', 716, 12)])]),
    page(3, [prose('Final body continuation', 100)])];
  const before = pages.flatMap(p => p.blocks.flatMap(b => b.lines.map(l => l.text))).sort();
  const layout = prepare(pages); const notes = layout.blocks.filter(b => b.annotation);
  assert.deepEqual(notes.map(b => b.annotation.number), ['1', '1', '2', '3']);
  assert.deepEqual(notes.map(b => b.annotation.section), ['Section I', 'Section I', 'Section I', 'Section II']);
  const endI = layout.blocks.findIndex(b => b.text.includes('BodyContinuation'));
  const startII = layout.blocks.findIndex(b => b.text === 'II');
  assert.ok(notes.slice(0, 3).every(b => layout.blocks.indexOf(b) > endI && layout.blocks.indexOf(b) < startII));
  assert.equal(layout.blocks.at(-1), notes[3]);
  assert.equal(notes[1].annotation.label, 'Footnote 1 (continued) — PDF page 2');
  assert.deepEqual(layout.blocks.flatMap(b => b.lines.map(l => l.text)).sort(), before, 'every source text item retained exactly once');
  const restored = unpackPdfPreparation(JSON.parse(JSON.stringify(packPdfPreparation(layout, new Map(), new Map([[1, 1], [2, 1], [3, 1]]))))).layout;
  assert.deepEqual(restored.blocks.map(b => b.annotation), layout.blocks.map(b => b.annotation));
  for (const note of notes) {
    assert.match(pdfNativeWindow(restored, note.y).content, /Footnote/);
    assert.equal(restorePdfAnchor(restored, pdfAnchor(layout, note.y)), Math.min(layout.maxY, note.y));
  }
});

test('citation volumes do not create fictitious note numbers; superscript URL markers are recognized', () => {
  const url = block([line('1', 680, 7, 60, 5), line('https://example.com/footnote', 682, 11, 66, 300)]);
  const pages = [page(1, [prose('Body', 200), block([line('26. A citation has a volume on the next line.', 620, 12),
    line('89 MICH. L. REV. 296 (1990). More text follows.', 638, 12), line('27. A separate numbered footnote.', 660, 12)]), url])];
  const layout = prepare(pages);
  assert.deepEqual(layout.blocks.filter(b => b.annotation).map(b => b.annotation.number), ['26', '27', '1']);
  assert.ok(layout.blocks.find(b => b.annotation?.number === '26').text.includes('89 MICH'));
});

test('lettered legal notes keep their markers without treating citation page numbers as new notes', () => {
  const p = page(1, [prose('Body', 200), block([line('a First legal footnote, volume and page follow.', 620, 12),
    line('164. A continuation citation, not a note number.', 638, 12), line('b Second legal footnote.', 664, 12), line('c Third legal footnote.', 700, 12)])]);
  const noteStyle = pdfFootnoteStyle([p], 16); assert.equal(noteStyle, 'letters');
  const notes = separatePdfAnnotations(p, { bodySize: 16, noteStyle }).filter(b => b.annotation);
  assert.deepEqual(notes.map(b => b.annotation.number), ['a', 'b', 'c']);
  assert.match(notes[0].text, /164\./);
});

test('captions immediately follow their figures; normal references and equations stay in the body', () => {
  const figure = { ...block([line('Plot label', 200, 12), line('Figure 2: A useful diagram.', 310, 16), line('Caption continuation.', 332, 16)]), kind: 'figure', y: 180, height: 173 };
  const math = block([line('x = y + 2 (1)', 450)]);
  const pages = [page(1, [heading('1 METHOD', 100), figure, prose('Figure 2 shows why this remains ordinary prose.', 380), math, heading('2 RESULTS', 520), prose('Results body', 560)])];
  const layout = prepare(pages); const caption = layout.blocks.find(b => b.annotation?.kind === 'caption');
  assert.ok(caption.reflow); assert.equal(caption.annotation.reference, 'Figure 2');
  assert.equal(caption.annotation.section, '1 METHOD');
  assert.ok(layout.blocks.find(b => b.kind === 'figure').height < figure.height);
  assert.equal(layout.blocks.indexOf(caption), layout.blocks.findIndex(b => b.kind === 'figure') + 1);
  assert.ok(layout.blocks.indexOf(caption) < layout.blocks.findIndex(b => b.text.includes('ordinary prose')));
  assert.ok(layout.blocks.indexOf(caption) < layout.blocks.findIndex(b => b.text === '2 RESULTS'));
  assert.ok(layout.blocks.find(b => b.text.includes('ordinary prose'))?.annotation == null);
  assert.ok(layout.blocks.some(b => b.text.includes('x = y') && !b.reflow && !b.annotation));
});

test('small body quotations, tables and numeric content do not become footnotes', () => {
  const quote = block([line('A short, smaller quotation within the main discussion.', 380, 12)]);
  const lower = prose('The discussion continues after the quotation.', 700);
  const table = { ...block([line('100 200 300', 730, 11)]), kind: 'figure' };
  const p = page(1, [prose('Body', 100), quote, lower, table]);
  assert.equal(separatePdfAnnotations(p, { bodySize: 16 }).filter(b => b.annotation).length, 0);
});

test('prose above a table cannot take its caption and reflow the table cells', () => {
  const intro = prose('A paragraph introducing the measurements.',100).lines;
  const lines = [...intro, line('Table 4-1. Input data for analysis',160),
    line('First header',190,16,60,150),line('Second header',190,16,330,150),
    line('Row A',220,16,60,100),line('12',220,16,330,40),
    line('Row B',245,16,60,100),line('24',245,16,330,40)];
  const image = { ...block(lines), kind:'figure', figureBounds:[{x:60,y:185,width:470,height:80}] };
  const p = page(1,[image]);
  const before = lines.map(l=>l.text).sort();
  const result = separatePdfAnnotations(p,{bodySize:16,measure});
  assert.deepEqual(result.flatMap(b=>b.lines.map(l=>l.text)).sort(),before);
  const table = result.find(b=>b.kind==='figure');
  assert.ok(table.lines.some(l=>l.text==='Row B'));
  assert.ok(!table.text.includes('paragraph introducing'));
  const c = result.find(b=>b.annotation?.kind==='caption');
  assert.equal(c.annotation.reference,'Table 4-1');
  assert.equal(c.text,'Table 4-1. Input data for analysis');
});

test('a compact bibliography and source-code example remain in the main reading order', () => {
  const references = block(Array.from({ length: 8 }, (_, i) => line(`${i + 1}. Author, A. A technical paper title. Journal (2025).`, 600 + i * 18, 11)));
  const code = block([line('<extra_id_0>System\\n{system}', 740, 11)]);
  for (const b of [references, code]) assert.equal(separatePdfAnnotations(page(1, [prose('Body', 200), b]), { bodySize: 16 }).filter(b => b.annotation).length, 0);
});

test('explicit endnotes and uncertain scanned small text are not split or relabeled as footnotes', () => {
  const notes = block([line('1. First endnote.', 630, 12), line('2. Second endnote.', 710, 12)]);
  const p = page(1, [prose('Body', 200), heading('NOTES', 560), notes]);
  const result = separatePdfAnnotations(p, { bodySize: 16 });
  assert.equal(result.length, p.blocks.length); assert.ok(result.every(b => !b.annotation));
  const scan = { ...notes, lines: notes.lines.map(line => ({ ...line, confidence: 80 })) };
  assert.ok(separatePdfAnnotations(page(1, [prose('Body', 200), scan]), { bodySize: 16 }).every(b => !b.annotation));
});

function continuedScan({ number = 2, rule = true, confidence = 93, noteSize = 12 } = {}) {
  const continued = block([line('Lewis, No Process of Law. This citation continues from the previous page.', 700, noteSize),
    line('It belongs to that footnote even though its number is not repeated.', 718, noteSize)]);
  continued.lines = continued.lines.map(row => ({ ...row, confidence }));
  const p = page(number, [prose('The main argument continues on the following page', 160), continued]);
  p.pixels = new Uint8ClampedArray(p.width * p.height * 4).fill(255);
  if (rule) for (let x = 60; x < 530; x++) p.pixels.fill(0, (691 * p.width + x) * 4, (691 * p.width + x) * 4 + 3);
  return p;
}
const precedingNote = () => page(1, [prose('Body reference2', 100), block([line('2. A long citation ends this page with Anthony', 700, 12)])]);

test('a ruled OCR footnote continuation is excluded from the body and labeled with its preceding number', () => {
  const pages = [precedingNote(), continuedScan(), page(3, [prose('The uninterrupted conclusion follows', 100)])];
  const full = prepare(pages); const { body, notes } = pdfReadingViews(full, { measure });
  assert.ok(!body.blocks.some(b => b.text.includes('Lewis, No Process')));
  const continuation = notes.blocks.find(b => b.text.includes('Lewis, No Process'));
  assert.equal(continuation.annotation.number, '2'); assert.equal(continuation.annotation.continued, true);
  assert.match(continuation.reflow.rows[0].text, /Footnote \[2\] \(continued\)/);
  assert.match(continuation.annotation.label, /PDF page 2/);
  assert.ok(body.blocks.some(b => b.text.includes('uninterrupted conclusion')));
  const saved = packPdfPreparation(full, new Map(), new Map([[1, 1], [2, 1], [3, 1]]));
  const reopened = pdfReadingViews(unpackPdfPreparation(JSON.parse(JSON.stringify(saved))).layout, { measure });
  assert.ok(!reopened.body.blocks.some(b => b.text.includes('Lewis, No Process')));
  assert.ok(reopened.notes.blocks.some(b => b.text.includes('Lewis, No Process') && b.annotation.continued));
});

test('an unnumbered ruled OCR block needs a recent numbered note; ordinary prose and uncertain OCR stay put', () => {
  const cases = [
    [continuedScan()],
    [precedingNote(), continuedScan({ number: 3 })],
    [precedingNote(), continuedScan({ rule: false })],
    [precedingNote(), continuedScan({ confidence: 40 })],
    [precedingNote(), continuedScan({ noteSize: 16 })],
  ];
  for (const pages of cases) {
    const views = pdfReadingViews(prepare(pages), { measure });
    assert.ok(views.body.blocks.some(b => b.text.includes('Lewis, No Process')), 'ambiguous block remains available in body');
  }
});

test('a table caption above the grid is detached without converting its cells to prose', () => {
  const table = { ...block([line('Table 4: A description above the grid.', 200, 16), line('Description continuation.', 222, 16),
    line('Model', 260, 12, 60, 80), line('Accuracy', 260, 12, 300, 80), line('First', 280, 12, 60, 80), line('95.2', 280, 12, 300, 80)]), kind: 'figure' };
  const result = separatePdfAnnotations(page(1, [table]), { bodySize: 16, measure });
  assert.equal(result.length, 2); assert.equal(result[0].annotation.reference, 'Table 4');
  assert.equal(result[1].kind, 'figure'); assert.match(result[1].text, /Accuracy/); assert.doesNotMatch(result[1].text, /description/i);
});

test('unheaded documents defer notes to the end and old source bookmarks survive split/labeled notes', () => {
  const first = page(1, [prose('OriginalBody1', 100), block([line('1. First footnote.', 600, 12), line('2. Second footnote source.', 630, 12),
    ...Array.from({ length: 8 }, (_, i) => line('More explanation belonging to the second note, with its source coordinates preserved.', 648 + i * 16, 12))])]);
  for (const b of first.blocks) { b.reflow = reflowPdfBlock(b, { measure }); b.reflow.nativeWrap = 1; }
  const old = createPdfLayout([first]); const oldNote = old.blocks[1];
  const sourceRow = oldNote.reflow.rows.find(row => row.text.includes('Second'));
  const saved = pdfAnchor(old, oldNote.y + sourceRow.y);
  const layout = prepare([first, page(2, [prose('ContinuedBody', 100)])]);
  const note = layout.blocks.find(b => b.annotation?.number === '2');
  assert.ok(note.y > layout.blocks.find(b => b.text.includes('ContinuedBody')).y);
  const y = restorePdfAnchor(layout, saved);
  assert.ok(y >= note.y && y < note.y + note.drawHeight);
  assert.match(pdfNativeWindow(layout, y).content, /Second footnote/);
});

test('a raster note has a native source label without changing its source bookmark target', () => {
  const source = { ...block([line('1. x = y + z', 700, 12)]), annotation: { kind: 'footnote', number: '1', label: 'Footnote 1 — PDF page 1' } };
  const label = labelPdfAnnotation(source, measure); assert.equal(label.annotationLabel, true);
  const pages = [page(1, [source])];
  const layout = createPdfLayout(pages, { readingOrder: [{ page: 1, block: label }, { page: 1, block: source }] });
  assert.match(pdfNativeWindow(layout, 0).content, /Footnote 1/);
  assert.equal(pdfNativeWindow(layout, layout.blocks[1].y), null);
  assert.equal(restorePdfAnchor(layout, pdfAnchor(layout, 0)), layout.blocks[1].y);
});

test('prose touching an image-only plot separates even when the plot has no embedded labels', () => {
  const lines=Array.from({length:4},(_,i)=>line('An introductory paragraph remains readable above the plot, without becoming part of the image.',100+i*22));
  const plot={...block(lines),kind:'figure',height:340,figureBounds:[{x:60,y:188,width:470,height:250}]};
  const result=separatePdfAnnotations(page(1,[plot]),{bodySize:16,measure});
  assert.equal(result.length,2);assert.equal(result[0].kind,'text');assert.equal(result[1].kind,'figure');
  assert.deepEqual(result[0].lines,lines);assert.deepEqual(result[1].lines,[]);
  assert.ok(result[0].y+result[0].height<=188);assert.ok(result[1].y<=188);
});
