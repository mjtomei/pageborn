// Local browser CPU/SIMD and WebGPU comparisons. No app settings/chat sessions.
// Candidate assets/manifests live in .state/stt-benchmark; output keeps references
// and transcripts of public fixtures only, never user microphone recordings.
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareBenchmarks } from './prepare-speech-benchmark.mjs';
await prepareBenchmarks({ gpu: process.argv.includes('--webgpu') || process.argv.includes('--large') });
const gpu = process.argv.includes('--webgpu');
const large = process.argv.includes('--large');
const quick = process.argv.includes('--quick');
const confidence = process.argv.includes('--confidence');
const memoryPair = process.argv.includes('--memory-pair');
const memorySingle = process.argv.includes('--memory-single');
const memory = memoryPair || memorySingle || process.argv.includes('--memory');
const root = process.cwd(), out = path.join(root, 'test-results/speech-models');
await mkdir(out, { recursive: true });
const modelRoot = path.join(root, '.state/stt-benchmark');
const profiles = [
  { name: 'Moonshine Tiny (current)', directory: 'moonshine-tiny', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } },
  { name: 'Moonshine Base', directory: 'moonshine-base', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } },
  { name: 'Moonshine Base int8', directory: 'moonshine-base', dtype: 'q8' },
  { name: 'Whisper Base English int8', directory: 'whisper-base.en', dtype: 'q8' },
  { name: 'Whisper Small English int8', directory: 'whisper-small.en', dtype: 'q8' },
];
if (gpu) profiles.splice(1, profiles.length - 1,
  { name: 'Whisper Small English fp32/q4', directory: 'whisper-small.en', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } });
if (large) profiles.push(
  { name: 'Whisper Medium English q4', directory: 'whisper-medium.en', dtype: 'q4' },
  { name: 'Whisper Large v3 Turbo q4', directory: 'whisper-large-v3-turbo', dtype: 'q4' });
if (memoryPair || confidence && !gpu && !large) profiles.splice(1, 3);
// Exercise the same audio splitting, bounds and decoding settings as the app.
let source = await readFile(new URL(import.meta.resolve('@pageborne/browser-stt/speech-worker')), 'utf8');
source = source.replace("import { speechModels } from './speech-models.js';", '');
source = source.replace('const profile = speechModels[modelId];', 'const profile = data.profile;');
source = source.replace("from './speech-download.js'", "from '/src/speech-download.js'");
source = source.replace("from './speech-confidence.js'", "from '/src/speech-confidence.js'");
source = source.replace("from './speech-vocabulary.js'", "from '/src/speech-vocabulary.js'");
const audioSource = await readFile(new URL(import.meta.resolve('@pageborne/browser-stt/speech-audio')), 'utf8');
source = source.replace("import { waveSamples, SPEECH_RATE } from './speech-audio.js';", audioSource.slice(audioSource.indexOf('export const SPEECH_RATE'), audioSource.indexOf('export function samplesWave')).replaceAll('export ', '')).replaceAll("'../node_modules/", "'/node_modules/");
if (gpu) {
  source = source.replace('navigator.gpu?.requestAdapter()', "navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' })");
  source = source.replace('adapterInfo = {', "if (adapter.info?.isFallbackAdapter || adapter.info?.vendor !== 'nvidia') throw new Error('Hardware NVIDIA adapter required for this benchmark: ' + adapter.info?.vendor + '/' + adapter.info?.architecture + '/fallback=' + adapter.info?.isFallbackAdapter); env.backends.onnx.webgpu.adapter = adapter; adapterInfo = {");
}
if (confidence) {
  source = source.replace('const texts = [], words = [];', 'const tokenScores = []; const texts = [], words = [];');
  source = source.replace('scores.push(score);', 'scores.push(score); tokenScores.push({ ...score, logProbability: Math.log(score.probability) });');
  source = source.replace("text: texts.join(' ').trim(),", `text: texts.join(' ').trim(), confidence: {
    tokenCount: tokenScores.length,
    meanTokenProbability: tokenScores.reduce((sum, x) => sum + x.probability, 0) / tokenScores.length,
    geometricMeanTokenProbability: Math.exp(tokenScores.reduce((sum, x) => sum + x.logProbability, 0) / tokenScores.length),
    minimumTokenProbability: Math.min(...tokenScores.map(x => x.probability)), tokenScores },`);
}
await writeFile(path.join(modelRoot, confidence ? 'confidence-worker.js' : gpu ? 'gpu-worker.js' : 'worker.js'), source);
const server = await createServer({ cacheDir: '.state/vite-speech-bench', root, configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true, include: ['@huggingface/transformers', 'wasm-feature-detect'] }, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
server.middlewares.use(async (req, res, next) => {
  const url = req.url?.split('?')[0]; if (url === '/benchmark.html') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><title>Speech benchmark</title>'); } if (!url?.startsWith('/stt/')) return next();
  const suffix = url.slice(5); if (suffix.includes('..')) { res.statusCode = 400; return res.end(); }
  const file = suffix.startsWith('ort-') ? path.join(root, 'node_modules/onnxruntime-web/dist', suffix)
    : path.join(suffix.startsWith('moonshine-tiny/') ? path.join(root, '.state/stt-assets') : modelRoot, suffix);
  try { res.setHeader('Content-Type', suffix.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream'); res.end(await readFile(file)); }
  catch { res.statusCode = 404; res.end(); }
});
await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: !process.argv.includes('--headed'),
  ...(gpu ? { args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface', '--disable-gpu-compositing'],
    env: { ...process.env, DISPLAY: ':0', XAUTHORITY: '/run/user/1000/gdm/Xauthority', VK_ICD_FILENAMES: '/usr/share/vulkan/icd.d/nvidia_icd.json' } } : {}) });
const page = await browser.newPage();
const cdp = await browser.newBrowserCDPSession();
async function residentMemory() {
  const processes = (await cdp.send('SystemInfo.getProcessInfo')).processInfo;
  let rssKb = 0, pssKb = 0, privateKb = 0, cpuSeconds = 0;
  for (const process of processes) {
    try {
      const smaps = await readFile(`/proc/${process.id}/smaps_rollup`, 'utf8');
      const kb = name => Number(smaps.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))?.[1] || 0);
      rssKb += kb('Rss'); pssKb += kb('Pss'); privateKb += kb('Private_Clean') + kb('Private_Dirty'); cpuSeconds += process.cpuTime;
    } catch {}
  }
  return { rssMB: rssKb / 1024, pssMB: pssKb / 1024, privateMB: privateKb / 1024, cpuSeconds };
} 
const resultName = confidence ? 'confidence-results' : memoryPair ? 'memory-pair' : memorySingle ? 'memory-single' : memory ? 'memory' : gpu ? 'webgpu-results' : large ? 'large-cpu-results' : 'results';
const resultFile = path.join(out, `${resultName}${quick ? '-quick' : ''}.json`);
const results = { at: new Date().toISOString(), environment: { arch: os.arch(), cpu: os.cpus()[0].model, threads: 1, backend: gpu ? 'webgpu' : 'wasm', browser: browser.version() }, profiles, samples: [], runs: [], errors: [] };
page.on('pageerror', e => results.errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') console.log('BROWSER', m.text().slice(0, 2500)); });
try {
  await page.goto(`${origin}/benchmark.html`);
  await page.evaluate(gpu => {
    window.backend = gpu ? 'webgpu' : 'wasm';
    window.runSpeech = (profile, audio) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Benchmark timed out after 180s')), 180000);
      const id = ++window.serial || (window.serial = 1);
      window.worker.onmessage = ({ data }) => { if (data.id !== id) return; if (data.error) { clearTimeout(timer); reject(new Error(data.error)); } else if (data.result) { clearTimeout(timer); resolve(data.result); } };
      window.worker.onerror = e => { clearTimeout(timer); reject(new Error(e.message)); };
      window.worker.postMessage({ id, operation: 'transcribe', backend: window.backend, base: `${location.origin}/stt/`, profile, audio: Uint8Array.from(audio).buffer });
    });
  }, gpu);
  const samples = [{ file: 'jfk.wav', reference: 'And so my fellow Americans ask not what your country can do for you ask what you can do for your country', source: 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav' }, ...(memory || quick ? [] : JSON.parse(await readFile('test-results/speech/benchmark-samples.json', 'utf8')))];
  if (quick) samples.push({ ...samples[0], repeat: true });
  for (const sample of samples) {
    const encoded = (await readFile(path.join(root, 'test-results/speech', sample.file))).toString('base64');
    for (const noisy of (memory || quick ? [false] : [false, true])) {
      const audio = await page.evaluate(async ({ encoded, noisy }) => {
        const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
        const ac = new AudioContext(); const decoded = await ac.decodeAudioData(bytes.buffer); await ac.close();
        const oc = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
        const src = oc.createBufferSource(); src.buffer = decoded; src.connect(oc.destination); src.start();
        const values = (await oc.startRendering()).getChannelData(0);
        if (noisy) {
          let energy = 0; for (const value of values) energy += value ** 2;
          const amplitude = Math.sqrt(energy / values.length) / Math.sqrt(10 ** (10 / 10)) * Math.sqrt(3);
          let seed = 714;
          for (let i = 0; i < values.length; i++) { seed = (1664525 * seed + 1013904223) >>> 0; values[i] = Math.max(-1, Math.min(1, values[i] + (seed / 2 ** 32 * 2 - 1) * amplitude)); }
        }
        // Identical 16-kHz PCM input for every model; noisy copies use seeded 10-dB uniform noise.
        const bytesOut = new Uint8Array(44 + values.length * 2), view = new DataView(bytesOut.buffer);
        for (const [at, s] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']]) for (let i = 0; i < s.length; i++) bytesOut[at+i] = s.charCodeAt(i);
        view.setUint32(4, bytesOut.length-8,true); view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,16000,true); view.setUint32(28,32000,true); view.setUint16(32,2,true); view.setUint16(34,16,true); view.setUint32(40,values.length*2,true);
        for (let i=0;i<values.length;i++) view.setInt16(44+i*2, Math.round(values[i]*32767),true);
        return Array.from(bytesOut);
      }, { encoded, noisy });
      // Keep PCM in memory for inference, not repeatedly in the JSON report.
      const { audio: _clean, noisyAudio: _noisy, ...metadata } = sample;
      results.samples.push({ ...metadata, noisy, seconds: (audio.length-44)/32000 });
      sample[noisy ? 'noisyAudio' : 'audio'] = audio;
    }
  }
  if (memory) { await delay(1000); results.baselineMemory = await residentMemory(); }
  for (const profile of profiles) {
    if (memorySingle) { await page.evaluate(() => { for (const worker of window.workers || []) worker.terminate(); window.workers = []; }); await delay(1500); await page.requestGC(); await delay(500); profile.baselineMemory = await residentMemory(); }
    await page.evaluate(({ memory, confidence, gpu }) => { if (!memory) window.worker?.terminate(); window.worker = new Worker(confidence ? '/.state/stt-benchmark/confidence-worker.js' : gpu ? '/.state/stt-benchmark/gpu-worker.js' : '/.state/stt-benchmark/worker.js', { type: 'module' }); (window.workers ||= []).push(window.worker); }, { memory, confidence, gpu });
    const selectedFiles = ['config.json','generation_config.json','preprocessor_config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json', ...(typeof profile.dtype === 'string' ? profile.dtype === 'q4' ? ['onnx/encoder_model_q4.onnx','onnx/decoder_model_merged_q4.onnx'] : ['onnx/encoder_model_quantized.onnx','onnx/decoder_model_merged_quantized.onnx'] : ['onnx/encoder_model.onnx','onnx/decoder_model_merged_q4.onnx'])];
    const manifest = JSON.parse(await readFile(profile.directory === 'moonshine-tiny' ? new URL(import.meta.resolve('@pageborne/browser-stt/manifests/model.json')) : path.join(modelRoot, `${profile.directory}${gpu || profile.directory.includes('medium') || profile.directory.includes('turbo') ? '-gpu' : ''}.json`), 'utf8'));
    profile.repository = manifest.repository; profile.revision = manifest.revision;
    profile.assets = manifest.files.filter(x => selectedFiles.includes(x.file)); profile.bytes = profile.assets.reduce((n, x) => n+x.bytes,0);
    sampleLoop: for (const sample of samples) for (const noisy of (memory || quick ? [false] : [false, true])) {
      const start = performance.now();
      try {
        const result = await page.evaluate(({ profile, audio }) => window.runSpeech(profile,audio), { profile, audio: sample[noisy ? 'noisyAudio' : 'audio'] });
        const words = value => value.toLowerCase().replace(/\bmr\.?\s/gu, 'mister ').replace(/[^\p{L}\p{N}' ]/gu,' ').split(/\s+/).filter(Boolean);
        const ref=words(sample.reference), hyp=words(result.text); let row=Array.from({length:hyp.length+1},(_,i)=>i);
        for(let i=1;i<=ref.length;i++){const next=[i];for(let j=1;j<=hyp.length;j++)next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(ref[i-1]===hyp[j-1]?0:1));row=next;}
        results.runs.push({sample:sample.file,repeat:!!sample.repeat,noisy,...result,wallMs:Math.round(performance.now()-start),wordErrors:row[hyp.length],referenceWords:ref.length,wer:row[hyp.length]/ref.length});
        if (memory) {
          await delay(1000); await page.requestGC(); await delay(1000);
          const before = await residentMemory(); await delay(3000); const after = await residentMemory();
          results.runs.at(-1).memory = { ...after, idleCpuSecondsOver3Seconds: after.cpuSeconds - before.cpuSeconds };
        }
        console.log(JSON.stringify(results.runs.at(-1)));
      } catch(error) { results.errors.push({model:profile.name,sample:sample.file,noisy,error:error.message}); console.log('ERROR',profile.name,error.message); if (error.message.includes('Hardware NVIDIA')) throw error; break sampleLoop; }
      await writeFile(resultFile,JSON.stringify(results,null,2)+'\n');
    }
  }
} finally { await writeFile(resultFile,JSON.stringify(results,null,2)+'\n'); await browser.close(); await server.close(); }
