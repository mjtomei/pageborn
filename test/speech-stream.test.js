import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechStream } from '../src/speech-stream.js';
import { AskMicrophone } from '../src/ask.js';
import { PcmResampler } from '../src/speech-resampler.js';
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test('incremental audio coalesces while inference is slow; release ignores a late result', async () => {
  const calls = [], results = [];
  const stream = new SpeechStream({ intervalMs: 0, transcribe: (audio, options) => new Promise(resolve => calls.push({ audio, options, resolve })), result: value => results.push(value) });
  stream.start(['Pageborne']); stream.receive(new Uint8Array(12800)); await tick(); assert.equal(calls.length, 0);
  stream.receive(new Uint8Array(35200)); await tick(); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.vocabulary, ['Pageborne']); assert.equal(calls[0].options.partial, true);
  for (let i = 0; i < 20; i++) stream.receive(new Uint8Array(3200));
  await tick(); assert.equal(calls.length, 1, 'No backlog of PCM-frame requests');
  calls[0].resolve({ text: 'first draft', words: [] }); await tick(); assert.equal(results.length, 1); assert.equal(calls.length, 2);
  assert.equal(calls[1].audio.size, 44 + 112000);
  stream.cancel(); assert(calls[1].options.signal.aborted);
  calls[1].resolve({ text: 'late' }); await tick(); assert.equal(results.length, 1);
});

test('long streaming recordings advance bounded windows and keep word offsets valid', async () => {
  const calls = [], results = [];
  const stream = new SpeechStream({ intervalMs: 0, transcribe: async audio => {
    calls.push(audio.size); return { text: 'word', words: [{ start: 0, end: 4, confidence: .5 }] };
  }, result: value => results.push(value) });
  stream.start(); stream.receive(new Uint8Array(36 * 32000));
  for (let i = 0; i < 15 && calls.length < 3; i++) await tick();
  assert.equal(calls.length, 3); assert(calls.every(size => size <= 44 + 15 * 32000));
  assert.equal(results.at(-1).text, 'word word word');
  assert.deepEqual(results.at(-1).words.map(w => w.start), [0, 5, 10]); stream.cancel();
});

test('a cancelled preload does not overwrite a new recording; silence does not fail capture', async () => {
  const calls = [], results = [], failures = [];
  const stream = new SpeechStream({ intervalMs: 0, transcribe: () => new Promise((resolve, reject) => calls.push({ resolve, reject })), result: r => results.push(r), failure: e => failures.push(e) });
  stream.start(); stream.receive(new Uint8Array(64000)); await tick();
  stream.start(); stream.receive(new Uint8Array(64000)); await tick();
  calls[0].resolve({ text: 'stale' }); calls[1].reject(new Error('The recording is silent.')); await tick();
  assert.deepEqual(results, []); assert.deepEqual(failures, []); assert(stream.active); stream.cancel();
});

test('PCM frames are delivered incrementally, copied, and bounded by the recording limit', async () => {
  const chunks = []; const mic = new AskMicrophone(async () => true, () => {}, bytes => chunks.push(bytes));
  mic.receive(new Uint8Array([1, 2])); assert.equal(chunks.length, 0);
  await mic.start(); const input = new Uint8Array([1, 2, 3, 4]); mic.receive(input); input[0] = 99;
  assert.deepEqual([...chunks[0]], [1, 2, 3, 4]); await mic.stop(); mic.receive(input); assert.equal(chunks.length, 1);
});

test('browser PCM resampling preserves duration across fractional chunk boundaries and flushes the tail', () => {
  for (const rate of [16000, 44100, 48000]) {
    const chunks = [], resampler = new PcmResampler(rate, bytes => chunks.push(bytes));
    const input = new Float32Array(rate + 123).fill(.5);
    for (let i = 0; i < input.length; i += 128) resampler.push([input.subarray(i, i + 128)]);
    resampler.flush();
    const count = chunks.reduce((sum, bytes) => sum + bytes.length / 2, 0);
    assert.equal(count, Math.floor(input.length * 16000 / rate));
    assert(chunks.every(bytes => bytes.length <= 3200));
    assert.equal(new DataView(chunks.at(-1).buffer).getInt16(0, true), 16384);
  }
});
