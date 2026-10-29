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

test('neighboring images each occupy their own pane, including during autoscroll', () => {
  const layout = { blocks: [image(0, 40), image(52, 60), prose(124)] };
  for (const y of [0, 27, 45]) assert.deepEqual(pdfImageFrame(layout, y, 258), { y: 0, end: 40, top: 109 });
  assert.deepEqual(pdfImageFrame(layout, 0, 258, 40), { y: 0, end: 40, top: 109 });
  assert.deepEqual(pdfImageFrame(layout, 52, 258, 112), { y: 52, end: 112, top: 99 });
  assert.deepEqual(pdfImageFrame({ blocks: [image(0, 200), image(212, 200)] }, 0, 258), { y: 0, end: 200, top: 29 });
  assert.deepEqual(pdfImageFrame({ blocks: [image(0, 258)] }, 100, 258), { y: 0, end: 258, top: 0 });
});
