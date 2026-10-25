// Real Ask/ensemble/voting/display wiring, controlled recognizers and PCM.
// Actual recognition is checked separately in Browser STT's filename diagnostic.
import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { displayProbe } from './display-probe.mjs';
import { showLibrary } from './ui-helpers.mjs';

process.env.PAGEBORNE_ASK_ORIGINS = 'https://filenames.test';
const server = await createServer({ mode: 'debug', plugins: [displayProbe(), {
  name: 'filename-model-setup', transform(code, id) {
    if (id.endsWith('/src/speech-setup.js')) return code.replace('start(initialize) {', 'start(initialize) { this.blocked = false; return Promise.resolve();');
  },
}], cacheDir: '.state/vite-filenames', server: { host: '127.0.0.1', port: 0, watch: null }, clearScreen: false });
await server.listen();
const reports = []; await mkdir('test-results/speech-filenames', { recursive: true });
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ executablePath: engine === chromium ? '/usr/bin/google-chrome' : process.env.WEBKIT_PATH, headless: true });
    try { for (const source of ['glasses', 'phone']) {
      const page = await browser.newPage({ viewport: { width: 440, height: 806 } }); const errors = [], storage = new Map();
      page.on('pageerror', e => errors.push(e.message));
      await page.exposeFunction('__storage', ({ method, data }) => method === 'getLocalStorage' ? storage.get(data.key) || '' : (storage.set(data.key, data.value), true));
      await page.addInitScript(() => {
        localStorage.setItem('even-reader:preferences:v1', JSON.stringify({ ask: { mode: 'terminal', endpoint: 'https://filenames.test', token: 'fixture', agent: 'codex' } }));
        window.flutter_inappwebview = { async callHandler(_, payload) {
          const m = JSON.parse(payload);
          if (m.method.endsWith('LocalStorage')) return window.__storage(m);
          return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
        } };
      });
      await page.route('https://filenames.test/**', route => route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
        json: route.request().url().endsWith('/info') ? { provider: 'codex' } : { messages: [], sessions: [], history: [], state: 'idle' } }));
      await page.goto(server.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled();
      await page.locator('#file-picker').setInputFiles({ name: 'document.md', mimeType: 'text/markdown', buffer: Buffer.from('# Document\n\nA document for discussion. '.repeat(80)) });
      await showLibrary(page); await page.locator('[data-document-id="document.md"] .document-card').click();
      await page.locator('#ask-open').click();
      await page.evaluate(async () => {
        const ask = window.__askUI;
        const id = ask.chat.begin(ask.paperKey, 'Which file?', ask.session.context);
        ask.chat.update(ask.paperKey, id, 'Edit `speech_ui.js`, `README.md`, `todo.txt` and `AGENTS.md`. ' + 'More discussion. '.repeat(1000), 'pending');
        window.__hintCalls = []; window.__mockSpeech = 'Please edit speech underscore you eye dot jay ess.';
        ask.speech.models.open = async () => [];
        ask.speech.models.prepare = async id => { Object.assign(ask.speech.models.entries[id], { verified: true, state: 'ready' }); return { backend: 'wasm' }; };
        ask.speech.models.transcribe = async (id, _audio, options) => {
          window.__hintCalls.push({ id, terms: [...options.vocabulary] });
          const text = typeof window.__mockSpeech === 'string' ? window.__mockSpeech : window.__mockSpeech[id];
          const words = [...text.matchAll(/\w+/g)].map(m => ({ text: m[0], start: m.index, end: m.index + m[0].length, confidence: m[0] === 'speech' ? .4 : .95 }));
          return { text, words, backend: 'wasm', seconds: 1, transcribeMs: 1, partial: false };
        };
        const { pcmChecksum } = await import('/node_modules/@pageborne/browser-stt/src/pcm-microphone.js');
        window.__pcm = new Uint8Array(16000);
        for (const mic of [ask.mic, ask.phoneMic]) {
          mic.start = async () => { mic.capturing = true; };
          mic.stop = async () => { mic.capturing = false; return { kind: 'pcm-stream', bytes: __pcm.length, checksum: pcmChecksum(__pcm) }; };
        }
      });
      const record = async expected => {
        await page.evaluate(source => window.__askUI.hold(source), source);
        await expect(page.locator('#ask-status')).toContainText('Listening');
        await expect.poll(() => page.evaluate(() => window.__askUI.dictationVocabulary.length)).toBeGreaterThan(0);
        await page.evaluate(() => window.__askUI.stream.receive(window.__pcm));
        await expect(page.locator('#ask-question')).toHaveValue(expected);
        await page.evaluate(() => window.__askUI.release());
        await expect(page.locator('#ask-review-cancel')).toBeVisible();
        await expect(page.locator('#ask-question')).toHaveValue(expected);
        assert(await page.evaluate(() => { const r = window.__askUI.draftConfidence; return r.words.every(w => r.text.slice(w.start, w.end) === w.text); }));
      };
      await record('Please edit speech_ui.js.');
      assert(await page.evaluate(() => window.__hintCalls.every(c => c.terms.includes('speech ui dot j s') && c.terms.includes('read me dot m d'))));
      await expect(page.locator('#ask-question-colors .speech-uncertain')).toHaveText('speech_ui.js');
      await page.locator('#ask-review-cancel').click();
      await page.evaluate(() => { window.__mockSpeech = 'Please read read me dot em dee.'; });
      await record('Please read README.md.');
      await page.locator('#ask-review-cancel').click();
      await page.evaluate(() => { window.__mockSpeech = {
        conformer: 'open to do dot t x t and agents dot m d',
        zipformer: 'OPEN TODO DOT TXT AND AGENTS DOT MD',
        moonshine: 'Open todo.txt and agents.md.',
      }; });
      await record('Open todo.txt and AGENTS.md.');
      await page.locator('#ask-review-cancel').click();
      await page.evaluate(() => { window.__mockSpeech = 'Please open report dot pee dee eff.'; });
      await record('Please open report.pdf.');
      await page.locator('#ask-question').fill('My typed filename.md stays unchanged');
      await expect(page.locator('#ask-question')).toHaveValue('My typed filename.md stays unchanged');
      assert.deepEqual(errors, []);
      reports.push({ engine: engine.name(), source, passed: true, mockedRecognizers: true, partialAndFinal: true, offsetsAndUncertainty: true });
      await page.close();
    } } finally { await browser.close(); }
  }
} finally { await server.close(); await writeFile('test-results/speech-filenames/results.json', JSON.stringify(reports, null, 2)); }
console.log(JSON.stringify(reports));
