import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { startSimulatorRecording, encodeRecording } from '../scripts/simulator-recording.mjs';
import { captureTools } from '../scripts/capture.mjs';

const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
async function directory(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'simulator-recording-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('recorder serializes slow captures, reports gaps, and finalizes once after a failure', async t => {
  const dir = path.join(await directory(t), 'recording');
  let active = 0; let maximum = 0; let attempts = 0; let encodes = 0;
  const recorder = await startSimulatorRecording({ dir, fps: 30, fetchFrame: async () => {
    active++; maximum = Math.max(maximum, active); const attempt = ++attempts;
    try {
      await sleep(50); // Slower than the requested sample interval.
      if (attempt === 2) throw new Error('temporary screenshot failure');
      return signature;
    } finally { active--; }
  }, encode: async ({ frames, durationMs }) => {
    encodes++;
    assert.ok(frames.length >= 2);
    assert.ok(durationMs > frames.at(-1).atMs);
  } });
  t.after(() => recorder.stop());
  const deadline = Date.now() + 3000;
  while (attempts < 3 && Date.now() < deadline) await sleep(10);
  recorder.mark('test-failure', { message: 'example assertion failure' });
  const result = await recorder.stop();
  assert.deepEqual(await recorder.stop(), result);
  assert.equal(maximum, 1); assert.equal(active, 0); assert.equal(encodes, 1);
  const metadata = JSON.parse(await readFile(path.join(dir, 'recording.json'), 'utf8'));
  assert.equal(metadata.errors.length, 1);
  assert.match(metadata.errors[0].message, /temporary/);
  assert.ok(metadata.frames[1].atMs - metadata.frames[0].atMs >= 90, 'failed sample leaves its real time gap');
  assert.ok(metadata.events.some(e => e.type === 'test-failure'));
  for (const frame of metadata.frames) assert.deepEqual(await readFile(path.join(dir, frame.file)), signature);
});

test('encoding failure retains frames and timeline for diagnosis', async t => {
  const dir = path.join(await directory(t), 'recording');
  const recorder = await startSimulatorRecording({ dir, fetchFrame: async () => signature,
    encode: async () => { throw new Error('ffmpeg unavailable'); } });
  await assert.rejects(recorder.stop(), /ffmpeg unavailable/);
  const metadata = JSON.parse(await readFile(path.join(dir, 'recording.json'), 'utf8'));
  assert.equal(metadata.video, null);
  assert.match(metadata.error, /ffmpeg unavailable/);
  assert.deepEqual(await readFile(path.join(dir, metadata.frames[0].file)), signature);
});

// Construct a small RGBA fixture with constant green RGB and brightness in alpha,
// matching the simulator's unusual screenshot representation.
function fixturePng(reverse = false) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(64); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((64 * 4 + 1) * 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) {
    const offset = y * 257 + 1 + x * 4; pixels[offset + 1] = 255;
    pixels[offset + 3] = ((x >= 32) !== reverse) ? 255 : 0;
  }
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

test('real FFmpeg output composites alpha onto black and preserves elapsed time', async t => {
  const { ffmpeg } = await captureTools();
  try { await exec(ffmpeg, ['-version']); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('FFmpeg is not installed'); return; } throw error; }
  const dir = await directory(t); await mkdir(path.join(dir, 'frames'));
  await writeFile(path.join(dir, 'frames/000000.png'), fixturePng());
  await writeFile(path.join(dir, 'frames/000001.png'), fixturePng(true));
  const video = await encodeRecording({ dir, ffmpeg, durationMs: 1300,
    frames: [{ file: 'frames/000000.png', atMs: 0 }, { file: 'frames/000001.png', atMs: 850 }] });
  const { stdout } = await exec(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', video,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024, timeout: 15000 });
  const frameSize = 128 * 64 * 3;
  assert.equal(stdout.length / frameSize, 39, '1.3 seconds at 30 output fps, including time between captures');
  const pixel = (frame, x) => [...stdout.subarray(frame * frameSize + (32 * 128 + x) * 3, frame * frameSize + (32 * 128 + x) * 3 + 3)];
  for (const frame of [0, 20]) {
    assert.ok(pixel(frame, 16).every(v => v < 10), 'transparent green must become black');
    assert.ok(pixel(frame, 112)[1] > 230, 'opaque green must stay bright');
  }
  assert.ok(pixel(33, 16)[1] > 230, 'second sample begins after its recorded offset');
  assert.ok(pixel(33, 112).every(v => v < 10));
});
