// End-to-end visibility and notification regression with real SDK dispatch,
// deterministic speech and Terminal fixtures. No physical BLE/STT timing claims.
import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { showLibrary, showSettings, hideSettings } from './ui-helpers.mjs';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';

process.env.PAGEBORNE_ASK_ORIGINS = 'https://reading-flow.test';
const out = 'test-results/ask-reading'; await mkdir(out, { recursive: true });
const vite = await createServer({ cacheDir: '.state/vite-ask-reading', server: { host: '127.0.0.1', port: 0 }, clearScreen: false }); await vite.listen();
const results = [];
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch(engine === chromium ? { executablePath: '/usr/bin/google-chrome', headless: true }
      : { headless: true, ...(process.env.WEBKIT_PATH ? { executablePath: process.env.WEBKIT_PATH } : {}) });
    const result = { engine: engine.name(), passed: false, errors: [], physicalGlasses: false }; results.push(result);
    let page;
    try {
      page = await browser.newPage({ viewport: { width: 440, height: 806 } }); page.on('pageerror', e => result.errors.push(e.message));
      const storage = new Map(), prompts = [], messages = []; let state = 'idle';
      await page.exposeFunction('__storage', ({ method, data }) => method === 'getLocalStorage' ? storage.get(data.key) || '' : (storage.set(data.key, data.value), true));
      await page.addInitScript(() => {
        if (!localStorage.getItem('even-reader:preferences:v1')) localStorage.setItem('even-reader:preferences:v1', JSON.stringify({ speechRefinement: false, pdfDefaults: { reflow: false }, ask: { mode: 'terminal', endpoint: 'https://reading-flow.test', token: 'fixture', agent: 'codex' } }));
        const NativeWorker = Worker;
        window.__prepareWaiters = []; window.__holdPrepare = true;
        window.Worker = class {
          constructor(url, options) { if (!String(url).includes('speech-worker')) return new NativeWorker(url, options); }
          postMessage(data) {
            if (data.operation === 'prepare') {
              const ready = () => this.onmessage?.({ data: { id: data.id, result: { backend: data.backend, model: data.model } } });
              if (window.__holdPrepare) window.__prepareWaiters.push(ready); else queueMicrotask(ready);
              return;
            }
            if (data.operation === 'cancel') return;
            if (window.__silentSpeech) { queueMicrotask(() => this.onmessage?.({ data: { id: data.id, result: { text: '', words: [], model: 'Moonshine Tiny', backend: 'wasm', seconds: .5, transcribeMs: 1, loadMs: 0 } } })); return; }
            window.__speech = this; this.id = data.id; this.partial = data.partial;
          }
          terminate() {}
        };
        window.__boxes = {}; window.__rebuilds = 0; window.__micCalls = []; window.__imageUpdates = 0;
        window.flutter_inappwebview = { async callHandler(_, payload) {
          const m = JSON.parse(payload); if (m.method.endsWith('LocalStorage')) return window.__storage(m);
          if (m.method === 'updateImageRawData') window.__imageUpdates++;
          if (m.method === 'audioControl') {
            window.__micCalls.push({ enabled: m.data.isOpen, at: performance.now(), popup: window.__boxes.status?.content });
            if (m.data.isOpen && window.__holdMic) await new Promise(resolve => { window.__releaseMic = resolve; });
          }
          if (window.__holdDisplay && ['rebuildPageContainer', 'textContainerUpgrade'].includes(m.method)) {
            window.__holdDisplay = false; await new Promise(resolve => { window.__releaseDisplay = resolve; });
          }
          if (['createStartUpPageContainer', 'rebuildPageContainer'].includes(m.method)) { window.__boxes = {}; window.__rebuilds++; }
          for (const t of (m.method === 'textContainerUpgrade' ? [m.data] : m.data?.textObject || [])) window.__boxes[t.containerName] = { ...window.__boxes[t.containerName], ...t };
          return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
        } };
      });
      await page.route('https://reading-flow.test/**', async route => {
        const req = route.request(), url = new URL(req.url());
        const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        const json = value => route.fulfill({ headers, json: value });
        if (url.pathname === '/api/info') return json({ provider: 'codex' });
        if (url.pathname === '/api/events') return route.fulfill({ headers, contentType: 'text/event-stream', body: ': connected\n\n' });
        if (url.pathname.endsWith('/history')) return json({ history: [] });
        if (url.pathname === '/api/messages') return json({ state, messages });
        if (url.pathname === '/api/prompt') { prompts.push(req.postDataJSON()); state = 'busy'; messages.push({ id: messages.length + 1, type: 'user_prompt', text: req.postDataJSON().text }); return json({ sessionId: 'reading-fixture' }); }
        throw new Error(`Unexpected route ${url.pathname}`);
      });
      const emit = (text, complete = false) => { messages.push({ id: messages.length + 1, type: complete ? 'result' : 'text_delta', text, ...(complete ? { success: true } : {}) }); if (complete) state = 'idle'; };
      const event = eventType => page.evaluate(eventType => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { sysEvent: { eventType } } })), eventType);
      const body = () => page.evaluate(() => window.__boxes.body?.content || '');
      const status = () => page.evaluate(() => window.__boxes.status?.content || '');
      const overlay = () => page.evaluate(() => window.__boxes['review-text']?.content || '');
      const tap = () => event(0);
      const openAsk = () => page.evaluate(() => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { menuItemClickEvent: { itemID: 10 } } })));
      const speech = text => page.evaluate(text => window.__speech.onmessage({ data: { id: window.__speech.id, result: { text, backend: 'wasm', words: [], seconds: 2, loadMs: 0, transcribeMs: 10 } } }), text);
      await page.goto(vite.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled({ timeout: 30000 });
      await page.locator('#file-picker').setInputFiles(['reading', 'other'].map(name => ({ name: `${name}.md`, mimeType: 'text/markdown', buffer: Buffer.from('# Reading passage\n\n' + Array.from({ length: 120 }, (_, i) => `Paragraph ${i}. Text in the paper stays available while the agent works.`).join('\n\n')) })));
      await showLibrary(page); await page.locator('[data-document-id="reading.md"] .document-card').click();
      await expect.poll(body).toMatch(/^Reading passage\n/); const reading = await body();
      await expect.poll(status).toMatch(/Tap: Ask$/);
      await page.evaluate(() => { window.__holdMic = true; window.__holdAt = performance.now(); });
      await event(9);
      await expect.poll(() => page.evaluate(() => !!window.__releaseMic)).toBe(true);
      await expect.poll(status).toContain('Starting microphone');
      assert.equal(await status(), 'Starting microphone…', 'popup is visible while microphone startup is stalled');
      const startup = await page.evaluate(() => ({ ms: window.__micCalls.at(-1).at - window.__holdAt,
        popup: window.__micCalls.at(-1).popup, modelsPending: window.__prepareWaiters.length }));
      assert.equal(startup.popup, 'Starting microphone…', 'popup reaches native bridge before the audio request');
      assert(startup.modelsPending > 0, 'capture starts without waiting for model initialization');
      result.startup = startup;
      await page.locator('#preview').screenshot({ path: `${out}/${engine.name()}-starting.png` });
      await page.evaluate(() => { window.__holdMic = false; window.__releaseMic(); });
      await expect.poll(status).toContain('Listening');
      await page.evaluate(() => { window.__holdPrepare = false; window.__prepareWaiters.splice(0).forEach(ready => ready()); });
      assert.equal(await body(), reading.split('\n').slice(0, 6).join('\n'));
      const geometry = await page.evaluate(() => ({ panel: window.__boxes['review-panel'], hint: window.__boxes['review-hint'], actions: window.__boxes['review-actions'], rebuilds: window.__rebuilds }));
      assert.equal(geometry.panel.yPosition + geometry.panel.height, 288); assert.equal(geometry.hint.textColor, 1); assert.equal(geometry.hint.yPosition, 253); assert.match(geometry.hint.content, /Tap: accept · Double tap: cancel$/); assert.equal(geometry.actions, undefined);
      assert.equal(geometry.panel.yPosition, 181, 'empty recording begins with a single text line');
      const partial = async text => {
        const oldId = await page.evaluate(() => window.__speech?.id);
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { audioEvent: { audioPcm: new Uint8Array(64000), source: 'glasses' } } })));
        await expect.poll(() => page.evaluate(old => window.__speech?.partial && window.__speech.id !== old, oldId)).toBe(true);
        await speech(text); await expect(page.locator('#ask-question')).toHaveValue(text);
      };
      await partial('A live question about this passage');
      await expect.poll(overlay).toBe('A live question about this passage');
      assert.equal(await page.evaluate(() => window.__rebuilds), geometry.rebuilds, 'same-height live updates use native text only');
      await page.locator('#preview').screenshot({ path: `${out}/${engine.name()}-live.png` });
      const longDraft = 'A live question about this passage and how it connects to the earlier argument. '.repeat(4) + 'THE LATEST WORDS';
      await partial(longDraft); await expect.poll(overlay).toMatch(/THE LATEST\s+WORDS$/);
      await expect.poll(() => page.evaluate(() => window.__boxes['review-panel'].yPosition)).toBe(127);
      assert.equal(await body(), reading.split('\n').slice(0, 4).join('\n'));
      assert.equal((await overlay()).split('\n').length, 3);
      await page.locator('#preview').screenshot({ path: `${out}/${engine.name()}-live-expanded.png` });
      const liveTail = await overlay(); await event(1); await expect.poll(overlay).not.toBe(liveTail);
      const scrolledDraft = await overlay(); assert.doesNotMatch(scrolledDraft, /LATEST\s+WORDS/);
      await partial(longDraft + ' More incoming speech.');
      await expect.poll(overlay).toBe(scrolledDraft);
      assert.equal(await body(), reading.split('\n').slice(0, 4).join('\n'));
      await event(10); await expect(page.locator('#ask-review-cancel')).toBeVisible();
      // Walk to the beginning, then read every page with one swipe per page.
      for (let i = 0; i < 10; i++) await event(1);
      await expect.poll(overlay).toMatch(/^A live question/);
      const reviewPages = await page.evaluate(async text => (await import('/src/transcription-review.js')).transcriptionReview(text).pages, longDraft + ' More incoming speech.');
      const seen = [];
      for (const expected of reviewPages) {
        await expect.poll(overlay).toBe(expected); seen.push(await overlay()); await event(2);
      }
      await expect.poll(overlay).toBe(reviewPages.at(-1));
      assert.equal(seen.join(' ').replace(/\s+/g, ' '), longDraft + ' More incoming speech.');
      await event(1); await page.waitForTimeout(200);
      await page.locator('#preview').dblclick();
      await expect.poll(() => page.evaluate(() => !!window.__boxes['review-panel'])).toBe(false);
      assert.equal(prompts.length, 0, 'double tap must cancel without leaking a single-tap accept');
      await expect.poll(body).toBe(reading);
      result.longTranscriptPagingAndLiveScrollback = result.previewDoubleTapCancels = true;
      await event(9); await expect.poll(status).toContain('Listening');
      await partial('A shorter correction'); await expect.poll(overlay).toBe('A shorter correction');
      await expect.poll(() => page.evaluate(() => window.__boxes['review-panel'].yPosition)).toBe(181);
      assert.equal(await body(), reading.split('\n').slice(0, 6).join('\n'));
      const rebuilds = await page.evaluate(() => window.__rebuilds);
      const liveId = await page.evaluate(() => window.__speech.id);
      await event(10); await expect(page.locator('#ask-review-cancel')).toBeVisible();
      await expect.poll(overlay).toBe('A shorter correction');
      assert.equal(await page.evaluate(() => window.__speech.id), liveId, 'Complete live audio is reused without a fresh CPU pass');
      result.releaseReusesDraft = true;
      await expect.poll(() => page.evaluate(() => window.__boxes['review-panel'].yPosition)).toBe(208);
      assert((await page.evaluate(() => window.__rebuilds)) > rebuilds);
      assert.equal(await page.evaluate(() => window.__boxes['review-actions']), undefined);
      assert.doesNotMatch(await status(), /\d+\/\d+|Swipe|Edit on phone|Release to/);
      result.streamingTranscriptInOverlay = true; result.transcriptSizesOverlay = true;
      await page.locator('#preview').screenshot({ path: `${out}/${engine.name()}-review.png` });
      await tap(); await expect.poll(() => prompts.length).toBe(1); await expect.poll(status).toContain('○ '); await expect.poll(body).toBe(reading);
      await event(2); await expect.poll(body).not.toBe(reading); const swiped = await body();
      await page.locator('#position').evaluate(el => { el.value = '300'; el.dispatchEvent(new Event('input')); });
      await expect.poll(body).not.toBe(swiped); const continuedReading = await body();
      emit('FIRST reply starts. ' + 'An explanation. '.repeat(4));
      await expect.poll(status, { timeout: 15000 }).toContain('◐ ');
      assert.equal(await body(), continuedReading, 'streaming output does not switch away from reading');
      await openAsk(); await expect.poll(body).toContain('FIRST reply starts');
      await tap(); await expect.poll(body).toBe(continuedReading); await expect.poll(status).toContain('◐ ');
      await page.locator('#preview').screenshot({ path: `${out}/${engine.name()}-in-progress.png` });
      emit('FIRST reply starts. Finished explanation.', true);
      await expect.poll(status, { timeout: 15000 }).toContain('● '); await expect(page.locator('#ask-footer')).toHaveAttribute('data-ready', 'true'); assert.equal(await body(), continuedReading);
      await page.locator('#preview').screenshot({ path: `${out}/${engine.name()}-unread.png` });
      await openAsk(); await expect.poll(body).toContain('FIRST reply'); await tap(); await expect.poll(body).toBe(continuedReading); await expect.poll(status).not.toContain('Unread'); await expect.poll(status).toMatch(/Tap: Ask$/);
      result.firstVoiceOverlayAndReplyStates = true;
      // Empty captures and recognized silence leave reading/chat and a typed
      // draft alone; neither posts a question nor reports a speech error.
      const postedBeforeSilence = prompts.length;
      for (const conversation of [false, true]) {
        if (conversation) { await openAsk(); await expect.poll(body).toContain('FIRST reply'); await page.locator('#ask-question').fill('An unsent typed question'); }
        const before = await body(), draft = await page.locator('#ask-question').inputValue();
        const errorCount = await page.evaluate(() => JSON.parse(localStorage.getItem('even-reader:diagnostics:v1')).counts['local-speech-error'] || 0);
        for (const sendSilence of [false, true]) {
          await page.evaluate(() => { window.__silentSpeech = true; });
          await event(9); await expect.poll(status).toContain('Listening');
          if (sendSilence) await page.evaluate(() => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { audioEvent: { audioPcm: new Uint8Array(16000), source: 'glasses' } } })));
          await event(10);
          await expect.poll(() => page.evaluate(() => !!window.__boxes['review-panel'])).toBe(false);
          await expect.poll(body).toBe(before);
          await expect(page.locator('#ask-question')).toHaveValue(draft);
          if (conversation) await expect(page.locator('#ask-panel')).toBeVisible();
          else await expect(page.locator('#ask-panel')).toBeHidden();
          await expect(page.locator('#ask-status')).not.toHaveText(/No speech|recorded|recognized/);
          assert.equal(prompts.length, postedBeforeSilence);
          assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('even-reader:diagnostics:v1')).counts['local-speech-error'] || 0), errorCount);
        }
        await page.evaluate(() => { window.__silentSpeech = false; });
        if (conversation) await tap();
      }
      result.emptyAndSilentHoldRestoresViewAndDraft = true;

      // A question started from reading stays there after the agent finishes.
      await event(9); await expect.poll(status).toContain('Listening');
      await partial('A follow-up from reading'); await event(10); await expect(page.locator('#ask-review-cancel')).toBeVisible(); await tap();
      await expect.poll(() => prompts.length).toBe(2); await expect.poll(body).toBe(continuedReading);
      emit('SECOND reply begins.');
      await expect.poll(status, { timeout: 15000 }).toContain('◐ ');
      assert.equal(await body(), continuedReading, 'follow-up text also waits for turn completion');
      emit(' Still working.');
      await expect(page.locator('#ask-answer')).toContainText('Still working', { timeout: 15000 });
      assert.equal(await body(), continuedReading, 'later chunks must not open Ask either');
      // The result may repeat the last streamed text; completion must keep the reader in place.
      const completedAnswer = await page.locator('#ask-answer').textContent();
      emit(completedAnswer, true);
      await expect.poll(status, { timeout: 15000 }).toContain('● ');
      assert.equal(await body(), continuedReading);
      await tap(); await expect.poll(body).toContain('SECOND reply');
      await expect(page.locator('#ask-send')).toBeEnabled({ timeout: 15000 });
      await expect(page.locator('#ask-reply-view')).toHaveCount(0);
      result.completedFollowupsStayOnReading = result.manualNavigationWhileBusy = true;
      // A typed question from Ask stays in Ask while thinking. Choosing to
      // return to the paper afterwards keeps it visible when the reply arrives.
      await page.locator('#ask-question').fill('Stay in Ask for this follow-up'); await page.locator('#ask-send').click();
      await expect.poll(() => prompts.length).toBe(3);
      await expect.poll(body).toContain('Stay in Ask for this follow-up');
      await expect(page.locator('#ask-panel')).toBeVisible();
      await tap();
      await expect.poll(() => prompts.length).toBe(3); await expect.poll(body).toBe(continuedReading);
      emit('THIRD partial reply.'); await expect.poll(status, { timeout: 15000 }).toContain('◐ '); assert.equal(await body(), continuedReading);
      emit('THIRD partial reply. Complete.', true); await expect.poll(status, { timeout: 15000 }).toContain('● '); assert.equal(await body(), continuedReading);
      await openAsk(); await expect.poll(body).toContain('THIRD partial reply'); await tap(); await expect.poll(body).toBe(continuedReading); await expect.poll(status).not.toContain('Unread'); await expect.poll(status).toMatch(/Tap: Ask$/);
      await tap(); await expect.poll(body).toContain('THIRD partial reply'); await tap(); await expect.poll(body).toBe(continuedReading);

      // Releasing, cancelling and sending a spoken follow-up retain the Ask
      // underlay, including when the OS menu briefly backgrounds the app.
      {
        const policy = 'manual'; await openAsk();
        const before = prompts.length;
        await expect.poll(status).toMatch(/^Ask\s+\d+\s*\/\s*\d+/);
        const latestView = await body();
        const pageNumber = Number((await status()).match(/(\d+)\s*\/\s*\d+/)?.[1]); assert(pageNumber >= 1);
        await event(1);
        // Non-overlapping pages can fit this short history on one screen.
        // Backward navigation should move only when an earlier page exists.
        if (pageNumber > 1) await expect.poll(body).not.toBe(latestView);
        else await expect.poll(body).toBe(latestView);
        const previousView = await body();
        await event(4); await event(5);
        await expect(page.locator('#ask-panel')).toBeVisible(); await expect.poll(body).toBe(previousView);
        await event(9); await expect.poll(status).toContain('Listening');
        await partial('A cancelled follow-up'); await event(10); await expect(page.locator('#ask-review-cancel')).toBeVisible();
        await expect(page.locator('#ask-panel')).toBeVisible();
        await event(3); await expect.poll(() => page.evaluate(() => !!window.__boxes['review-panel'])).toBe(false);
        await expect.poll(body).toBe(previousView); assert.equal(prompts.length, before);
        // Backgrounding during capture stops the mic but restores Ask. A late
        // hold-release notification must not change that restored screen.
        await event(9); await expect.poll(status).toContain('Listening');
        await event(4); await event(5); await event(10);
        await expect.poll(() => page.evaluate(() => window.__micCalls.at(-1)?.enabled)).toBe(false);
        await expect.poll(body).toBe(previousView); await expect(page.locator('#ask-panel')).toBeVisible();
        await event(9); await expect.poll(status).toContain('Listening');
        await partial(`Spoken follow-up in ${policy}`); await event(10); await expect(page.locator('#ask-review-cancel')).toBeVisible();
        await expect(page.locator('#ask-panel')).toBeVisible();
        await tap(); await expect.poll(() => prompts.length).toBe(before + 1);
        await expect.poll(body).toContain(`Spoken follow-up in ${policy}`);
        await expect(page.locator('#ask-panel')).toBeVisible();
        // Stay in Ask even when an already-running request survives a menu.
        await event(4); await event(5); await expect(page.locator('#ask-panel')).toBeVisible();
        emit(`ASK ${policy} streaming response.`); await expect.poll(body, { timeout: 15000 }).toContain(`ASK ${policy} streaming response`);
        emit(`ASK ${policy} response complete.`, true); await expect(page.locator('#ask-send')).toBeEnabled({ timeout: 15000 });
        await expect.poll(body).toContain(`ASK ${policy} response complete`);
        assert.equal(prompts.length, before + 1, 'menus never submit a duplicate question');
        await tap(); await expect.poll(body).toBe(continuedReading);
      }
      result.followupsKeepAskAndMenusPreserveConversation = true;
      await event(2); await expect.poll(body).not.toBe(continuedReading); assert(!(await body()).includes('THIRD partial reply'));
      // Dictation owns the footer only while its overlay is visible. After
      // accepting, the paused rate survives every agent notification state.
      for (const mode of ['auto', 'speed']) {
        await page.locator(`#mode-${mode}`).evaluate(el => el.click());
        await page.locator('#position').evaluate(el => { el.value = '300'; el.dispatchEvent(new Event('input')); });
        await expect.poll(status).toMatch(/Paused \d+ (l\/min|wpm)/);
        const before = prompts.length;
        await event(9); await expect.poll(status).toContain('Listening');
        await partial(`A ${mode} question`); await event(10); await expect(page.locator('#ask-review-cancel')).toBeVisible();
        await tap(); await expect.poll(() => prompts.length).toBe(before + 1);
        await expect.poll(status).toContain('○ '); await expect.poll(status).toMatch(/Paused \d+ (l\/min|wpm)/);
        emit(`A ${mode} partial reply.`); await expect.poll(status, { timeout: 15000 }).toContain('◐ ');
        await expect.poll(status).toMatch(/Paused \d+ (l\/min|wpm)/);
        emit(`A ${mode} complete reply.`, true); await expect.poll(status, { timeout: 15000 }).toContain('● ');
        await expect.poll(status).toMatch(/Paused \d+ (l\/min|wpm)/);
        await event(3); await expect(page.locator('#ask-panel')).toBeVisible(); await event(3);
        await expect.poll(status).toMatch(/Paused \d+ (l\/min|wpm)/);
      }
      result.pausedRateAfterDictationAndDuringReply = true;
      await page.locator('#mode-page').evaluate(el => el.click());
      await showLibrary(page); await page.locator('[data-document-id="other.md"] .document-card').click();
      await showSettings(page); await expect(page.locator('#ask-reply-view')).toHaveCount(0); await expect(page.locator('#reading-tap')).toHaveCount(0); await hideSettings(page);
      await page.reload(); await expect(page.locator('#import')).toBeEnabled({ timeout: 30000 }); await showSettings(page);
      await expect(page.locator('#ask-reply-view')).toHaveCount(0); await expect(page.locator('#reading-tap')).toHaveCount(0);
      result.manualPolicyAndSharedPreferences = true; result.pagesTapSwitchesAsk = true;
      await hideSettings(page);
      // Releasing or cancelling while the native microphone is starting must
      // stop it after acknowledgement, without a stale Listening transition.
      for (const action of [10, 3]) {
        await page.evaluate(() => { window.__holdMic = true; window.__releaseMic = null; window.__micCalls = []; });
        await event(9); await expect.poll(() => page.evaluate(() => !!window.__releaseMic)).toBe(true);
        await expect.poll(status).toContain('Starting microphone');
        await event(action);
        await page.evaluate(() => { window.__holdMic = false; window.__releaseMic(); });
        await expect.poll(() => page.evaluate(() => window.__micCalls.map(call => call.enabled))).toEqual([true, false]);
        await expect(page.locator('#ask-status')).not.toHaveText(/^Listening/);
        await expect.poll(() => page.evaluate(() => !!window.__boxes['review-panel'])).toBe(false);
      }
      // Release before queued display work finishes: no microphone should be
      // opened afterwards and no previous recording should be reused.
      await page.evaluate(() => { window.__holdDisplay = true; window.__releaseDisplay = null; window.__micCalls = []; });
      await event(9); await expect.poll(() => page.evaluate(() => !!window.__releaseDisplay)).toBe(true);
      await event(10); await page.evaluate(() => window.__releaseDisplay());
      await expect(page.locator('#ask-status')).not.toHaveText(/No speech|recorded|recognized/);
      await expect.poll(() => page.evaluate(() => !!window.__boxes['review-panel'])).toBe(false);
      assert.deepEqual(await page.evaluate(() => window.__micCalls), []);
      result.cancelAndReleaseDuringStartup = true;
      await event(9); await expect.poll(status).toContain('Listening');
      await page.evaluate(() => { window.__holdPrepare = false; window.__prepareWaiters.splice(0).forEach(ready => ready()); });
      const acceptLong = Array.from({ length: 600 }, (_, i) => `AcceptWord${i}`).join(' ');
      await partial(acceptLong);
      const acceptanceTail = await overlay(); await event(1); await expect.poll(overlay).not.toBe(acceptanceTail);
      const beforeLiveAccept = prompts.length;
      await tap(); await event(10);
      await expect.poll(() => prompts.length).toBe(beforeLiveAccept + 1);
      assert(prompts.at(-1).text.includes(acceptLong), 'accepting while scrolled back submits every word, including off-screen words');
      emit('Live acceptance completed.', true); await expect(page.locator('#ask-send')).toBeEnabled({ timeout: 15000 });
      await event(9); await expect.poll(status).toContain('Listening');
      await partial('Cancel while final words are processing');
      const oldSpeechId = await page.evaluate(() => window.__speech.id);
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { audioEvent: { audioPcm: new Uint8Array(16000), source: 'glasses' } } })));
      await tap();
      await expect.poll(() => page.evaluate(old => window.__speech.id !== old, oldSpeechId)).toBe(true);
      await event(3); await speech('Cancel while final words are processing FINAL');
      await expect.poll(() => page.evaluate(() => !!window.__boxes['review-panel'])).toBe(false);
      await page.waitForTimeout(400); assert.equal(prompts.length, beforeLiveAccept + 1);
      result.liveTapAcceptAndCancellationDuringFlush = true;
      // A failed stream cannot keep recording silently after its audio buffer
      // has been cancelled. Preserve the existing draft for review.
      await event(9); await expect.poll(status).toContain('Listening');
      await partial('Keep the draft when recognition fails.');
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { audioEvent: { audioPcm: new Uint8Array(16000), source: 'glasses' } } }));
      });
      await page.waitForTimeout(250);
      await page.evaluate(() => window.__speech.onmessage({ data: { id: window.__speech.id, error: 'Fixture recognition failure.' } }));
      await expect(page.locator('#ask-status')).not.toHaveText(/^Listening/);
      await expect.poll(() => page.evaluate(() => window.__micCalls.at(-1)?.enabled)).toBe(false);
      await expect(page.locator('#ask-question')).toHaveValue('Keep the draft when recognition fails.');
      await event(3); result.speechFailureStopsCapture = true;
      // A PDF bitmap still being drawn cannot postpone opening the overlay.
      // Keep real PDF preparation, layout and native display; stall only draw().
      await page.evaluate(async () => {
        const { PdfDocument } = await import('/src/pdf.js'); const draw = PdfDocument.prototype.draw;
        const pending = new Promise(resolve => { window.__releasePdf = resolve; }); window.__pdfDraws = 0;
        PdfDocument.prototype.draw = async function (...args) {
          if (args[2] === true) { window.__pdfDraws++; await pending; }
          return draw.apply(this, args);
        };
      });
      await page.locator('#file-picker').setInputFiles({ name: 'cold.pdf', mimeType: 'application/pdf', buffer: pdfFixture('annotations') });
      await showLibrary(page); await page.locator('[data-document-id="cold.pdf"] .document-card').click();
      await expect.poll(() => page.evaluate(() => window.__pdfDraws), { timeout: 30000 }).toBeGreaterThan(0);
      await event(9); await expect.poll(status).toContain('Listening');
      assert.equal(await overlay(), ' ');
      assert.equal(await page.evaluate(() => window.__imageUpdates), 0);
      await page.evaluate(() => window.__releasePdf());
      await expect.poll(() => page.evaluate(() => window.__imageUpdates)).toBeGreaterThan(0);
      assert.equal(await overlay(), ' ');
      await event(3);
      result.popupDuringPdfDraw = true;
      assert.deepEqual(result.errors, []); result.passed = true;
    } catch (error) { result.error = error.stack; await page?.screenshot({ path: `${out}/${engine.name()}-failure.png` }).catch(() => {}); throw error; }
    finally { await browser.close(); }
  }
} finally { await vite.close(); await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2)); }
console.log(JSON.stringify(results));
