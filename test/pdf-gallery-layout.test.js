import test from 'node:test';
import assert from 'node:assert/strict';
import { fitPdfGallery } from '../src/pdf-gallery-layout.js';

const bounds = b => ({ x: b.x - (b.rotate ? b.height : b.width) / 2, y: b.y - (b.rotate ? b.width : b.height) / 2,
  width: b.rotate ? b.height : b.width, height: b.rotate ? b.width : b.height });

test('a wide figure uses the full phone height when a turned caption fits beside it', () => {
  const fit = fitPdfGallery(900, 300, 366, 700, () => 40);
  assert.equal(fit.image.rotate, true); assert.equal(fit.caption.rotate, true);
  assert.equal(fit.image.width, 700);
  assert.equal(fit.caption.width, 700);
});

test('a nearly square figure keeps the caption below when turning it would reduce the figure', () => {
  const fit = fitPdfGallery(600, 500, 366, 700, () => 80);
  assert.equal(fit.caption.rotate, false); assert.equal(fit.placement, 'below');
  assert.equal(fit.image.height, 366); assert.equal(fit.image.width, 439.2);
});

test('a tall table puts an upright caption beside it to keep its full height', () => {
  const fit = fitPdfGallery(200, 800, 366, 700, () => 80);
  assert.equal(fit.image.rotate, false); assert.equal(fit.caption.rotate, false);
  assert.equal(fit.placement, 'beside'); assert.equal(fit.image.height, 700);
});

test('ties keep the caption upright and captionless images lose no space', () => {
  const fit = fitPdfGallery(600, 600, 400, 700, () => 20);
  assert.equal(fit.image.rotate, false); assert.equal(fit.caption.rotate, false);
  for (const [w, h] of [[900,300], [300,900], [600,600]]) {
    const fit = fitPdfGallery(w, h, 366, 700, () => 0);
    const maximum = Math.max(Math.min(366/w,700/h),Math.min(366/h,700/w));
    assert.equal(fit.scale,maximum); assert.equal(fit.caption.height,0);
    assert.equal(fit.caption.rotate,false);
  }
});

test('varied captions and viewports keep both pieces visible and separate, without shrinking the old image', () => {
  for (const [W,H] of [[296,500],[366,700],[1100,650],[250,150]]) for (const [w,h] of [[900,200],[200,900],[500,600],[600,500],[600,600]]) {
    for (const length of [0,30,400,4000]) {
      const measure = width => Math.ceil(length / Math.max(1,Math.floor(width/8))) * 20;
      const fit = fitPdfGallery(w,h,W,H,measure);
      const a = bounds(fit.image), b = bounds(fit.caption);
      for (const r of [a,b]) {
        assert(r.x >= -1e-6 && r.y >= -1e-6 && r.x+r.width <= W+1e-6 && r.y+r.height <= H+1e-6);
      }
      assert(a.x+a.width <= b.x+1e-6 || b.x+b.width <= a.x+1e-6 || a.y+a.height <= b.y+1e-6 || b.y+b.height <= a.y+1e-6);
      assert(Math.abs(fit.image.width/fit.image.height-w/h) < 1e-8);
      const oldHeight=H-Math.min(measure(W),H*.25)-(length?Math.min(12,H*.05):0);
      const oldScale=Math.max(Math.min(W/w,oldHeight/h),Math.min(W/h,oldHeight/w));
      assert(fit.scale >= oldScale-1e-6);
    }
  }
});
