import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPdfPage } from '../src/pdf-render.js';

test('PDF rendering keeps display options and cancellation while disabling animation-frame scheduling', async () => {
  const options = { intent: 'display', recordImages: true, recordOperations: true, viewport: {} };
  let cancelled = false;
  const task = { _internalRenderTask: { _useRequestAnimationFrame: true }, promise: Promise.resolve(), cancel() { cancelled = true; } };
  const result = renderPdfPage({ render(params) { assert.equal(params, options); return task; } }, options);
  assert.equal(result, task); assert.equal(task._internalRenderTask._useRequestAnimationFrame, false);
  result.cancel(); assert.equal(cancelled, true); await result.promise;
});

test('an incompatible PDF.js scheduler fails explicitly and cancels its pending render', async () => {
  let reject; let cancelled = false;
  const promise = new Promise((_, fail) => { reject = fail; });
  const task = { promise, cancel() { cancelled = true; reject(new Error('Cancelled')); } };
  assert.throws(() => renderPdfPage({ render: () => task }, {}), /no longer supports background rendering/);
  assert.equal(cancelled, true); await assert.rejects(promise, /Cancelled/);
});

test('PDF render continuations yield to queued UI work without animation frames', async () => {
  const order = [];
  const task = { _internalRenderTask: { _useRequestAnimationFrame: true }, promise: Promise.resolve(), cancel() {} };
  renderPdfPage({ render: () => task }, {});
  setTimeout(() => order.push('input'), 0);
  const continuation = new Promise(resolve => task.onContinue(() => { order.push('render'); resolve(); }));
  await Promise.resolve(); assert.deepEqual(order, []);
  await continuation; assert.deepEqual(order, ['input', 'render']);
});
