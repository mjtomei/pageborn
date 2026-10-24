// All of our PDF canvases are offscreen sources for glasses images. PDF.js
// 6.3.289 schedules display renders on window.requestAnimationFrame, which a
// hidden phone WebView does not deliver. Keep display intent (including its
// annotation/layer semantics), but use PDF.js's promise-based render scheduler.
// This is a guarded adapter for the pinned PDF.js version: its public render
// options do not expose the scheduler flag. Background browser tests cover it.
export function renderPdfPage(page, options) {
  const task = page.render(options);
  const internal = task._internalRenderTask;
  if (typeof internal?._useRequestAnimationFrame !== 'boolean') {
    task.cancel(); task.promise.catch(() => {});
    throw new Error('The PDF renderer no longer supports background rendering.');
  }
  // render() starts its work asynchronously, so this is set before it schedules
  // its first continuation. Cancellation and completion stay owned by PDF.js.
  internal._useRequestAnimationFrame = false;
  // Promise-only continuations can starve input and paint on a busy page.
  // A timer yields to the UI without requiring a visible phone WebView.
  task.onContinue = resume => setTimeout(resume, 0);
  return task;
}
