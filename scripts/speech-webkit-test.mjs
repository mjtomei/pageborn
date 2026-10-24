// Exercise the packaged local model in WebKit, including long/silent audio.
// This is a desktop engine check, not an iPhone or Even host benchmark.
import { webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { samplesWave, waveSamples, SPEECH_RATE } from '../src/speech-audio.js';
import { showSettings, showLibrary, hideSettings } from './ui-helpers.mjs';

const out = path.resolve('test-results/speech'); await mkdir(out, { recursive: true });
let bytes;
try { bytes = await readFile(path.join(out, 'jfk.wav')); }
catch {
  const response = await fetch('https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav');
  assert(response.ok); bytes = Buffer.from(await response.arrayBuffer()); await writeFile(path.join(out, 'jfk.wav'), bytes);
}
const original = waveSamples(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
const long = new Float32Array(3 * (original.length + SPEECH_RATE));
for (let i = 0; i < 3; i++) long.set(original, i * (original.length + SPEECH_RATE));
const server = createApp({ distDir: path.resolve('dist') }).listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const result = { passed: false, physicalPhone: false, errors: [], unexpectedNetwork: [], samples: [] };
try {
  browser = await webkit.launch({ headless: true, ...(process.env.WEBKIT_PATH ? { executablePath: process.env.WEBKIT_PATH } : {}) });
  const page = await browser.newPage();
  page.on('pageerror', error => result.errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
    result.unexpectedNetwork.push(url.origin); return route.abort();
  });
  await page.goto(origin); await expect(page.locator('#import')).toBeEnabled();
  result.userAgent = await page.evaluate(() => navigator.userAgent);
  await showSettings(page);
  for (const [name, samples] of [['short', original], ['long', long], ['silence', new Float32Array(SPEECH_RATE)]]) {
    await page.locator('#speech-test-file').setInputFiles({ name: `${name}.wav`, mimeType: 'audio/wav', buffer: Buffer.from(await samplesWave(samples).arrayBuffer()) });
    await expect(page.locator('#speech-status')).toContainText('Voice test finished', { timeout: 240000 });
    const output = await page.locator('#speech-test-output').textContent();
    if (name === 'silence') assert.match(output, /WebAssembly SIMD: The recording is silent/);
    else {
      assert.match(output, /WebAssembly SIMD · .*transcription/);
      assert.doesNotMatch(output, /Whisper|WebGPU|corrections/i);
      assert.match(output, /fellow Americans/i);
      if (name === 'long') assert((output.split('\n\n')[0].match(/country/gi) || []).length >= 6, output);
    }
    result.samples.push({ name, seconds: samples.length / SPEECH_RATE, output });
  }
  // Use an actual Web Audio MediaStream source without requiring access to a
  // physical microphone. The app still uses its real AudioWorklet and model.
  await page.evaluate(encoded => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = window.__captureFixture = new AudioContext(); await context.resume();
      const source = context.createBufferSource(), destination = context.createMediaStreamDestination();
      source.buffer = await context.decodeAudioData(Uint8Array.from(atob(encoded), c => c.charCodeAt(0)).buffer);
      source.connect(destination); source.start(); window.__captureTracks = destination.stream.getTracks();
      return destination.stream;
    };
  }, bytes.toString('base64'));
  await hideSettings(page);
  await page.locator('#file-picker').setInputFiles({ name: 'webkit-voice.md', mimeType: 'text/markdown', buffer: Buffer.from('# Speech\n\nA local test paper.') });
  await showLibrary(page); await page.locator('[data-document-id="webkit-voice.md"] .document-card').click();
  await page.locator('#ask-open').click(); await page.locator('#ask-voice').click();
  await expect(page.locator('#ask-status')).toContainText('Listening');
  await expect(page.locator('#ask-question')).not.toHaveValue('', { timeout: 20000 });
  await expect(page.locator('#ask-status')).toContainText('Listening');
  await page.waitForTimeout(4500); await page.locator('#ask-voice').click();
  await expect(page.locator('#ask-review-cancel')).toBeVisible({ timeout: 30000 });
  // Review can appear from the live draft before microphone stop has resolved.
  await expect.poll(() => page.evaluate(() => window.__captureTracks.every(track => track.readyState === 'ended'))).toBe(true);
  assert.match(await page.locator('#ask-question').inputValue(), /fellow.?american|country/i);
  await page.locator('#ask-question').fill('Edited WebKit question'); await page.locator('#ask-review-cancel').click();
  await page.evaluate(() => window.__captureFixture.close());
  result.audioWorkletPartialBeforeRelease = true; result.captureStopsCleanly = true;
  assert.deepEqual(result.errors, []); assert.deepEqual(result.unexpectedNetwork, []); result.passed = true;
} finally {
  await writeFile(path.join(out, 'webkit-results.json'), JSON.stringify(result, null, 2));
  await browser?.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
}
console.log(JSON.stringify(result, null, 2));
