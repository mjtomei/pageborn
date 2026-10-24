// Real bundled model inference. Only the conversational agent and glasses
// hardware are simulated; no real Terminal session receives test prompts.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';
import { backToReading, showSettings, showLibrary, hideSettings, waitForPdfReady } from './ui-helpers.mjs';

const out = path.resolve('test-results/speech'); await mkdir(out, { recursive: true });
const samples = [{ file: 'jfk.wav', reference: 'And so my fellow Americans ask not what your country can do for you ask what you can do for your country',
  source: 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav' }];
try { await readFile(path.join(out, 'jfk.wav')); }
catch { const r = await fetch(samples[0].source); assert(r.ok); await writeFile(path.join(out, 'jfk.wav'), Buffer.from(await r.arrayBuffer())); }
// Optional extra local/public-domain fixtures, with references for WER.
try { if (!process.argv.includes('--quick')) samples.push(...JSON.parse(await readFile(path.join(out, 'samples.json'), 'utf8'))); } catch {}
const server = createApp({ distDir: path.resolve('dist') }).listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${path.join(out, 'jfk.wav')}`,
    ...(process.env.PAGEBORNE_SPEECH_HARDWARE ? ['--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface', '--disable-gpu-compositing'] : [])] });
const result = { passed: false, benchmark: [], errors: [], unexpectedNetwork: [] };
const hardware = !!process.env.PAGEBORNE_SPEECH_HARDWARE;
const prompts = []; const sessions = new Map(); let serial = 0;
async function newContext(native = false, noGpu = false) {
  const context = await browser.newContext({ viewport: { width: 440, height: 806 } });
  await context.grantPermissions(['microphone'], { origin });
  const storage = new Map();
  await context.exposeFunction('__storage', ({ method, data }) => {
    if (method === 'getLocalStorage') return storage.get(data.key) || '';
    storage.set(data.key, data.value); return true;
  });
  await context.addInitScript(({ native, noGpu }) => {
    window.__micCalls = []; window.__micDelay = 0;
    if (navigator.mediaDevices?.getUserMedia) {
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async options => (window.__stream = await getUserMedia(options));
    }
    if (native) window.flutter_inappwebview = { async callHandler(_, payload) {
      const m = JSON.parse(payload);
      if (m.method.endsWith('LocalStorage')) return window.__storage(m);
      if (m.method === 'audioControl') { window.__micCalls.push(m.data.isOpen); if (m.data.isOpen) await new Promise(r => setTimeout(r, window.__micDelay)); return true; }
      return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
    } };
  }, { native, noGpu });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (noGpu && url.pathname.includes('speech-worker') && url.pathname.endsWith('.js')) {
      const response = await route.fetch(); return route.fulfill({ response, body: "Object.defineProperty(navigator, 'gpu', {value:undefined});\n" + await response.text() });
    }
    if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
    if (!url.pathname.startsWith('/api/')) { result.unexpectedNetwork.push(url.origin); return route.abort(); }
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const json = body => route.fulfill({ headers, json: body });
    if (url.pathname === '/api/info') return json({ provider: 'codex' });
    if (url.pathname === '/api/events') return route.fulfill({ headers, contentType: 'text/event-stream', body: ':ok\n\n' });
    if (url.pathname.endsWith('/history')) return json({ history: [] });
    if (url.pathname === '/api/messages') return json({ state: 'idle', messages: (sessions.get(url.searchParams.get('sessionId')) || []).filter(m => m.id > Number(url.searchParams.get('after') || 0)) });
    if (url.pathname === '/api/prompt') {
      const body = req.postDataJSON(); prompts.push(body.text);
      const id = body.sessionId || `speech-${++serial}`; const messages = sessions.get(id) || []; const n = messages.at(-1)?.id || 0;
      sessions.set(id, [...messages, { id: n + 1, type: 'user_prompt', text: body.text }, { id: n + 2, type: 'result', success: true, text: 'Test answer to the locally transcribed question.' }]);
      return json({ sessionId: id });
    }
    throw new Error(`Unexpected Terminal route: ${url.pathname}`);
  });
  const page = await context.newPage(); page.on('pageerror', e => result.errors.push(e.message));
  await page.goto(origin); await expect(page.locator('#import')).toBeEnabled();
  return { page, context };
}
function wer(reference, text) {
  const words = s => s.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').trim().split(/\s+/);
  const a = words(reference), b = words(text); let row = b.map((_, i) => i + 1); row.unshift(0);
  for (let i = 0; i < a.length; i++) { const next = [i + 1]; for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1))); row = next; }
  return row.at(-1) / a.length;
}
async function toPcm(page, bytes) {
  return Buffer.from(await page.evaluate(async data => {
    const input = Uint8Array.from(atob(data), c => c.charCodeAt(0)).buffer;
    const ctx = new AudioContext(); const audio = await ctx.decodeAudioData(input); await ctx.close();
    const offline = new OfflineAudioContext(1, Math.ceil(audio.duration * 16000), 16000);
    const source = offline.createBufferSource(); source.buffer = audio; source.connect(offline.destination); source.start();
    const values = (await offline.startRendering()).getChannelData(0); const output = new Uint8Array(44 + values.length * 2), v = new DataView(output.buffer);
    for (const [at, s] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']]) for (let i = 0; i < s.length; i++) output[at + i] = s.charCodeAt(i);
    v.setUint32(4, output.length - 8, true); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); v.setUint32(40, values.length * 2, true);
    for (let i = 0; i < values.length; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, values[i])) * 32767), true);
    return Array.from(output);
  }, bytes.toString('base64')));
}
try {
  const { page, context } = await newContext();
  await showSettings(page);
  let wave;
  for (const sample of samples) {
    const audio = await toPcm(page, await readFile(path.join(out, sample.file))); wave ||= audio;
    await page.locator('#speech-test-file').setInputFiles({ name: sample.file, mimeType: 'audio/wav', buffer: audio });
    await expect(page.locator('#speech-status')).toContainText('Comparison finished', { timeout: 240000 });
    const text = await page.locator('#speech-test-output').textContent();
    if (hardware) assert(!text.includes('unavailable') && !text.includes('failed') && !text.includes('Cannot'), text);
    else assert.match(text, /WebGPU.*unavailable/i);
    const entries = text.trim().split('\n\n'); assert.equal(entries.length, 2);
    const metrics = await page.evaluate(() => JSON.parse(localStorage.getItem('even-reader:diagnostics:v1')).events.filter(e => e.type === 'local-speech').slice(-2));
    for (const [i, entry] of entries.entries()) {
      if (!hardware && i === 1) continue;
      const recognized = entry.split('\n').slice(2).join('\n'); const errorRate = wer(sample.reference, recognized);
      result.benchmark.push({ sample: sample.file, source: sample.source, ...metrics[i], text: recognized, wordErrorRate: errorRate });
      assert(errorRate < .35, `${sample.file}: excessive word error rate ${errorRate}\n${text}`);
    }
  }
  assert.equal(prompts.length, 0, 'Comparison does not submit a question');
  // Resident models are reused by manual preparation; local input migrates
  // the former GPU-first preference to the fixed CPU-draft pipeline.
  await page.locator('#speech-prepare').click();
  await expect(page.locator('#speech-status')).toContainText('CPU draft: ready', { timeout: 60000 });
  await page.locator('#speech-backend').selectOption('remote'); await page.reload(); await expect(page.locator('#import')).toBeEnabled();
  await showSettings(page); await expect(page.locator('#speech-backend')).toHaveValue('remote');
  result.backendPersists = true; await context.close();

  const missing = await newContext(false, true); await showSettings(missing.page);
  await missing.page.locator('#speech-prepare').click();
  await expect(missing.page.locator('#speech-status')).toContainText('WebGPU is unavailable', { timeout: 60000 });
  await expect(missing.page.locator('#speech-status')).toContainText('CPU draft: ready');
  result.noGpuGuidance = true; await missing.context.close();

  const phone = await newContext(true); const p = phone.page;
  await p.locator('#file-picker').setInputFiles([
    { name: 'question.md', mimeType: 'text/markdown', buffer: Buffer.from('# Reference\n\nThe country belongs to its people. '.repeat(80)) },
    { name: 'paper.pdf', mimeType: 'application/pdf', buffer: pdfFixture('annotations') },
  ]);
  const event = detail => p.evaluate(detail => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail })), detail);
  const audioEvent = async () => p.evaluate(data => { window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { audioEvent: { audioPcm: Uint8Array.from(atob(data), c => c.charCodeAt(0)), source: 'glasses' } } })); }, wave.subarray(44).toString('base64'));
  for (const [i, name] of ['question.md', 'paper.pdf'].entries()) {
    await showLibrary(p); await p.locator(`[data-document-id="${name}"] .document-card`).click(); await expect(p.locator('#ask-open')).toBeEnabled();
    if (name.endsWith('.pdf')) await waitForPdfReady(p);
    await p.locator('#position').evaluate(el => { el.value = '300'; el.dispatchEvent(new Event('input')); });
    const position = await p.locator('#position').inputValue();
    await event({ sysEvent: { eventType: 9 } }); await expect(p.locator('#ask-status')).toContainText('Listening');
    await audioEvent(); await event({ sysEvent: { eventType: 10 } });
    await expect(p.locator('#ask-review-cancel')).toBeVisible({ timeout: 60000 }); assert.equal(prompts.length, i);
    await expect(p.locator('#ask-question')).toHaveValue(/what your country can do for you/i);
    if (i === 0) {
      await expect(p.locator('#ask-status')).toHaveText(hardware ? /Transcription (updated|checked)/ : /Kept first transcription/, { timeout: 120000 });
      await expect(p.locator('#ask-voice-metrics')).toContainText(hardware ? 'Whisper Small' : 'Moonshine Tiny');
      assert.equal(prompts.length, 0, 'A completed real refinement stays unsent until confirmation');
      result.realBackgroundRefinement = hardware;
    }
    await p.locator('#ask-send').click();
    await expect(p.locator('#ask-answer')).toContainText('Test answer to the locally transcribed question', { timeout: 60000 });
    assert.match(prompts[i], /what your country can do for you/i);
    await p.screenshot({ path: path.join(out, name.endsWith('.pdf') ? 'pdf-voice-answer.png' : 'markdown-voice-answer.png') });
    await backToReading(p); assert.equal(await p.locator('#position').inputValue(), position);
  }
  assert.equal(prompts.length, 2);
  const log = await p.evaluate(() => localStorage.getItem('even-reader:diagnostics:v1'));
  assert(!log.includes('fellow Americans'), 'Recognized voice text stays out of diagnostic exports');
  assert.deepEqual(await p.evaluate(() => window.__micCalls), [true, false, true, false]);
  result.glassesMicrophoneToAsk = true; result.pdfLoadedDuringSpeech = true; result.readingPositionPreserved = true;
  // Release during pending microphone permission/start stops it exactly once.
  await p.evaluate(() => window.__micDelay = 400); await event({ sysEvent: { eventType: 9 } });
  await expect(p.locator('#ask-status')).toHaveText('Starting microphone…'); await event({ sysEvent: { eventType: 10 } });
  await expect(p.locator('#ask-status')).toContainText('No speech'); assert.equal(prompts.length, 2);
  await backToReading(p);
  // A cancelled local transcription cannot submit later or block typed input.
  await showSettings(p); await p.locator('#speech-backend').selectOption('wasm'); await hideSettings(p);
  await event({ sysEvent: { eventType: 9 } }); await expect(p.locator('#ask-status')).toContainText('Listening'); await audioEvent();
  await event({ sysEvent: { eventType: 10 } }); await expect(p.locator('#ask-status')).toContainText(/Transcribing|Loading/);
  await backToReading(p); await p.locator('#ask-open').click(); await p.locator('#ask-question').fill('A typed question after cancellation'); await p.locator('#ask-send').click();
  await expect(p.locator('#ask-answer')).toContainText('Test answer to the locally transcribed question'); assert.equal(prompts.length, 3); assert.match(prompts.at(-1), /A typed question/);
  result.earlyRelease = true; result.cancelInferenceThenType = true; await phone.context.close();
  const desktop = await newContext(); const d = desktop.page; const beforeBrowserVoice = prompts.length;
  await d.locator('#file-picker').setInputFiles({ name: 'browser.md', mimeType: 'text/markdown', buffer: Buffer.from('# Browser voice\n\nAsk a spoken question here.') });
  await showLibrary(d); await d.locator('[data-document-id="browser.md"] .document-card').click();
  await d.locator('#ask-open').click(); await d.locator('#ask-voice').click(); await expect(d.locator('#ask-status')).toContainText('Listening');
  await expect(d.locator('#ask-question')).not.toHaveValue('', { timeout: 10000 });
  await expect(d.locator('#ask-status')).toContainText('Listening');
  assert(await d.locator('#ask-question').evaluate(input => input.readOnly));
  await d.waitForTimeout(6000); // AudioWorklet keeps supplying PCM while partial inference runs.
  await d.locator('#ask-voice').click(); await expect(d.locator('#ask-review-cancel')).toBeVisible({ timeout: 60000 });
  assert.equal(prompts.length, beforeBrowserVoice); await d.locator('#ask-send').click();
  await expect(d.locator('#ask-answer')).toContainText('Test answer to the locally transcribed question', { timeout: 60000 });
  assert.equal(prompts.length, beforeBrowserVoice + 1); assert.match(prompts.at(-1), /country/i);
  assert(await d.evaluate(() => window.__stream.getTracks().every(track => track.readyState === 'ended')));
  result.browserMicrophoneToAsk = true; result.browserPartialBeforeRelease = true; await desktop.context.close();
  assert.deepEqual(result.errors, []); assert.deepEqual(result.unexpectedNetwork, []);
  result.passed = true;
} finally {
  await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2)); await browser.close();
  server.closeAllConnections(); await new Promise(r => server.close(r));
}
console.log(JSON.stringify(result, null, 2));
