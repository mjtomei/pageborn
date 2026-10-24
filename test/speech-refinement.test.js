import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechRefinement } from '../src/speech-refinement.js';
function fixture() {
  let draft = 'first draft'; const calls = [], statuses = [], failures = [];
  const refinement = new SpeechRefinement({
    current: () => draft, replace: text => { draft = text; }, status: text => statuses.push(text), failure: error => failures.push(error),
    transcribe: (audio, signal) => new Promise((resolve, reject) => calls.push({ audio, signal, resolve, reject })),
  });
  return { refinement, calls, statuses, failures, get draft() { return draft; }, set draft(value) { draft = value; } };
}
test('refinement replaces only an unsent draft and reports changed, unchanged, empty and failed passes', async () => {
  for (const text of ['corrected draft', 'first draft', '']) {
    const f = fixture(); const p = f.refinement.start('audio', f.draft); f.calls[0].resolve({ text }); await p;
    assert.equal(f.draft, text || 'first draft'); assert.equal(f.refinement.job, null);
    assert.match(f.statuses.at(-1), text === '' ? /Kept/ : text === 'first draft' ? /checked/ : /updated/);
  }
  const f = fixture(); const p = f.refinement.start('audio', f.draft); f.calls[0].reject(new Error('Model unavailable')); await p;
  assert.equal(f.draft, 'first draft'); assert.equal(f.failures.length, 1); assert.match(f.statuses.at(-1), /Kept/);
});
test('send, cancel, edits, close and a new recording can cancel refinement even if the worker ignores abort', async () => {
  for (const action of ['send', 'cancel', 'edit', 'close', 'record']) {
    const f = fixture(); const p = f.refinement.start('audio', f.draft); f.refinement.cancel();
    if (action === 'edit') f.draft = 'manually edited';
    const draft = f.draft; f.calls[0].resolve({ text: 'late result' }); await p;
    assert.equal(f.draft, draft); assert(f.calls[0].signal.aborted); assert.equal(f.refinement.job, null);
  }
});
test('a changed review and an older refinement cannot overwrite a newer draft or clear its job', async () => {
  const f = fixture(); const old = f.refinement.start('old audio', f.draft);
  f.draft = 'new draft'; const next = f.refinement.start('new audio', f.draft);
  f.calls[0].resolve({ text: 'stale' }); await old; assert(f.refinement.job); assert.equal(f.draft, 'new draft');
  f.calls[1].resolve({ text: 'new corrected draft' }); await next; assert.equal(f.draft, 'new corrected draft');
  const stale = f.refinement.start('more audio', f.draft); f.draft = null;
  f.calls[2].resolve({ text: 'result after leaving' }); await stale; assert.equal(f.draft, null);
});
