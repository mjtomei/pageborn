import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfImageFrame } from '../src/pdf-image-frame.js';

const image = (y, drawHeight) => ({ y, drawHeight });
const prose = y => ({ y, drawHeight: 400, reflow: {} });

test('short images have equal top/bottom space and do not pull in adjacent prose', () => {
  const layout = { blocks: [prose(0), image(412, 80), prose(504)] };
  const before = JSON.stringify(layout);
  assert.deepEqual(pdfImageFrame(layout, 412, 258), { y: 412, end: 492, top: 89 });
  assert.deepEqual(pdfImageFrame(layout, 439, 258), { y: 412, end: 492, top: 89 }, 'autoscroll holds the whole short figure');
  assert.equal(JSON.stringify(layout), before, 'source and cached layout are not changed');
  assert.deepEqual(pdfImageFrame(layout, 504, 258), { y: 504, end: 762, top: 0 }, 'prose is not centered');
});

test('adjacent equations fit together, but speed-reading image boundaries isolate each one', () => {
  const layout = { blocks: [image(0, 40), image(52, 60), prose(124)] };
  assert.deepEqual(pdfImageFrame(layout, 0, 258), { y: 0, end: 112, top: 73 });
  assert.deepEqual(pdfImageFrame(layout, 0, 258, 40), { y: 0, end: 40, top: 109 });
  assert.deepEqual(pdfImageFrame(layout, 52, 258, 112), { y: 52, end: 112, top: 99 });
});

test('tall images and larger image runs retain their scrolling position and pixels', () => {
  const tall = { blocks: [image(0, 700), prose(712)] };
  for (const y of [0, 100, 231, 462, 600]) assert.deepEqual(pdfImageFrame(tall, y, 258), { y, end: y + 258, top: 0 });
  assert.deepEqual(pdfImageFrame({ blocks: [image(0, 200), image(212, 200)] }, 0, 258), { y: 0, end: 258, top: 0 });
  assert.deepEqual(pdfImageFrame({ blocks: [image(0, 258)] }, 0, 258), { y: 0, end: 258, top: 0 });
});
