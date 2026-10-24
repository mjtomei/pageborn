import test from 'node:test';
import assert from 'node:assert/strict';
import { associatePdfCaptions, pdfGalleryItems, splitPdfCaptionColumns, pdfCaptionReference, reunitePdfFigureFragments, protectPdfCaptionedExhibits } from '../src/pdf-captions.js';
import { pdfSectionOrder } from '../src/pdf-annotations.js';

const figure = (x, y, captionId) => ({ kind: 'figure', x, y, width: 220, height: 100, lines: [], text: '', captionId });
const caption = (text, x, y) => ({ kind: 'text', x, y, width: 220, height: 20, lines: [{ text, x, y, width: 220, height: 16 }], text,
  annotation: { kind: 'caption', reference: text.split(':')[0] } });
const page = blocks => ({ number: 1, width: 600, height: 800, blocks });

test('chapter and decimal caption numbers are recognized without matching ordinary references', () => {
  for (const reference of ['Figure 3-2', 'Table 4.3', 'Fig. S1', 'Table IV']) {
    assert.equal(pdfCaptionReference(`${reference}. Description.`), reference);
  }
  assert.equal(pdfCaptionReference('Figure 3-2 provides a visual representation.'), undefined);
});

test('captions between neighboring figures stay with the preceding figure in the same column', () => {
  const wide = { ...figure(30,100), width: 500 };
  const narrow = figure(300,236);
  const c = { ...caption('Figure 3: Full width.',30,210), width: 500 };
  assert.equal(associatePdfCaptions([page([wide,narrow,c])]).get(c), wide);
  const first = { ...figure(30,100), width: 420 };
  const next = figure(130,254);
  const between = caption('Table 15: Results.',130,216);
  assert.equal(associatePdfCaptions([page([first,next,between])]).get(between), first);
});

test('drawing fragments reunite but a slight bounding-box overlap cannot absorb a preceding caption', () => {
  const bounds = { x: 100, y: 100, width: 300, height: 160 };
  const a = { ...figure(100,100), width: 300, height: 130, figureBounds: [bounds] };
  const b = { ...figure(100,230), width: 300, height: 30, figureBounds: [bounds] };
  const c = { ...caption('Figure 1: Previous drawing.',30,65), kind: 'figure', height: 40, figureBounds: [bounds] };
  const merged = reunitePdfFigureFragments([c,a,b]);
  assert.equal(merged.length, 2); assert.equal(merged[0].kind, 'text');
  assert.equal(merged[1].height,160);
});

test('explicit form exhibits and scanned screenshots enter the gallery; ordinary prose stays text', () => {
  const c = caption('Figure 6: Instructions shown to participants.',40,100);
  const form = [caption('Study goals',120,200),caption('Terms and conditions',120,300)];
  for (const b of form) delete b.annotation;
  const result = protectPdfCaptionedExhibits(page([c,...form]));
  assert.equal(result.length,2); assert.equal(result[1].kind,'figure');
  assert.equal(result[1].captionId,'Figure 6');
  assert.deepEqual(result[1].lines,form.flatMap(b=>b.lines));
  const ordinary = { ...c, text: 'Figure 6: Experimental results.' };
  assert.equal(protectPdfCaptionedExhibits(page([ordinary,...form])).length,3);
  const scan = { ...figure(60,100), kind:'scan' };
  const label = caption('Figure 5: Phone interface.',40,230);
  assert.equal(protectPdfCaptionedExhibits(page([scan,label]))[0].kind,'figure');
});

test('column captions use their own figures, explicit split ownership wins, unmatched captions stay in place', () => {
  const left = figure(30, 200); const right = figure(330, 200);
  const a = caption('Figure 1: Left panel.', 30, 310); const b = caption('Figure 2: Right panel.', 330, 310);
  const orphan = caption('Figure 9: No image here.', 330, 700);
  const pages = [page([left, right, a, b, orphan])];
  const order = pdfSectionOrder(pages).map(entry => entry.block);
  assert.deepEqual(order, [left, a, right, b, orphan]);
  assert.equal(left.figureCaption.text, a.text); assert.equal(right.figureCaption.text, b.text);
  assert.notEqual(left.figureId, right.figureId);
  const separate = figure(30, 600, 'Table 3'); const near = figure(30, 170);
  const top = caption('Table 3: Explicit ownership.', 30, 150);
  assert.equal(associatePdfCaptions([page([top, near, separate])]).get(top), separate);
});

test('gallery excludes equations and caption labels; serialized metadata retains captions', () => {
  const image = figure(30, 200); const c = caption('Figure 1: Complete caption.', 30, 310);
  associatePdfCaptions([page([image, c])]);
  const layout = { format: 'pdf', blocks: [{ ...image, page: 1, sourceY: image.y, y: 800 }, c,
    { ...figure(30, 400), kind: 'text', text: 'x = y' }, { ...image, annotationLabel: true }] };
  const [item] = pdfGalleryItems(layout);
  assert.equal(pdfGalleryItems(layout).length, 1); assert.equal(item.caption, c.text);
  assert.deepEqual(pdfGalleryItems(JSON.parse(JSON.stringify(layout))), JSON.parse(JSON.stringify([item])));
});

test('independent neighboring captions split only through empty pixels without losing text', () => {
  const lines = [{ text: 'Table 1: Results.', x: 30, y: 100, width: 210, height: 16 },
    { text: 'Figure 2: Training.', x: 260, y: 100, width: 200, height: 16 }];
  const block = { kind: 'figure', x: 30, y: 90, width: 450, height: 220, lines, text: lines.map(l => l.text).join(' ') };
  const pixels = new Uint8ClampedArray(600 * 800 * 4).fill(255);
  const split = splitPdfCaptionColumns(block, pixels, 600);
  assert.equal(split.length, 2); assert.deepEqual(split.flatMap(b => b.lines), lines);
  assert.equal(split[0].width + split[1].width, block.width);
  for (let y = 150; y < 250; y++) pixels.fill(0, (y * 600 + 249) * 4, (y * 600 + 252) * 4);
  assert.equal(splitPdfCaptionColumns(block, pixels, 600).length, 1, 'crossing drawings must stay intact');
});
