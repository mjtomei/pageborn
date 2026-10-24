import test from 'node:test';
import assert from 'node:assert/strict';
import { speechPreparationGuard } from '../src/speech-preparation-guard.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(saved = null) {
  let state = saved, calls = 0, resolve;
  const entry = { model: 'refine', backend: 'webgpu', generation: 0, local: { prepare() { calls++; return new Promise(done => { resolve = done; }); } } };
  const prepare = speechPreparationGuard({ read: () => state, save: async value => { state = value; }, version: 'test' });
  return { entry, prepare, get state() { return state; }, get calls() { return calls; }, finish: () => resolve({ ready: true }) };
}
test('interrupted optional preparation never restarts automatically; CPU is available', async () => {
  const f = fixture({ pending: true });
  await assert.rejects(f.prepare(f.entry, {}), /paused after an interrupted/); assert.equal(f.calls, 0);
  const cpu = f.prepare({ ...f.entry, model: 'fast', backend: 'wasm' }, {}); f.finish(); await cpu;
  assert.equal(f.state.pending, true); assert.equal(f.calls, 1);
  const retry = f.prepare(f.entry, { retry: true }); await tick();
  assert.equal(f.calls, 2); assert(f.state.pending); f.finish(); await retry; assert.equal(f.state.pending, false);
});
test('marker commits before worker load; closing while saving prevents delayed restart', async () => {
  let state, saved, started = false;
  const entry = { model: 'refine', generation: 0, local: { prepare() { started = true; } } };
  const prepare = speechPreparationGuard({ read: () => state, save: value => { state = value; return value.pending ? new Promise(resolve => { saved = resolve; }) : Promise.resolve(); } });
  const work = prepare(entry, {}); const rejected = assert.rejects(work, { name: 'AbortError' });
  await tick(); assert(state.pending); assert(!started); entry.generation++; saved(); await rejected;
  assert(!started); assert.equal(state.pending, false);
});
test('handled failure clears marker; old cancelled attempt cannot erase a new attempt', async () => {
  // A stale completion is simulated with two independent underlying waiters.
  let finishOld, finishNew, state;
  const guard = speechPreparationGuard({ read: () => state, save: async value => { state = value; } });
  const entry = { model: 'refine', generation: 0, local: { prepare: () => new Promise(resolve => { finishOld = resolve; }) } };
  const old = guard(entry, {}); await tick(); entry.generation++;
  entry.local.prepare = () => new Promise(resolve => { finishNew = resolve; });
  const next = guard(entry, { retry: true }); await tick(); const nextId = state.id;
  finishOld({}); await old; assert(state.pending); assert.equal(state.id, nextId);
  finishNew({}); await next; assert.equal(state.pending, false);
  entry.local.prepare = () => Promise.reject(new Error('GPU unavailable'));
  await assert.rejects(guard(entry, {}), /GPU unavailable/); assert.equal(state.pending, false);
});
test('failed durable checkpoint does not start the GPU worker', async () => {
  let started = false;
  const prepare = speechPreparationGuard({ save: async () => { throw new Error('storage unavailable'); } });
  await assert.rejects(prepare({ model: 'refine', generation: 0, local: { prepare() { started = true; } } }, {}), /storage unavailable/);
  assert.equal(started, false);
});
