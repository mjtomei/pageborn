// Real AskUI/session and native SDK containers; model setup is stubbed.
// Check native text restoration, phone confidence and conditional swipe help.
import { chromium, webkit, expect } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { displayProbe } from './display-probe.mjs';
import { showLibrary, chooseMode } from './ui-helpers.mjs';

const out = 'test-results/transcription-display'; await mkdir(out, { recursive: true });
const vite = await createServer({ plugins: [displayProbe()], cacheDir: '.state/vite-transcription-display',
  server: { host: '127.0.0.1', port: 0, watch: { usePolling: true } }, clearScreen: false });
await vite.listen();
const reports = [];
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true, executablePath: engine === chromium ? '/usr/bin/google-chrome' : process.env.WEBKIT_PATH });
    const report = { engine: engine.name(), passed: false, physicalGlasses: false, errors: [] }; reports.push(report);
    let page;
    try {
      page = await browser.newPage({ viewport: { width: 440, height: 806 } });
      page.on('pageerror', error => report.errors.push(error.message));
      const storage = new Map();
      await page.exposeFunction('__storage', ({ method, data }) => {
        if (method === 'getLocalStorage' && /^pageborne:models:v1:[a-f0-9]{64}$/.test(data.key)) return JSON.stringify({ id: 'fixture', chunks: 1, headers: {} });
        if (method === 'getLocalStorage') return storage.get(data.key) || '';
        storage.set(data.key, data.value); return true;
      });
      await page.addInitScript(() => {
        const NativeWorker = Worker;
        window.Worker = class {
          constructor(url, options) { if (!String(url).includes('ensemble-worker')) return new NativeWorker(url, options); }
          postMessage(data) { if (data.operation === 'prepare') queueMicrotask(() => this.onmessage({ data: { id: data.id, result: { backend: 'wasm', verified: true } } })); }
          terminate() {}
        };
        window.__images = 0; window.__boxes = {}; window.__maxTextContainers = 0;
        window.flutter_inappwebview = { async callHandler(_, payload) {
          const m = JSON.parse(payload);
          if (m.method.endsWith('LocalStorage')) return window.__storage(m);
          if (m.method === 'updateImageRawData') window.__images++;
          if (['createStartUpPageContainer', 'rebuildPageContainer'].includes(m.method)) {
            window.__maxTextContainers = Math.max(window.__maxTextContainers, m.data.textObject?.length || 0);
            if (window.__maxTextContainers > 8 || m.data.containerTotalNum > 12) throw new Error('Native container budget exceeded');
            window.__boxes = Object.fromEntries((m.data.textObject || []).map(box => [box.containerName, box]));
          }
          if (m.method === 'textContainerUpgrade') window.__boxes[m.data.containerName] = { ...window.__boxes[m.data.containerName], ...m.data };
          return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
        } };
      });
      await page.goto(vite.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled({ timeout: 30000 });
      await page.locator('#file-picker').setInputFiles({ name: 'display.md', mimeType: 'text/markdown', buffer: Buffer.from('# Reading\n\n' + 'A passage to preserve above the listening panel. '.repeat(60)) });
      await showLibrary(page); await page.locator('[data-document-id="display.md"] .document-card').click();
      await expect.poll(() => page.evaluate(() => window.__boxes.status?.content)).toMatch(/ +pg\. 1$/);
      assert.equal(await page.evaluate(() => window.__boxes.status.textColor), 4);
      assert.equal(await page.evaluate(() => window.__boxes.commands.textColor), 1);
      assert.match(await page.evaluate(() => window.__boxes.commands.content), /Tap: Ask$/);
      await page.locator('#preview').screenshot({ path: `${out}/${engine.name()}-centered-page.png` });
      for (const mode of ['auto', 'speed']) {
        await chooseMode(page, mode);
        await page.locator('#position').evaluate(el => { el.value = '100'; el.dispatchEvent(new Event('input')); });
        for (const playing of [false, true, false]) {
          if ((await page.locator('#play').getAttribute('aria-pressed') === 'true') !== playing) await page.evaluate(() => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { sysEvent: { eventType: 0 } } })));
          await expect.poll(() => page.evaluate(() => window.__boxes.status?.content)).toMatch(playing ? /▶ .*?(~\d+[mh]|<1m) +pg\. \d+$/ : /Ⅱ .*?(~\d+[mh]|<1m) +pg\. \d+$/);
          assert.doesNotMatch(await page.evaluate(() => window.__boxes.status.content), /Speed|Auto|Paused|…/);
          await page.locator('#preview').screenshot({ path: `${out}/${engine.name()}-${mode}-${playing ? 'playing' : 'paused'}.png` });
        }
      }
      await chooseMode(page, 'page');
      report.playbackSymbolsAndCompactTime = true;
      // Real stream/voting/UI callbacks with controlled recognizer hypotheses:
      // two models choose "book", while Moonshine supplies the question mark.
      await page.evaluate(() => {
        const ui = window.__askUI; ui.open({ showConversation: true }); ui.glassesVisible = ui.phoneVisible = true;
        ui.session.setStatus('listening');
        ui.stream.models.transcribe = async id => {
          const text = id === 'moonshine' ? 'Did you read the look?' : 'did you read the book';
          return { text, words: [...text.matchAll(/\w+/g)].map(m => ({ text: m[0], start: m.index, end: m.index + m[0].length, confidence: .95 })) };
        };
        ui.stream.start();
        const pcm = new Int16Array(16000).fill(2000); ui.stream.receive(new Uint8Array(pcm.buffer));
      });
      await expect(page.locator('#ask-question')).toHaveValue('Did you read the book?');
      await expect.poll(() => page.evaluate(() => window.__displayDialog?.text)).toBe('Did you read the book?');
      const recognized = await page.evaluate(async () => {
        const ui = window.__askUI, stream = ui.stream.streams.values().next().value;
        ui.reviewSpeech(document.querySelector('#ask-question').value, ui.draftConfidence, true);
        const result = await ui.stream.finish({ kind: 'pcm-stream', bytes: stream.length, checksum: stream.checksum });
        ui.reviewSpeech(result.text, result); return result;
      });
      assert.equal(recognized.text, 'Did you read the book?');
      assert(recognized.words.every(w => recognized.text.slice(w.start, w.end) === w.text));
      await expect.poll(() => page.evaluate(() => window.__displayDialog?.text)).toBe(recognized.text);
      await page.locator('#ask-review-cancel').click();
      report.detectedPunctuationInLiveAndFinalReview = true;
      await page.evaluate(() => {
        const ui = window.__askUI; ui.open({ showConversation: true }); ui.glassesVisible = ui.phoneVisible = true;
        ui.session.setStatus('listening');
      });
      await expect.poll(() => page.evaluate(() => window.__displayDialog?.hint)).toBe('Tap: accept · Double tap: cancel');
      const text = 'A spoken question with spoken words';
      const words = [{ start: 2, end: 8, confidence: .99 }, { start: 23, end: 29, confidence: .3 }];
      await page.evaluate(({ text, words }) => {
        const ui = window.__askUI; ui.draftConfidence = { text, words }; document.querySelector('#ask-question').value = text;
        ui.session.updateTranscription(text, words);
      }, { text, words });
      await expect.poll(() => page.evaluate(() => window.__displayDialog?.text)).toBe(text);
      const dimWords = () => page.evaluate(() => Object.values(window.__boxes).filter(box => /^review-(text|run-\d+)$/.test(box.containerName) && box.textColor === 1).map(box => box.content));
      await expect.poll(dimWords).toEqual(['spoken']);
      await expect(page.locator('#ask-question-colors .speech-uncertain')).toHaveText('spoken');
      await page.locator('#preview').screenshot({ path: `${out}/${engine.name()}-live-confidence.png` });
      assert.equal(await page.evaluate(() => window.__images), 0, 'listening uses the glasses native text, with no image transfers');
      await page.evaluate(text => {
        const ui = window.__askUI; const words = [{ start: 23, end: 29, confidence: .8 }];
        ui.draftConfidence = { text, words }; ui.session.updateTranscription(text, words);
      }, text);
      await expect(page.locator('#ask-question-colors')).toBeHidden();
      await expect.poll(dimWords).toEqual([]);
      await expect.poll(() => page.evaluate(() => window.__boxes['review-text']?.content)).toBe(text);
      assert.equal(await page.evaluate(() => Object.keys(window.__boxes).some(name => name.startsWith('review-run-'))), false, 'removed highlights leave no stale containers');
      assert.equal(await page.evaluate(() => window.__images), 0);
      await page.evaluate(({ text, words }) => window.__askUI.reviewSpeech(text, { words }, true), { text, words });
      await expect.poll(() => page.evaluate(() => window.__boxes.status?.content)).toMatch(/^Refining\.+$/);
      const refiningGeometry = await page.evaluate(() => ({ status: window.__boxes.status, hint: window.__boxes['review-hint'], panel: window.__boxes['review-panel'] }));
      assert.equal(refiningGeometry.status.xPosition, 24);
      assert.equal(refiningGeometry.status.yPosition, refiningGeometry.hint.yPosition);
      assert(refiningGeometry.status.xPosition + refiningGeometry.status.width < refiningGeometry.hint.xPosition);
      await page.locator('#preview').screenshot({ path: `${out}/${engine.name()}-refining-footer.png` });
      await page.evaluate(({ text, words }) => window.__askUI.reviewSpeech(text, { words }, false), { text, words });
      await expect.poll(() => page.evaluate(() => window.__boxes.status?.content.trim())).toBe('');
      assert.equal(await page.evaluate(() => window.__boxes['review-panel'].height), refiningGeometry.panel.height);
      await expect.poll(() => page.evaluate(() => window.__displayDialog?.text)).toBe(text);
      await expect.poll(dimWords).toEqual(['spoken']);
      await page.locator('#ask-question').fill('An edited question');
      await expect.poll(() => page.evaluate(() => window.__displayDialog?.text)).toBe('An edited question');
      await expect(page.locator('#ask-question-colors')).toBeHidden();
      await expect.poll(dimWords).toEqual([]);
      const crowded = 'one x two x three x four x';
      await page.evaluate(text => {
        const words = [...text.matchAll(/one|two|three|four/g)].map(m => ({ start: m.index, end: m.index + m[0].length, confidence: .4 }));
        window.__askUI.reviewSpeech(text, { words });
      }, crowded);
      await expect.poll(() => page.evaluate(() => window.__displayDialog?.text)).toBe(crowded);
      await expect.poll(dimWords).toEqual(['four']);
      await expect(page.locator('#ask-question-colors .speech-uncertain')).toHaveCount(4);
      await page.locator('#preview').screenshot({ path: `${out}/${engine.name()}-latest-uncertainty.png` });
      report.nativeLatestUncertainty = true; report.confidenceCutoff = .7;
      await page.evaluate(() => window.__askUI.reviewSpeech('A longer question with several panes. '.repeat(12), { words: [] }, true));
      await expect.poll(() => page.evaluate(() => window.__displayDialog?.hint)).toMatch(/^Swipe:/);
      const first = await page.evaluate(() => window.__displayDialog.text);
      await page.evaluate(() => window.__askUI.session.move(1));
      await expect.poll(() => page.evaluate(() => window.__displayDialog?.text)).not.toBe(first);
      await page.locator('#preview').screenshot({ path: `${out}/${engine.name()}-paged-review.png` });
      const pagedFooter = await page.evaluate(() => ({ status: window.__boxes.status, hint: window.__boxes['review-hint'] }));
      assert.match(pagedFooter.status.content, /^Refining\.+$/);
      assert.equal(pagedFooter.status.textColor, 4);
      assert.equal(pagedFooter.status.yPosition, pagedFooter.hint.yPosition);
      assert.match(pagedFooter.hint.content.trim(), /^Swipe:/);
      await page.evaluate(() => window.__askUI.reviewSpeech(window.__askUI.session.review.text, { words: [] }, false));
      await page.locator('#ask-review-cancel').click();
      await expect.poll(() => page.evaluate(() => window.__displayDialog)).toBe(null);
      assert.equal(await page.evaluate(() => window.__images), 0, 'review and paging also stay native');
      assert.equal(await page.evaluate(() => window.__boxes['review-text']), undefined, 'return restores the conversation containers');
      assert.deepEqual(report.errors, []);
      Object.assign(report, { passed: true, phoneConfidence: true, nativeTextOnly: true, conditionalSwipe: true, editingClearsConfidence: true, pageCentered: true, refinementInFooter: true, refinementDoesNotAddRow: true });
    } catch (error) { report.error = error.stack; report.state = await page?.evaluate(() => ({ active: window.__askUI?.session.active, status: window.__askUI?.session.status, blocked: window.__askUI?.speech.setup.blocked, dialog: window.__askUI?.session.dialog(), accepted: window.__displayDialog, display: window.__glasses && { ready: window.__glasses.ready, suspended: window.__glasses.suspended, active: window.__glasses.diagnostics.active, last: window.__glasses.lastFrame?.dialog, accepted: window.__glasses.acceptedFrame?.dialog }, connection: document.querySelector('#connection-state')?.title, body: document.body.innerText.slice(-1200) })); await page?.screenshot({ path: `${out}/${engine.name()}-failure.png` }); throw error; }
    finally { await browser.close(); }
  }
} finally { await writeFile(`${out}/results.json`, JSON.stringify(reports, null, 2)); await vite.close(); }
console.log(JSON.stringify(reports));
