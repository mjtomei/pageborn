import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BODY_TOP, BODY_HEIGHT, MARGIN, WIDTH } from '../src/document.js';

// Compare lossless captured pixels, not compressed video. During page gestures
// the body must use settled page pixels at their original vertical coordinates.
// A screenshot can catch a repaint mid-frame, mixing old and new scanlines.
export async function reviewPageMotion(resultDir) {
  const recording = path.join(resultDir, 'recording');
  const data = JSON.parse(await readFile(path.join(recording, 'recording.json'), 'utf8'));
  assert.ok(data.frames.length && !data.error && !data.errors.length, 'review needs an uninterrupted recording');
  let ffmpeg = process.env.FFMPEG;
  if (!ffmpeg) {
    const local = fileURLToPath(new URL('../.tools/bin/ffmpeg', import.meta.url));
    ffmpeg = await access(local).then(() => local, () => 'ffmpeg');
  }
  const { stdout } = await promisify(execFile)(ffmpeg, ['-v', 'error', '-framerate', '30',
    '-i', path.join(recording, 'frames/%06d.png'),
    '-vf', `crop=${WIDTH - 2 * MARGIN}:${BODY_HEIGHT}:${MARGIN}:${BODY_TOP},alphaextract`,
    '-f', 'framemd5', '-'], { maxBuffer: 4 * 1024 * 1024 });
  const hashes = stdout.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1).trim());
  assert.equal(hashes.length, data.frames.length, 'every captured frame must be decoded');
  const frames = data.frames.map((frame, i) => ({ ...frame, hash: hashes[i] }));
  const nearest = atMs => frames.reduce((best, frame) => Math.abs(frame.atMs - atMs) < Math.abs(best.atMs - atMs) ? frame : best);
  const width = WIDTH - 2 * MARGIN;
  const decoded = new Map();
  const pixels = async frame => {
    if (!decoded.has(frame.file)) {
      const { stdout } = await promisify(execFile)(ffmpeg, ['-v', 'error', '-i', path.join(recording, frame.file),
        '-vf', `crop=${width}:${BODY_HEIGHT}:${MARGIN}:${BODY_TOP},alphaextract`, '-f', 'rawvideo', '-'],
      { encoding: 'buffer', maxBuffer: width * BODY_HEIGHT * 2 });
      assert.equal(stdout.length, width * BODY_HEIGHT);
      decoded.set(frame.file, stdout);
    }
    return decoded.get(frame.file);
  };
  const stages = [];
  const pageStages = data.events.filter(e => e.type === 'scroll-repro-stage-start' && e.name.includes('-pages-')).map(e => e.name);
  assert.ok(pageStages.length, 'recording must contain page gestures');
  for (const name of pageStages) {
    const inputs = data.events.filter(e => e.type === 'scroll-repro-input' && e.stage === name);
    assert.ok(inputs.length, `missing scenario ${name}`);
    const settled = [nearest(inputs[0].atMs - 100), ...inputs.map(e => nearest(e.atMs + 500))];
    const allowed = new Set(settled.map(f => f.hash));
    const samples = frames.filter(f => f.atMs >= inputs[0].atMs && f.atMs <= inputs.at(-1).atMs + 600);
    const unexpected = samples.filter(f => !allowed.has(f.hash));
    const displaced = []; const mixed = [];
    for (const frame of unexpected) {
      const time = frame.atMs;
      const inputIndex = inputs.findLastIndex(e => e.atMs <= time);
      const before = await pixels(settled[inputIndex]);
      const after = await pixels(settled[inputIndex + 1]);
      const current = await pixels(frame);
      let stationary = true;
      for (let row = 0; row < BODY_HEIGHT; row++) {
        const start = row * width; const end = start + width;
        const line = current.subarray(start, end);
        if (!line.equals(before.subarray(start, end)) && !line.equals(after.subarray(start, end))) { stationary = false; break; }
      }
      (stationary ? mixed : displaced).push(frame.file);
    }
    stages.push({ name, frames: samples.length, settledBodies: allowed.size,
      displacedFrames: displaced.length, firstDisplaced: displaced[0] ?? null, mixedRepaintFrames: mixed });
  }
  const report = { passed: stages.every(s => s.displacedFrames === 0), stages,
    limitation: 'Checks sampled page body pixels only. Native transitions and hardware behavior require separate review.' };
  await writeFile(path.join(resultDir, 'page-motion-review.json'), JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/review-page-motion.mjs RESULT_DIRECTORY');
  const report = await reviewPageMotion(path.resolve(process.argv[2]));
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
