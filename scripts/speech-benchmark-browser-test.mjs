// Phone layout, real microphone paths and exports; deterministic model replies
// by default. --real runs the packaged models (GPU correction explicitly moved
// to CPU for this shared workstation only). --gpu uses hardware WebGPU instead.
// --webkit checks the WebKit UI. PAGEBORNE_TEST_DIST can select a frozen build.
import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { createApp } from '../server/app.js';
import { waveSamples } from '../src/speech-audio.js';
import { showSettings, hideSettings, showLibrary, backToReading } from './ui-helpers.mjs';
import { speechDownloads } from '../src/speech-download-config.js';

const gpu = process.argv.includes('--gpu'), real = gpu || process.argv.includes('--real'), useWebkit = process.argv.includes('--webkit');
const out = path.resolve(`test-results/speech-phone-benchmark${gpu ? '-real-gpu' : real ? '-real-cpu' : useWebkit ? '-webkit' : ''}`); await mkdir(out, { recursive: true });
const app = express();
app.use('/fixture-models', express.static(path.resolve('.state/stt-assets/whisper-small.en')));
app.use(createApp({ distDir: path.resolve(process.env.PAGEBORNE_TEST_DIST || 'dist') }));
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const wave = await readFile('vendor/stt/phone-benchmark/1272-128104-0000.wav');
const references = JSON.parse(await readFile('vendor/stt/benchmark-samples.json', 'utf8'));
const browser = await (useWebkit ? webkit : chromium).launch({ headless: true,
  ...(gpu && !useWebkit ? { args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface', '--disable-gpu-compositing'],
    env: { ...process.env, VK_ICD_FILENAMES: '/usr/share/vulkan/icd.d/nvidia_icd.json' } } : {}),
  ...(useWebkit ? { executablePath: process.env.WEBKIT_PATH } : { executablePath: '/usr/bin/google-chrome' }) });
const result = { passed: false, actualModels: real, physicalPhone: false, correctionDeviceOverride: real && !gpu ? 'wasm (test only)' : null, errors: [], unexpectedNetwork: [] };
let page;
const monitor = real ? setInterval(() => { if (page && !page.isClosed()) page.locator('#speech-benchmark-status').textContent().then(status => console.log(status)).catch(() => {}); }, 15000) : null;
async function open(native = false, noGpu = false) {
  const context = await browser.newContext({ viewport: { width: 440, height: 806 }, acceptDownloads: true });
  const storage = new Map();
  await context.exposeFunction('__storage', ({ method, data }) => method === 'getLocalStorage' ? storage.get(data.key) || '' : (storage.set(data.key, data.value), true));
  await context.addInitScript(({ native }) => {
    window.__micCalls = []; window.__micDelay = 0; window.__calls = [];
    const Original = Worker;
    window.Worker = class extends Original {
      constructor(url, options) { super(url, options); this.speech = String(url).includes('speech-worker'); }
      postMessage(data, ...rest) {
        if (this.speech) window.__calls.push({ operation: data.operation, model: data.model, vocabulary: data.vocabulary });
        return super.postMessage(data, ...rest);
      }
    };
    if (native) window.flutter_inappwebview = { async callHandler(_, payload) {
      const m = JSON.parse(payload);
      if (m.method.endsWith('LocalStorage')) return window.__storage(m);
      if (m.method === 'audioControl') { window.__micCalls.push(m.data.isOpen); if (m.data.isOpen) await new Promise(resolve => setTimeout(resolve, window.__micDelay)); return true; }
      return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
    } };
  }, { native });
  page = await context.newPage(); page.on('pageerror', error => result.errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('speech-worker') && url.pathname.endsWith('.js')) {
      if (real) {
        const response = await route.fetch();
        return route.fulfill({ response, body: await response.text() + `
          const files = ${JSON.stringify(speechDownloads.map(entry => ({ url: entry.url, local: `${origin}/fixture-models/${entry.file}` })))};
          const fetchFile = self.fetch.bind(self); self.fetch = (url, options) => fetchFile(files.find(file => file.url === String(url))?.local || url, options);
          const dispatch = self.onmessage; self.onmessage = event => { if (${!gpu} && event.data.model === 'refine') event.data.backend = 'wasm'; dispatch(event); };` });
      }
      return route.fulfill({ contentType: 'text/javascript', body: `self.onmessage = ({data}) => {
        if (data.operation === 'cancel') return;
        const send = value => setTimeout(() => self.postMessage({id:data.id,...value}), data.operation === 'prepare' ? 150 : 80);
        if (${noGpu} && data.model === 'refine') return send({error:'WebGPU unavailable'});
        if (data.operation === 'prepare') return send({result:{backend:data.backend,model:data.model}});
        send({result:{text:data.model === 'fast' ? 'yellow world' : 'hello world',backend:data.backend,transcribeMs:70,seconds:1,loadMs:0}});
      };` });
    }
    if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
    result.unexpectedNetwork.push(url.href); return route.abort();
  });
  await page.goto(origin); await expect(page.locator('#import')).toBeEnabled();
  // Keep the WebKit DOM wrapper alive (otherwise its test override can be
  // collected). Capture runs the real worklet, resampling and stop/flush code.
  if (!native) await page.evaluate(() => {
    window.__mediaDevices = navigator.mediaDevices;
    window.__mediaDevices.getUserMedia = async () => {
      const context = window.__audioContext = new AudioContext(); await context.resume();
      const source = context.createBufferSource(), destination = context.createMediaStreamDestination();
      const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
      const samples = buffer.getChannelData(0); for (let i = 0; i < samples.length; i++) samples[i] = .1 * Math.sin(i * .1);
      source.buffer = buffer; source.loop = true;
      source.connect(destination); source.start(); window.__tracks = destination.stream.getTracks(); return destination.stream;
    };
  });
  await showSettings(page); await page.locator('#speech-benchmark-panel > summary').click();
  return context;
}
async function nativeAudio() {
  await page.evaluate(encoded => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { audioEvent: {
    audioPcm: Uint8Array.from(atob(encoded), c => c.charCodeAt(0)), source: 'glasses',
  } } })), wave.subarray(44).toString('base64'));
}
async function save(selector) {
  const download = page.waitForEvent('download'); await page.locator(selector).click();
  const file = await download; const bytes = await readFile(await file.path());
  return { bytes, name: file.suggestedFilename() };
}
async function compare(reference) {
  await page.locator('#speech-record-reference').fill(reference); await page.locator('#speech-record-compare').click();
  await expect(page.locator('#speech-benchmark-status')).toContainText('Benchmark finished', { timeout: real ? 240000 : 30000 });
  return JSON.parse((await save('#speech-results-save')).bytes.toString());
}
try {
  const context = await open(true);
  await page.locator('#speech-record').click(); await expect(page.locator('#speech-benchmark-status')).toContainText('Recording ·');
  await nativeAudio(); await page.locator('#speech-record').click();
  await expect(page.locator('#speech-record-compare')).toBeEnabled();
  await expect(page.locator('#speech-record-playback')).toBeVisible();
  assert.equal(await page.evaluate(() => window.__calls.length), 0, 'Recording alone does not start models or a chat');
  const recording = await save('#speech-record-save'); assert.equal(recording.name, 'pageborne-voice-test.wav'); assert.deepEqual(recording.bytes, wave);
  result.wavExport = true;
  result.recording = await compare(real ? references[0].reference : 'hello world');
  if (gpu) {
    assert.equal(result.recording.prepared.refine.backend, 'webgpu');
    assert(result.recording.prepared.refine.adapter && !result.recording.prepared.refine.adapter.fallback, 'requires a hardware GPU');
  }
  assert.equal(result.recording.runs.length, 1); assert(result.recording.completed);
  assert(result.recording.runs[0].fast.text); assert(result.recording.runs[0].refine.text);
  if (!real) { assert.equal(result.recording.summary.fast.wer, .5); assert.equal(result.recording.summary.refine.wer, 0); assert.equal(result.recording.summary.paired.fixed, 1); }
  assert.equal(result.recording.summary.paired.meanMs, result.recording.runs[0].fast.ms + result.recording.runs[0].refine.ms);
  await page.screenshot({ path: path.join(out, 'phone-recording.png') });

  // All included fixtures must be packaged and work without importing a file.
  await page.locator('#speech-refinement').uncheck(); await page.locator('#speech-backend').selectOption('remote');
  await page.locator('#speech-benchmark').click();
  await expect(page.locator('#speech-benchmark-status')).toContainText('Benchmark finished', { timeout: real ? 600000 : 30000 });
  result.bundled = JSON.parse((await save('#speech-results-save')).bytes.toString());
  assert.equal(result.bundled.runs.length, 18); assert.equal(result.bundled.summary.paired.count, 18);
  assert.equal(result.bundled.runs.filter(row => row.noisy).length, 9);
  const calls = await page.evaluate(() => window.__calls);
  assert.equal(calls.filter(row => row.operation === 'prepare' && row.model === 'fast').length, 1, 'CPU model stays resident');
  assert.equal(calls.filter(row => row.operation === 'prepare' && row.model === 'refine').length, 2, 'Disabling corrections unloads Small; an explicit benchmark reloads it once');
  assert.equal(result.bundled.prepared.fast.alreadyReady, true);
  assert.equal(result.bundled.prepared.refine.alreadyReady, false);
  if (real) assert.equal(result.bundled.prepared.refine.download.downloadedBytes, 0, 'Reload reuses verified weights');
  assert(calls.filter(row => row.operation === 'transcribe').every(row => row.vocabulary.length === 0), 'No reference/custom vocabulary leakage');
  result.residentModels = true; result.gpuReloadedAfterDisable = true; result.noHints = true;
  await expect(page.locator('#speech-backend')).toHaveValue('remote'); await expect(page.locator('#speech-refinement')).not.toBeChecked();
  result.preferencesUnchanged = true;
  await page.locator('#speech-benchmark-output').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(out, 'phone-results.png') });
  await page.locator('#speech-backend').selectOption('wasm'); await page.locator('#speech-refinement').check();

  if (!real) {
    const noReference = await compare(''); assert.equal(noReference.summary.fast.wer, null); assert.equal(noReference.summary.refine.wer, null);
    // Late permission must not resurrect a cancelled recording or replace WAV.
    await page.evaluate(() => { window.__micDelay = 500; window.__micCalls = []; });
    await page.locator('#speech-record').click(); await page.locator('#speech-benchmark-cancel').click();
    await expect(page.locator('#speech-record')).toHaveText('Record a test');
    assert.deepEqual(await page.evaluate(() => window.__micCalls), [true, false]);
    assert.deepEqual((await save('#speech-record-save')).bytes, wave);
    await page.evaluate(() => { window.__micDelay = 0; });
    await page.locator('#speech-record').click(); await nativeAudio(); await hideSettings(page);
    await expect.poll(() => page.evaluate(() => window.__micCalls.at(-1))).toBe(false);
    result.cancelStopsMic = true;
    await page.locator('#file-picker').setInputFiles({ name: 'test.md', mimeType: 'text/markdown', buffer: Buffer.from('# Test\n\nA local test.') });
    await showLibrary(page); await page.locator('[data-document-id="test.md"] .document-card').click();
    await page.locator('#ask-open').click(); await page.locator('#ask-voice').click(); await nativeAudio(); await page.locator('#ask-voice').click();
    await expect(page.locator('#ask-question')).toHaveValue('hello world'); await page.locator('#ask-review-cancel').click(); await backToReading(page);
    result.askAfterRecording = true;
    await showSettings(page); await page.locator('#speech-benchmark').click(); await page.locator('#speech-benchmark-cancel').click();
    await expect(page.locator('#speech-benchmark')).toBeEnabled();
    await page.waitForTimeout(600); await expect(page.locator('#speech-benchmark-status')).toContainText('Cancelled');
  }
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await context.close();
  if (!real) {
    const browserContext = await open(false, true);
    await page.locator('#speech-record').click(); await expect(page.locator('#speech-benchmark-status')).toContainText('Recording ·');
    await expect(page.locator('#speech-benchmark-status')).toContainText(/Recording · [1-9]/);
    await page.locator('#speech-record').click(); await expect(page.locator('#speech-record-compare')).toBeEnabled();
    assert(await page.evaluate(() => window.__tracks.every(track => track.readyState === 'ended')));
    const browserWave = await save('#speech-record-save'); assert(waveSamples(browserWave.bytes.buffer.slice(browserWave.bytes.byteOffset, browserWave.bytes.byteOffset + browserWave.bytes.length)).length >= 1600);
    result.browserAudioWorkletCapture = true;
    const cpu = await compare('yellow world'); assert.equal(cpu.summary.fast.wer, 0); assert.equal(cpu.summary.refine.count, 0); assert.match(cpu.prepared.refine.error, /unavailable/);
    result.unavailableGpuStillScoresCpu = true;
    await page.evaluate(() => window.__audioContext.close()); await browserContext.close();
  }
  assert.deepEqual(result.errors, []); assert.deepEqual(result.unexpectedNetwork, []); result.passed = true;
} catch (error) {
  result.error = error.stack;
  if (page && !page.isClosed()) { result.status = await page.locator('#speech-benchmark-status').textContent(); await page.screenshot({ path: path.join(out, 'failure.png') }); }
  if (page && !page.isClosed()) result.diagnostics = await page.evaluate(() => ({ audioState: window.__audioContext?.state, tracks: window.__tracks?.length, errors: JSON.parse(localStorage.getItem('even-reader:diagnostics:v1') || '{}').errors }));
  throw error;
} finally {
  clearInterval(monitor); await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2)); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
console.log(JSON.stringify({ passed: result.passed, actualModels: real, physicalPhone: false, tests: result.bundled?.runs.length, summary: result.bundled?.summary }, null, 2));
