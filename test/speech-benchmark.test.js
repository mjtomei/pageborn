import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkWords, scoreSpeech, correctionChanges, summarizeSpeech, noisySpeech, runSpeechBenchmark } from '../src/speech-benchmark.js';
import { SpeechRecording } from '../src/speech-recording.js';
import { AskMicrophone } from '../src/ask.js';
import { samplesWave, waveSamples } from '../src/speech-audio.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const audio = samplesWave(Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i) * .1));
test('word errors normalize case/punctuation and count substitutions, omissions and extra words', () => {
  assert.deepEqual(benchmarkWords('Mr. Quilter’s MANNER!'), ['mister', "quilter's", 'manner']);
  assert.equal(scoreSpeech('Mister Quilter’s manner', "Mr. Quilter's manner.").wer, 0);
  const score = scoreSpeech('one two three four five', 'one X three five added extra');
  assert.equal(score.errors, 4); assert.equal(score.referenceWords, 5); assert.equal(score.wer, .8);
  assert.equal(scoreSpeech('one two', '').deletions, 2);
  assert.equal(scoreSpeech('one', 'one two three').insertions, 2);
  assert.equal(scoreSpeech('', 'hallucinated words'), null);
});
test('correction counts distinguish errors fixed from introduced, and averages weight by word count', () => {
  const reference = 'one two three four', fast = scoreSpeech(reference, 'one X three four'), refine = scoreSpeech(reference, 'one two X four');
  assert.deepEqual(correctionChanges(fast, refine), { fixed: 1, introduced: 1 });
  const rows = [{ fast: { score: fast, ms: 100 }, refine: { score: refine, ms: 300 }, changes: correctionChanges(fast, refine) },
    { fast: { score: scoreSpeech('one', ''), ms: 200 }, refine: { error: 'GPU failed' } }];
  const summary = summarizeSpeech(rows);
  assert.equal(summary.fast.wer, 2 / 5); assert.equal(summary.fast.meanMs, 150);
  assert.equal(summary.paired.count, 1); assert.equal(summary.paired.draftWer, .25); assert.equal(summary.paired.finalWer, .25);
  assert.equal(summary.paired.meanMs, 400);
  assert.equal(summarizeSpeech([{ fast: { score: null, ms: 200 } }]).fast.wer, null);
});
test('synthetic noise is reproducible, bounded and leaves original audio unchanged', () => {
  const input = new Float32Array([.1, -.2, .3, -.5]), saved = input.slice(), output = noisySpeech(input);
  assert.deepEqual(output, noisySpeech(input)); assert.deepEqual(input, saved); assert.notDeepEqual(output, input);
  assert(output.every(n => n >= -1 && n <= 1));
});
test('benchmark compares identical audio with no reference hints, separates preparation and inference', async () => {
  let time = 0; const inputs = [], events = [];
  const models = { entries: { fast: { state: 'ready' }, refine: { state: 'idle' } },
    async wait(model) { time += 1000; return { backend: model === 'fast' ? 'wasm' : 'webgpu' }; },
    async transcribe(model, blob, options) { assert.deepEqual(options.vocabulary, []); inputs.push(await blob.arrayBuffer()); time += model === 'fast' ? 100 : 500; return { text: model === 'fast' ? 'hello word' : 'hello world' }; } };
  const report = await runSpeechBenchmark({ samples: [{ id: 'a', label: 'Clean', reference: 'hello world', audio: async () => audio }], models, signal: new AbortController().signal, now: () => time, progress: (...args) => events.push(args) });
  assert(report.completed); assert(report.prepared.fast.alreadyReady); assert(!report.prepared.refine.alreadyReady);
  assert.deepEqual(inputs[0], inputs[1]); assert.equal(report.summary.fast.meanMs, 100); assert.equal(report.summary.paired.meanMs, 600);
  assert.equal(report.summary.fast.wer, .5); assert.equal(report.summary.refine.wer, 0); assert.equal(report.summary.paired.fixed, 1);
  assert(events.some(row => row[1] === 'prepare'));
});
test('unavailable GPU still gives CPU results, and cancellation never reports completion', async () => {
  const controller = new AbortController(), models = { entries: { fast: {}, refine: {} },
    async wait(model) { if (model === 'refine') throw new Error('WebGPU unavailable'); return {}; }, async transcribe() { return { text: 'hello' }; } };
  const clip = { reference: 'hello', audio: async () => audio };
  const report = await runSpeechBenchmark({ samples: [clip], models, signal: controller.signal });
  assert.equal(report.summary.fast.wer, 0); assert.equal(report.summary.refine.count, 0); assert.match(report.prepared.refine.error, /unavailable/);
  let completed = false;
  await assert.rejects(runSpeechBenchmark({ samples: [clip, clip], models, signal: controller.signal, update: report => { completed ||= report.completed; if (report.runs.length) controller.abort(); } }), { name: 'AbortError' });
  assert(!completed);
});
test('recording saves PCM WAV and releases the borrowed microphone exactly once', async () => {
  const controls = [], mic = new AskMicrophone(async open => { controls.push(open); return true; });
  const recorder = new SpeechRecording(() => mic), controller = new AbortController();
  const pending = recorder.start(controller.signal, () => {}); await tick();
  mic.receive(new Uint8Array(await audio.arrayBuffer()).subarray(44)); recorder.stop();
  const wave = await pending; assert.equal(waveSamples(await wave.arrayBuffer()).length, 16000);
  assert.deepEqual(controls, [true, false]); assert(!recorder.active); assert(!mic.capturing);
});
test('cancel while microphone permission is pending pairs open/close and discards audio', async () => {
  const controls = []; let permission;
  const mic = new AskMicrophone(open => { controls.push(open); return open ? new Promise(resolve => { permission = resolve; }) : true; });
  const recorder = new SpeechRecording(() => mic), controller = new AbortController();
  const pending = recorder.start(controller.signal, () => {}), rejected = assert.rejects(pending, { name: 'AbortError' });
  await tick(); controller.abort(); assert(mic.stopping); permission(true); await rejected;
  assert.deepEqual(controls, [true, false]); assert(!recorder.active); assert(!mic.capturing);
});
test('recording maximum duration auto-stops through the shared microphone limit', async () => {
  let recorder; const mic = new AskMicrophone(async () => true, () => recorder.stop());
  recorder = new SpeechRecording(() => mic);
  const pending = recorder.start(new AbortController().signal, () => {}); await tick();
  mic.receive(new Uint8Array(61 * 32000));
  assert.equal(waveSamples(await (await pending).arrayBuffer()).length, 60 * 16000); assert(!mic.capturing);
});
