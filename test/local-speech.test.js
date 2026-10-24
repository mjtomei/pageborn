import test from 'node:test';
import assert from 'node:assert/strict';
import { pcmWave } from '../src/ask.js';
import { waveSamples, samplesWave, MAX_SPEECH_SECONDS, SPEECH_RATE } from '../src/speech-audio.js';
import { LocalSpeech, speechBackend } from '../src/local-speech.js';

test('glasses PCM is decoded without audio APIs; samples round trip and are bounded', async () => {
  const values = new Float32Array(3200); values.set([-1, -.5, 0, .5, 1]);
  const wave = samplesWave(values); const decoded = waveSamples(await wave.arrayBuffer());
  assert.equal(decoded.length, values.length);
  for (let i = 0; i < 5; i++) assert(Math.abs(decoded[i] - values[i]) < .00004);
  assert.throws(() => waveSamples(new ArrayBuffer(3)), /WAV/);
  assert.throws(() => waveSamples(new ArrayBuffer(44)), /WAV/);
  const truncated = (new Uint8Array(await wave.arrayBuffer())).slice(0, -1).buffer;
  assert.throws(() => waveSamples(truncated), /incomplete/);
});

test('recordings reject wrong formats, short audio and excessive length', async () => {
  const b = await pcmWave([new Uint8Array(6400)]).arrayBuffer(); const view = new DataView(b);
  view.setUint16(22, 2, true); assert.throws(() => waveSamples(b), /mono/);
  const short = await pcmWave([new Uint8Array(100)]).arrayBuffer(); assert.throws(() => waveSamples(short), /No speech/);
  const long = await pcmWave([new Uint8Array(SPEECH_RATE * (MAX_SPEECH_SECONDS + 1) * 2)]).arrayBuffer(); assert.throws(() => waveSamples(long), /60 seconds/);
});

function fixture() {
  const workers = [];
  const speech = new LocalSpeech({ base: 'http://localhost/stt/', idleMs: 15,
    createWorker: () => {
      const w = { sent: [], postMessage(m) { this.sent.push(m); }, terminate() { this.terminated = true; },
        reply(data) { this.onmessage({ data: { id: this.sent.at(-1).id, ...data } }); } };
      workers.push(w); return w;
    } });
  return { speech, workers };
}
test('only one backend stays loaded; switching terminates it and reports the real backend', async () => {
  const { speech, workers } = fixture();
  try {
    const p = speech.prepare('wasm'); workers[0].reply({ result: { backend: 'wasm' } }); assert.equal((await p).backend, 'wasm');
    const q = speech.prepare('webgpu'); assert(workers[0].terminated); workers[1].reply({ error: 'WebGPU unavailable' });
    await assert.rejects(q, /WebGPU unavailable/); assert.equal(workers.length, 2, 'No hidden CPU fallback'); assert(workers[1].terminated);
  } finally { speech.close(); }
});
test('cancel terminates inference, rejects its promise, ignores late replies and permits retry', async () => {
  const { speech, workers } = fixture(); const abort = new AbortController();
  const p = speech.prepare('wasm', { signal: abort.signal });
  const rejected = assert.rejects(p, { name: 'AbortError' }); abort.abort(); await rejected;
  assert(workers[0].terminated); workers[0].reply({ result: { backend: 'webgpu' } });
  const q = speech.prepare('wasm'); workers[1].reply({ result: { backend: 'wasm' } }); await q;
  await new Promise(resolve => setTimeout(resolve, 30)); assert(workers[1].terminated, 'Idle model memory is released');
});
test('concurrent requests cannot overlap; worker errors reject and release resources', async () => {
  const { speech, workers } = fixture();
  const p = speech.prepare('wasm'); const rejected = assert.rejects(p, /stopped unexpectedly/);
  await assert.rejects(speech.prepare('wasm'), /already running/);
  workers[0].onerror({}); await rejected; assert(workers[0].terminated);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(speech.prepare('wasm', { signal: abort.signal }), { name: 'AbortError' }); assert.equal(workers.length, 1);
  assert.equal(speechBackend('unrecognized'), 'wasm'); assert.equal(speechBackend('webgpu'), 'wasm'); assert.equal(speechBackend('remote'), 'remote');
});

test('refinement replaces the fast model instead of keeping both in memory', async () => {
  const { speech, workers } = fixture();
  try {
    const fast = speech.prepare('wasm'); workers[0].reply({ result: {} }); await fast;
    const refine = speech.prepare('wasm', { model: 'refine' });
    assert(workers[0].terminated); assert.equal(workers[1].sent[0].model, 'refine');
    workers[1].reply({ result: {} }); await refine;
    const retry = speech.prepare('wasm'); assert(workers[1].terminated);
    workers[2].reply({ result: {} }); await retry;
    await assert.rejects(speech.prepare('wasm', { model: 'unknown' }), /Unknown speech model/);
  } finally { speech.close(); }
});
