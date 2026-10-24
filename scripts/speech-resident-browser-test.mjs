// Bundled CPU + downloaded correction model, inference and model lifetime.
// No agent requests are submitted. Run on this workstation's hardware WebGPU.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { showLibrary, showSettings, hideSettings, backToReading } from './ui-helpers.mjs';
import { speechDownloads, speechDownloadOrigins } from '../src/speech-download-config.js';

// Explicit test-only override exercises the same packaged correction model and
// vocabulary prefix when the shared workstation cannot allocate a GPU context.
const cpuValidation = process.env.PAGEBORNE_TEST_CORRECTION_DEVICE === 'wasm';
const out = path.resolve(cpuValidation ? 'test-results/speech-resident-cpu-validation' : 'test-results/speech-resident'); await mkdir(out, { recursive: true });
const server = createApp({ distDir: path.resolve('dist') }).listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface', '--disable-gpu-compositing'],
  env: { ...process.env, VK_ICD_FILENAMES: '/usr/share/vulkan/icd.d/nvidia_icd.json' } });
const result = { passed: false, physicalPhone: false, correctionDeviceOverride: cpuValidation ? 'wasm (test only)' : null, errors: [], runs: [], modelRequests: [], modelResponseOrigins: [] };
const technicalPassage = `qubit axion baryon boson fermion lepton hadron gluon neutrino muon tauon meson positron graviton phonon magnon exciton plasmon polariton anyon soliton skyrmion instanton monopole dipole quadrupole eigenstate eigenvalue eigenvector eigenfunction Hamiltonian Lagrangian Hessian Jacobian Laplacian Hilbert Banach Fourier Laplace Dirac Pauli Feynman Schrodinger Heisenberg Lorentz Minkowski Riemann Ricci Weyl Noether Cartan Euler Gauss Bayesian Markov martingale ergodicity entropy enthalpy fugacity viscosity vorticity turbulence advection diffusion convection tensor manifold geodesic topology homology cohomology isomorphism morphism functor monad adjunction category sheaf topos hyperplane polytope simplex tessellation fractal bifurcation attractor chaos asymptote perturbation renormalization decoherence superposition entanglement tunneling diffraction refraction polarization birefringence spectroscopy interferometry tomography crystallography lithography nanofabrication superconductivity ferromagnetism antiferromagnetism diamagnetism paramagnetism piezoelectricity thermoelectricity electrochemistry photocatalysis stoichiometry chirality stereochemistry crystallite perovskite graphene fullerene nanotube polymer oligomer monomer dendrimer amphiphile micelle vesicle liposome ribosome proteome transcriptome metabolome epigenome phylogeny cladistics ontology phenomenology epistemology hermeneutics syllogism teleology dialectic`;
let currentPage; let modelOffline = false;
const monitor = setInterval(() => {
  if (currentPage && !currentPage.isClosed()) void currentPage.locator('#ask-voice-models').textContent().then(models => console.log(JSON.stringify({ models }))).catch(() => {});
}, 15000);
async function openPage(noGpu = false) {
  const context = await browser.newContext({ viewport: { width: 440, height: 806 } });
  const store = new Map();
  await context.exposeFunction('__storage', ({ method, data }) => method === 'getLocalStorage' ? store.get(data.key) || '' : (store.set(data.key, data.value), true));
  await context.addInitScript(({ noGpu }) => {
    const Original = Worker; window.__speechWorkers = []; window.__modelResults = []; window.__modelCalls = []; window.__modelErrors = []; window.__modelProgress = [];
    window.Worker = class extends Original {
      constructor(url, options) {
        const speech = String(url).includes('speech-worker');
        super(url, options); this.speech = speech;
        if (speech) {
          window.__speechWorkers.push(this);
          this.addEventListener('message', ({ data }) => { if (data.result) window.__modelResults.push(data.result); if (data.error) window.__modelErrors.push(data.error); if (data.progress) window.__modelProgress.push(data.progress); });
        }
      }
      postMessage(data, ...rest) {
        if (this.speech) window.__modelCalls.push({ id: data.id, model: data.model, backend: data.backend, operation: data.operation, vocabulary: data.vocabulary });
        return super.postMessage(data, ...rest);
      }
      terminate() { this.terminated = true; if (this.wrapper) URL.revokeObjectURL(this.wrapper); return super.terminate(); }
    };
    window.flutter_inappwebview = { async callHandler(_, payload) {
      const message = JSON.parse(payload);
      if (message.method.endsWith('LocalStorage')) return window.__storage(message);
      return ['createStartUpPageContainer', 'updateImageRawData'].includes(message.method) ? 0 : true;
    } };
  }, { noGpu });
  const page = currentPage = await context.newPage(); page.on('pageerror', error => result.errors.push(error.message));
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.protocol === 'https:' && !result.modelResponseOrigins.includes(url.origin)) result.modelResponseOrigins.push(url.origin);
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (noGpu && url.pathname.includes('speech-worker') && url.pathname.endsWith('.js')) {
      const response = await route.fetch(); return route.fulfill({ response, body: "Object.defineProperty(navigator, 'gpu', {value:undefined});\n" + await response.text() });
    }
    if (cpuValidation && url.pathname.includes('speech-worker') && url.pathname.endsWith('.js')) {
      const response = await route.fetch();
      return route.fulfill({ response, body: await response.text() + '\nconst dispatch = self.onmessage; self.onmessage = event => { if (event.data.model === "refine") event.data.backend = "wasm"; dispatch(event); };' });
    }
    if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
    if (speechDownloadOrigins.includes(url.origin)) {
      if (noGpu) throw new Error('A device without WebGPU must not download corrections');
      result.modelRequests.push({ origin: url.origin, offline: modelOffline });
      return modelOffline ? route.abort() : route.continue();
    }
    throw new Error(`Unexpected network request: ${url.origin}`);
  });
  await page.goto(origin); await expect(page.locator('#import')).toBeEnabled();
  await showSettings(page); await page.locator('#speech-vocabulary').fill('Kantorowicz, JEV, Americans');
  await page.locator('#speech-vocabulary').blur(); await hideSettings(page);
  await page.locator('#file-picker').setInputFiles(['a', 'b'].map(name => ({ name: `${name}.md`, mimeType: 'text/markdown', buffer: Buffer.from('# Voice\n\n' + (name === 'b' ? technicalPassage : 'A paper for local dictation.')) })));
  await showLibrary(page); await page.locator('[data-document-id="a.md"] .document-card').click();
  assert.equal(await page.evaluate(() => window.__speechWorkers.length), 0, 'Reading alone does not load speech models');
  await page.locator('#ask-open').click();
  await expect.poll(() => page.evaluate(() => window.__speechWorkers.length)).toBe(2);
  return { page, context };
}
const wave = await readFile('test-results/speech/jfk.wav');
async function dictate(page, live = false) {
  await page.locator('#ask-voice').click(); await expect(page.locator('#ask-status')).toContainText('Listening');
  const send = bytes => page.evaluate(encoded => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { audioEvent: { audioPcm: Uint8Array.from(atob(encoded), char => char.charCodeAt(0)), source: 'glasses' } } })), bytes.toString('base64'));
  if (live) {
    await send(wave.subarray(44, 44 + 4 * 32000));
    await expect(page.locator('#ask-question')).not.toHaveValue('', { timeout: 30000 });
    await expect(page.locator('#ask-status')).toContainText('Listening');
    assert(await page.locator('#ask-question').evaluate(input => input.readOnly));
    const first = await page.locator('#ask-question').inputValue();
    await send(wave.subarray(44 + 4 * 32000));
    await expect(page.locator('#ask-question')).not.toHaveValue(first, { timeout: 30000 });
    result.livePartialBeforeRelease = true;
  } else await send(wave.subarray(44));
  await page.locator('#ask-voice').click(); await expect(page.locator('#ask-review-cancel')).toBeVisible({ timeout: 120000 });
  await expect(page.locator('#ask-question')).toHaveValue(/country/i);
}
try {
  const { page, context } = await openPage();
  await expect(page.locator('#ask-voice-models')).toContainText('CPU draft: ready', { timeout: 60000 });
  result.cpuReadyWhileDownloading = (await page.locator('#ask-voice-models').textContent()).includes('Downloading');
  await expect(page.locator('#ask-voice-models')).toHaveText('CPU draft: ready · GPU corrections: ready', { timeout: 600000 });
  const prepared = await page.evaluate(() => window.__modelResults);
  assert.equal(prepared.length, 2); assert(prepared.some(row => row.backend === 'wasm'));
  assert(prepared.some(row => cpuValidation ? row.backend === 'wasm' && row.model === 'Whisper Small English' : row.backend === 'webgpu' && row.adapter.vendor === 'nvidia' && !row.adapter.fallback));
  result.preloaded = prepared;
  assert(result.modelResponseOrigins.every(value => speechDownloadOrigins.includes(value)), 'Every model redirect fits the package network permissions');
  assert.equal(prepared.find(row => row.download)?.download.downloadedBytes, speechDownloads.reduce((sum, row) => sum + row.bytes, 0));
  assert((await page.evaluate(() => window.__modelProgress)).some(text => text.includes('Downloading corrections')));
  assert(result.cpuReadyWhileDownloading, 'CPU is ready while correction weights are still downloading');
  const cdp = await browser.newBrowserCDPSession();
  let pssKb = 0;
  for (const process of (await cdp.send('SystemInfo.getProcessInfo')).processInfo) {
    try { const value = await readFile(`/proc/${process.id}/smaps_rollup`, 'utf8'); pssKb += Number(value.match(/^Pss:\s+(\d+)/m)?.[1] || 0); } catch {}
  }
  result.browserPssAfterPreloadMiB = pssKb / 1024;
  await dictate(page, true); await expect(page.locator('#ask-status')).toHaveText(/Transcription (updated|checked)/, { timeout: 120000 });
  await expect(page.locator('#ask-voice-metrics')).toContainText(cpuValidation ? 'WebAssembly SIMD' : 'WebGPU');
  await expect(page.locator('#ask-question-colors .speech-uncertain').first()).toBeVisible();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path.join(out, 'confidence-dark.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' }); await page.screenshot({ path: path.join(out, 'confidence-light.png'), fullPage: true });
  await page.locator('#ask-question').fill('My edited question'); await expect(page.locator('#ask-question-colors')).toBeHidden();
  await page.locator('#ask-review-cancel').click(); await backToReading(page);
  // Switch papers and pass the previous idle timeout without unloading models.
  await showLibrary(page); await page.locator('[data-document-id="b.md"] .document-card').click();
  await page.evaluate(() => window.__tickShadowTimers?.(70000));
  assert.equal(await page.evaluate(() => window.__speechWorkers.filter(worker => worker.terminated).length), 0);
  await page.locator('#ask-open').click(); await dictate(page);
  await expect(page.locator('#ask-status')).toHaveText(/Transcription (updated|checked)/, { timeout: 120000 });
  const calls = await page.evaluate(() => window.__modelCalls);
  assert.equal(calls.filter(call => call.operation === 'prepare').length, 2);
  const runs = await page.evaluate(() => window.__modelResults.filter(row => row.text && !row.partial));
  assert.equal(runs.length, 4); assert(runs.every(row => row.reused && row.loadMs === 0));
  assert(runs.every(row => row.words.length && row.words.every(word => word.end <= row.text.length)));
  assert(runs.every(row => row.vocabularyTerms >= 3));
  const expanded = runs.slice(-2);
  assert(expanded[0].vocabularyTerms > 64, 'Tiny receives all eligible terms, beyond both old caps');
  assert(expanded[1].vocabularyTokens > 128 && expanded[1].vocabularyTokens <= 223, 'Whisper fills its expanded context allowance');
  assert(expanded[1].vocabularyTerms < expanded[1].vocabularyCandidates, 'Report actual applied terms after token packing');
  for (const row of expanded) {
    const recognized = row.text.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/);
    assert(recognized.length >= 20 && recognized.length <= 28, 'Large vocabulary does not echo into or truncate the 23-word recording');
    assert.match(row.text, /fellow Americans.*ask not.*country.*ask what.*country/i);
  }
  result.fullVocabularyBudget = expanded.map(({ vocabularyTerms, vocabularyTokens, vocabularyCandidates }) => ({ vocabularyTerms, vocabularyTokens, vocabularyCandidates }));
  assert(runs.every(row => !/Kantorowicz|JEV/.test(row.text)), 'Vocabulary prompts are not copied into the transcript');
  result.vocabularyAppliedWithoutPrefixEcho = true;
  result.partialRuns = await page.evaluate(() => window.__modelResults.filter(row => row.partial).map(({ text, words, ...metrics }) => ({ ...metrics, characters: text.length })));
  result.runs = runs.map(({ text, words, ...metrics }) => ({ ...metrics, scoredWords: words.length }));
  result.reusedAcrossDocuments = true; result.noIdleUnload = true; result.confidenceWords = true;
  await page.locator('#ask-review-cancel').click(); await backToReading(page);
  await showSettings(page); await page.locator('#speech-vocabulary').fill('Quilter'); await page.locator('#speech-vocabulary').blur();
  await page.locator('#speech-context-vocabulary').uncheck(); await hideSettings(page);
  await page.locator('#ask-open').click(); await page.locator('#ask-voice').click();
  await expect(page.locator('#ask-status')).toContainText('Listening');
  const rare = await readFile('test-results/speech/1272-128104-0000.wav');
  // Normalize the fixture using the existing browser decoder, not an assumed
  // fixed WAV header or sample rate.
  const encoded = await page.evaluate(async data => {
    const context = new AudioContext();
    const audio = await context.decodeAudioData(Uint8Array.from(atob(data), c => c.charCodeAt(0)).buffer); await context.close();
    const offline = new OfflineAudioContext(1, Math.ceil(audio.duration * 16000), 16000);
    const source = offline.createBufferSource(); source.buffer = audio; source.connect(offline.destination); source.start();
    const values = (await offline.startRendering()).getChannelData(0), bytes = new Uint8Array(values.length * 2), view = new DataView(bytes.buffer);
    for (let i = 0; i < values.length; i++) view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, values[i])) * 32767), true);
    return Array.from(bytes);
  }, rare.toString('base64'));
  await page.evaluate(bytes => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { audioEvent: { audioPcm: new Uint8Array(bytes), source: 'glasses' } } })), encoded);
  await page.locator('#ask-voice').click();
  await expect(page.locator('#ask-status')).toHaveText(/Transcription (updated|checked)/, { timeout: 120000 });
  await expect(page.locator('#ask-question')).toHaveValue(/Quilter/i);
  result.rareName = await page.evaluate(() => window.__modelResults.filter(row => row.text && !row.partial).slice(-2).map(({ text, vocabularyTerms, backend }) => ({ text, vocabularyTerms, backend })));
  assert(result.rareName.every(row => row.vocabularyTerms === 1), 'Context vocabulary can be disabled independently');
  const preferences = await page.evaluate(() => JSON.parse(localStorage.getItem('even-reader:preferences:v1')));
  assert.equal(preferences.speechVocabulary, 'Quilter'); assert.equal(preferences.speechContextVocabulary, false);
  result.sharedVocabularyPreferences = true;
  const logs = await page.evaluate(() => localStorage.getItem('even-reader:diagnostics:v1') || '');
  assert(!logs.includes('fellow Americans') && !logs.includes('"words"'), 'No transcription text/token scores in diagnostics');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  assert.equal(await page.evaluate(() => window.__speechWorkers.filter(worker => worker.terminated).length), 2);
  result.releasedAtExit = true;
  modelOffline = true; const requestsBeforeReload = result.modelRequests.length;
  await page.reload(); await expect(page.locator('#import')).toBeEnabled(); await page.locator('#ask-open').click();
  await expect(page.locator('#ask-voice-models')).toHaveText('CPU draft: ready · GPU corrections: ready', { timeout: 180000 });
  const warm = await page.evaluate(() => window.__modelResults.find(row => row.download)?.download);
  assert.equal(warm.downloadedBytes, 0); assert(warm.cachedBytes >= speechDownloads.reduce((sum, row) => sum + row.bytes, 0));
  assert.equal(result.modelRequests.length, requestsBeforeReload, 'Reload uses cached weights with the model host offline');
  result.offlineReload = warm; await context.close();

  const missing = await openPage(true);
  await expect(missing.page.locator('#ask-voice-models')).toContainText('WebGPU is unavailable', { timeout: 60000 });
  await expect(missing.page.locator('#ask-voice-models')).toContainText('CPU draft: ready', { timeout: 60000 });
  await dictate(missing.page); await expect(missing.page.locator('#ask-status')).toContainText('Kept first transcription');
  await expect(missing.page.locator('#ask-question')).toHaveValue(/country/i);
  assert.equal(await missing.page.evaluate(() => window.__modelCalls.filter(call => call.backend === 'webgpu').length), 1);
  result.missingGpuKeepsCpuDraft = true; await missing.context.close();
  assert.deepEqual(result.errors, []); result.passed = true;
} catch (error) {
  result.error = error.stack;
  if (currentPage && !currentPage.isClosed()) {
    result.state = await currentPage.evaluate(() => ({ models: document.querySelector('#ask-voice-models')?.textContent, status: document.querySelector('#ask-status')?.textContent, errors: window.__modelErrors, calls: window.__modelCalls }));
    await currentPage.screenshot({ path: path.join(out, 'failure.png'), fullPage: true });
  }
  throw error;
}
finally { clearInterval(monitor); await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2)); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
console.log(JSON.stringify(result, null, 2));
