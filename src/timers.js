// Even's SDK shadow clock can fire a timeout without cancelling its native
// counterpart. It also visits timers added while walking its live timer map.
// Cancel before calling application code, and defer that code until the walk
// finishes: a recurring task must neither duplicate nor loop inside one tick.
export function safeTimeout(callback, delay = 0) {
  let fired = false, cancelled = false;
  const id = globalThis.setTimeout(() => {
    if (fired || cancelled) return;
    fired = true;
    globalThis.clearTimeout(id);
    queueMicrotask(() => { if (!cancelled) callback(); });
  }, delay);
  return { cancel() {
    // The SDK forgets its mapping after clearTimeout. Clearing that handle a
    // second time can target an unrelated native timer with the same number.
    if (!fired && !cancelled) globalThis.clearTimeout(id);
    cancelled = true;
  } };
}
export function cancelTimeout(timer) { timer?.cancel(); }
