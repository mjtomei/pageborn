import test from 'node:test';
import assert from 'node:assert/strict';
import { readPdfText, pdfFontAscent, pdfHasScanTranscript, pdfRomanHeadingHints, restorePdfRomanHeadings } from '../src/pdf-text.js';

test('missing font ascents use a real baseline offset, while valid font metrics survive', () => {
  assert.equal(pdfFontAscent({ ascent: 0, descent: 0 }), .8);
  assert.equal(pdfFontAscent({ ascent: 0, descent: -.25 }), .75);
  assert.equal(pdfFontAscent({ ascent: .437, descent: -.011 }), .437);
  assert.equal(pdfFontAscent({ ascent: 1.196, descent: -.439 }), 1.196);
  assert.equal(pdfFontAscent(), .8);
  assert.equal(pdfFontAscent({ ascent: NaN, descent: -2 }), .8);
});

test('isolated centered Roman transcript headings can repair uncertain scan recognition', () => {
  const roman = { text: 'IV', x: 280, y: 300, width: 20, height: 18 };
  const body = { text: 'This is a substantial paragraph that starts directly below the section heading.', x: 50, y: 340, width: 500, height: 18 };
  const hints = pdfRomanHeadingHints([roman, body], 600, 800);
  assert.equal(hints.length, 1);
  const repaired = restorePdfRomanHeadings([{ ...roman, text: 'Iv', confidence: 60 }, body], hints);
  assert.equal(repaired[0].text, 'IV'); assert.equal(repaired[0].heading, true); assert.equal(repaired[1], body);
  assert.equal(restorePdfRomanHeadings([body], hints)[0].text, 'IV', 'an omitted heading is restored');
  assert.equal(pdfRomanHeadingHints([{ ...roman, x: 50 }, body], 600, 800).length, 0);
  assert.equal(pdfRomanHeadingHints([{ ...roman, y: 10 }, body], 600, 800).length, 0);
  assert.equal(pdfRomanHeadingHints([roman], 600, 800).length, 0);
});

test('a page scan with invisible text is re-read, while visible text and small images stay embedded', () => {
  const codes = { setTextRenderingMode: 7 };
  const ops = { fnArray: [7], argsArray: [[3]] };
  assert.equal(pdfHasScanTranscript(ops, codes, [0, 0, 1, 0, 0, .94]), true);
  assert.equal(pdfHasScanTranscript(ops, codes, [0, 0, .2, 0, 0, .2]), false);
  assert.equal(pdfHasScanTranscript({ ...ops, argsArray: [[0]] }, codes, [0, 0, 1, 0, 0, 1]), false);
  assert.equal(pdfHasScanTranscript(ops, codes, [0, 0, 1, 1, 1, 1]), false, 'degenerate bounds do not count as a scan');
});

test('PDF text extraction merges all chunks without ReadableStream async iteration', async () => {
  const first = { str: 'First paragraph', fontName: 'one' };
  const second = { str: 'Second paragraph', fontName: 'two' };
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue({ items: [first], styles: { one: { ascent: .8 } }, lang: null });
    controller.enqueue({ items: [second], styles: { two: { ascent: .9 } }, lang: 'en' });
    controller.close();
  } });
  Object.defineProperty(stream, Symbol.asyncIterator, { value: undefined });
  const content = await readPdfText({ streamTextContent: () => stream });
  assert.deepEqual(content.items, [first, second]);
  assert.deepEqual({ ...content.styles }, { one: { ascent: .8 }, two: { ascent: .9 } });
  assert.equal(Object.getPrototypeOf(content.styles), null);
  assert.equal(content.lang, 'en'); assert.equal(stream.locked, false);
});

test('PDF text extraction preserves the worker error and releases its reader', async () => {
  const failure = new Error('PDF worker closed');
  const stream = new ReadableStream({ start(controller) { controller.error(failure); } });
  await assert.rejects(readPdfText({ streamTextContent: () => stream }), error => error === failure);
  assert.equal(stream.locked, false);
});

test('a malformed text chunk cancels the remaining stream and releases the reader', async () => {
  let cancelled;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue({ items: null }); },
    cancel(reason) { cancelled = reason; },
  });
  await assert.rejects(readPdfText({ streamTextContent: () => stream }), TypeError);
  assert.ok(cancelled instanceof TypeError); assert.equal(stream.locked, false);
});

test('unusable embedded text triggers OCR while ordinary Unicode and math remain embedded', async () => {
  const { pdfTextNeedsOcr } = await import('../src/pdf-text.js');
  const box = (text, extra = {}) => ({ text, x: 50, y: 50, width: 400, height: 16, ...extra });
  assert.equal(pdfTextNeedsOcr([box('A complete and useful embedded sentence.')]), false);
  assert.equal(pdfTextNeedsOcr([box('최정연 삼성전자 부사장: 에이전트 AI 시범 활용과 정보 제공 내용입니다.')]), false);
  assert.equal(pdfTextNeedsOcr([box('Equation and explanation: x = y + z.\nThe next line contains\ta tab.')]), false);
  assert.equal(pdfTextNeedsOcr([box('Many characters but invalid Type 3 font geometry.', { height: .7 })]), true);
  assert.equal(pdfTextNeedsOcr([box('These coordinates will not attach to any source crop.', { x: NaN })]), true);
  assert.equal(pdfTextNeedsOcr([box('Broken\x03font\x03codes\x03make\x03this\x03unreadable\x03despite\x03having\x03many\x03characters')]), true);
  assert.equal(pdfTextNeedsOcr([box('An isolated odd character \ufffd in an otherwise readable paragraph should not force OCR.')]), false);
  assert.equal(pdfTextNeedsOcr([box('T h e pri n ci pl es t h at g o v er n t h e s ur vi v al of si g n als i n m ar k ets c a n b e a p pli e d t o ot h er c o nt e xts. '.repeat(5))]), true);
  assert.equal(pdfTextNeedsOcr([box('I am a reader and I have a useful text layer with ordinary English words. '.repeat(5))]), false);
  assert.equal(pdfTextNeedsOcr([box('x = y + z; a = b + c; p = q + r; '.repeat(20))]), false);
});
