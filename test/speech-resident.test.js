import test from 'node:test';
import assert from 'node:assert/strict';
import { ResidentSpeech } from '../src/speech-resident.js';
import { LocalSpeech } from '../src/local-speech.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const workers = [], failures = [];
  const models = new ResidentSpeech({ failure: (...args) => failures.push(args), create: () => new LocalSpeech({
    base: 'http://localhost/stt/', idleMs: 0, retainOnCancel: true,
    createWorker() {
      const worker = { sent: [], postMessage(data) { this.sent.push(data); }, terminate() { this.terminated = true; },
        reply(data, id = this.sent.findLast(message => message.operation !== 'cancel').id) { this.onmessage({ data: { id, ...data } }); } };
      workers.push(worker); return worker;
    },
  }) });
  return { models, workers, failures };
}
test('chat preload starts CPU and GPU independently, deduplicates opens, retains both until disposal', async () => {
  const { models, workers } = fixture();
  const first = models.open(), second = models.open();
  assert.equal(workers.length, 2);
  assert.deepEqual(workers.map(w => [w.sent[0].model, w.sent[0].backend]), [['fast', 'wasm'], ['refine', 'webgpu']]);
  workers[0].reply({ result: { backend: 'wasm' } }); workers[1].reply({ result: { backend: 'webgpu' } });
  await Promise.all([first, second]); await models.open(); await tick();
  assert(workers.every(w => !w.terminated && w.sent.length === 1));
  assert(models.entries.fast.local.idleTimer == null && models.entries.refine.local.idleTimer == null);
  models.close(); assert(workers.every(w => w.terminated));
});
test('a recording waits for CPU preload without waiting for a slow GPU', async () => {
  const { models, workers } = fixture(); const preload = models.open();
  const request = models.transcribe('fast', new Blob(['audio']));
  await tick(); assert.equal(workers[0].sent.length, 1);
  workers[0].reply({ result: {} }); await tick();
  assert.equal(workers[0].sent[1].operation, 'transcribe');
  workers[0].reply({ result: { text: 'draft' } }); assert.equal((await request).text, 'draft');
  assert.equal(models.entries.refine.state, 'loading');
  models.close(); await preload;
});
test('leaving during preload cancels only the caller, and opening another paper reuses the load', async () => {
  const { models, workers } = fixture(); const preload = models.open(), abort = new AbortController();
  const request = models.transcribe('fast', new Blob(['audio']), { signal: abort.signal });
  const rejected = assert.rejects(request, { name: 'AbortError' }); abort.abort(); await rejected;
  const again = models.open(); assert.equal(workers.length, 2); assert(workers.every(w => !w.terminated));
  workers[0].reply({ result: {} }); workers[1].reply({ result: {} }); await Promise.all([preload, again]);
  assert(workers.every(w => w.sent.length === 1)); models.close();
});
test('cancelling inference keeps both workers, ignores stale results, and accepts the next question', async () => {
  const { models, workers } = fixture(); const preload = models.open();
  workers[0].reply({ result: {} }); workers[1].reply({ result: {} }); await preload;
  const abort = new AbortController(), request = models.transcribe('refine', new Blob(['audio']), { signal: abort.signal });
  const rejected = assert.rejects(request, { name: 'AbortError' }); await tick();
  const oldId = workers[1].sent.at(-1).id; abort.abort(); await rejected;
  assert.equal(workers[1].sent.at(-1).operation, 'cancel'); assert(!workers[1].terminated);
  const next = models.transcribe('refine', new Blob(['new audio'])); await tick();
  workers[1].reply({ result: { text: 'stale' } }, oldId);
  workers[1].reply({ result: { text: 'new question' } }); assert.equal((await next).text, 'new question');
  assert.equal(workers.length, 2); models.close();
});
test('GPU failure preserves CPU, is not retried on every open, and can be explicitly retried', async () => {
  const { models, workers, failures } = fixture(); const preload = models.open();
  workers[0].reply({ result: {} }); workers[1].reply({ error: 'WebGPU unavailable' }); await preload;
  await models.open(); assert.equal(workers.length, 2); assert(!workers[0].terminated); assert.equal(failures.length, 1);
  await assert.rejects(models.transcribe('refine', new Blob(['audio'])), /WebGPU unavailable/);
  const retry = models.open({ retry: true }); assert.equal(workers.length, 3);
  workers[2].reply({ result: {} }); await retry; assert.equal(models.entries.refine.state, 'ready');
  models.close();
});
test('silent/invalid input does not unload a healthy model, but disposal invalidates pending loads', async () => {
  const { models, workers } = fixture(); const preload = models.open({ refine: false });
  workers[0].reply({ result: {} }); await preload;
  const request = models.transcribe('fast', new Blob(['invalid'])); const rejected = assert.rejects(request, /silent/); await tick();
  workers[0].reply({ error: 'The recording is silent', fatal: false }); await rejected; assert(!workers[0].terminated);
  const gpu = models.open(); models.close(); await gpu;
  assert.equal(models.entries.refine.state, 'idle'); assert.equal(models.entries.fast.state, 'idle');
});
