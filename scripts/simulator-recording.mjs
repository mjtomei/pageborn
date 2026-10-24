import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { captureTools } from './capture.mjs';

// Simulator PNGs keep green RGB even in dark pixels; alpha carries brightness.
// Composite onto black before discarding alpha, then enlarge without blurring text.
export const videoFilter = 'format=rgba,premultiply=inplace=1,format=rgb24,scale=iw*2:ih*2:flags=neighbor,fps=30';

export async function encodeRecording({ dir, frames, durationMs, ffmpeg }) {
  if (!frames.length) throw new Error('No simulator frames were captured.');
  if (!Number.isFinite(durationMs) || durationMs <= frames.at(-1).atMs) throw new Error('Invalid recording duration.');
  const lines = ['ffconcat version 1.0'];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (!/^frames\/\d{6}\.png$/.test(frame.file) || !Number.isFinite(frame.atMs) || frame.atMs < 0 ||
        (i && frame.atMs <= frames[i - 1].atMs)) throw new Error('Invalid recording frame.');
    // Hold the first sample from time zero; retain actual gaps between later samples.
    const start = i === 0 ? 0 : frame.atMs;
    const end = frames[i + 1]?.atMs ?? durationMs;
    lines.push(`file '${frame.file}'`, 'option framerate 1000', `duration ${((end - start) / 1000).toFixed(6)}`);
  }
  lines.push(`file '${frames.at(-1).file}'`, 'option framerate 1000');
  await writeFile(path.join(dir, 'frames.ffconcat'), lines.join('\n') + '\n');
  const executable = ffmpeg || (await captureTools()).ffmpeg;
  const child = spawn(executable, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0',
    '-i', 'frames.ffconcat', '-vf', videoFilter, '-t', (durationMs / 1000).toFixed(6),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    'simulator.mp4'], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
  let tail = '';
  child.stderr.on('data', data => { tail = (tail + data).slice(-4000); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 120000);
  try {
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`Simulator video encoding failed (${code ?? signal}): ${tail}`)));
    });
  } finally { clearTimeout(timeout); }
  return path.join(dir, 'simulator.mp4');
}

export async function startSimulatorRecording({ api, dir, fps = 12, fetchFrame, encode = encodeRecording }) {
  if (!Number.isFinite(fps) || fps < 1 || fps > 30) throw new Error('SIMULATOR_FPS must be between 1 and 30.');
  await mkdir(dir); // A fresh folder prevents mixing frames from separate runs.
  await mkdir(path.join(dir, 'frames'));
  const grab = fetchFrame || (async () => {
    const response = await fetch(`${api}/api/screenshot/glasses`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error(`Screenshot HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  });
  const frames = []; const events = []; const errors = [];
  const startedAt = new Date().toISOString(); const start = performance.now();
  const elapsed = () => performance.now() - start;
  let stopping = false; let wake; let finalized; let fatalError; let consecutiveErrors = 0; let lastAttemptMs = 0;
  const mark = (type, details = {}) => events.push({ atMs: elapsed(), type, ...details });
  const capture = async () => {
    const requestedAtMs = elapsed();
    lastAttemptMs = requestedAtMs;
    try {
      const buffer = await grab();
      const atMs = elapsed();
      if (buffer.length < 8 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new Error('Screenshot response is not a PNG.');
      }
      const file = `frames/${String(frames.length).padStart(6, '0')}.png`;
      await writeFile(path.join(dir, file), buffer);
      frames.push({ file, atMs, requestedAtMs }); consecutiveErrors = 0;
    } catch (error) {
      const entry = { atMs: elapsed(), message: error.message };
      errors.push(entry); mark('capture-error', entry);
      if (++consecutiveErrors >= 10 || errors.length >= 100) fatalError = new Error('Too many simulator screenshot failures.');
    }
  };
  await capture();
  const loop = (async () => {
    while (!stopping && !fatalError) {
      if (elapsed() >= 900000 || frames.length >= 18000) { fatalError = new Error('Simulator recording limit reached (15 minutes or 18,000 frames).'); break; }
      // One request at a time. A slow response reduces sampling frequency, never queues captures.
      await new Promise(resolve => {
        const timer = setTimeout(resolve, Math.max(0, 1000 / fps - (elapsed() - lastAttemptMs)));
        wake = () => { clearTimeout(timer); resolve(); };
      });
      wake = undefined;
      if (!stopping) await capture();
    }
  })();
  const stop = () => finalized ??= (async () => {
    stopping = true; wake?.(); await loop;
    const durationMs = Math.max(1000 / 30, elapsed(), (frames.at(-1)?.atMs ?? 0) + 1);
    mark('recording-stop');
    const metadata = { source: 'official simulator screenshots; not hardware timing', startedAt, fps,
      durationMs, frames, events, errors, error: fatalError?.message ?? null, video: null };
    const save = () => writeFile(path.join(dir, 'recording.json'), JSON.stringify(metadata, null, 2));
    await save(); // Keep timestamps and raw frames even if FFmpeg fails.
    try {
      await encode({ dir, frames, durationMs }); metadata.video = 'simulator.mp4';
    } catch (error) { metadata.error = [metadata.error, error.message].filter(Boolean).join('; '); }
    await save();
    if (metadata.error) throw new Error(`${metadata.error} Raw frames and timeline: ${dir}`);
    return { directory: dir, video: path.join(dir, metadata.video), frameCount: frames.length, durationMs, captureErrors: errors.length };
  })();
  mark('recording-start');
  return { mark, stop };
}
