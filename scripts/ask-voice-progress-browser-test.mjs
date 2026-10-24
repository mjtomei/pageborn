// Actual SDK/display path; controllable speech and Terminal fixtures keep each
// stage open long enough to swipe and exercise SDK background-clock ticks.
import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { showLibrary, backToReading } from './ui-helpers.mjs';

process.env.PAGEBORNE_ASK_ORIGINS = 'https://voice-progress.test';
const vite = await createServer({ cacheDir: '.state/vite-voice-progress', optimizeDeps: { entries: ['index.html'], include: ['@huggingface/transformers', 'wasm-feature-detect'] }, server: { host: '127.0.0.1', port: 0 }, clearScreen: false }); await vite.listen();
const useWebkit = process.argv.includes('--webkit');
const browser = await (useWebkit ? webkit : chromium).launch({ executablePath: useWebkit ? process.env.WEBKIT_PATH : '/usr/bin/google-chrome', headless: true });
const out = `test-results/ask-voice-progress${useWebkit ? '-webkit' : ''}`; await mkdir(out, { recursive: true });
const result = { passed: false, errors: [] }; const prompts = [], messages = []; let polls = 0, done = true;
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', error => result.errors.push(error.message));
  const storage = new Map();
  await page.exposeFunction('__storage', ({ method, data }) => method === 'getLocalStorage' ? storage.get(data.key) || '' : (storage.set(data.key, data.value), true));
  await page.addInitScript(() => {
    const NativeWorker = Worker;
    window.Worker = class {
      constructor(url, options) { if (!String(url).includes('speech-worker')) return new NativeWorker(url, options); }
      postMessage(data) {
        if (data.operation === 'cancel') { this.cancelled = true; return; }
        if (data.operation === 'prepare') { this.onmessage({ data: { id: data.id, result: { model: data.model, backend: data.backend, loadMs: 10 } } }); return; }
        window.__speechSerial = (window.__speechSerial || 0) + 1; window.__speech = this; this.id = data.id; this.model = data.model; this.partial = data.partial; this.cancelled = false;
        this.onmessage({ data: { id: this.id, progress: 'Transcribing locally · SIMD…' } });
      }
      terminate() { this.stopped = true; }
    };
    localStorage.setItem('even-reader:preferences:v1', JSON.stringify({ ask: { mode: 'terminal', endpoint: 'https://voice-progress.test', token: 'fixture', agent: 'codex' } }));
    window.__body = ''; window.__status = ''; window.__bodyWrites = 0; window.__reviewText = ''; window.__reviewHint = false;
    window.flutter_inappwebview = { async callHandler(_, payload) {
      const m = JSON.parse(payload);
      if (m.method.endsWith('LocalStorage')) return window.__storage(m);
      const texts = m.method === 'textContainerUpgrade' ? [m.data] : m.data?.textObject || [];
      for (const t of texts) {
        if (t.containerName === 'body') { window.__body = t.content; window.__bodyWrites++; }
        if (t.containerName === 'status') window.__status = t.content;
        if (t.containerName === 'review-hint') window.__reviewHint = t.content === 'Edit on phone';
        if (t.containerName === 'review-text') window.__reviewText = t.content;
      }
      return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
    } };
  });
  const answer = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}: An earlier answer that remains readable while recording, transcribing and waiting for another reply.`).join('\n\n');
  await page.route('https://voice-progress.test/**', async route => {
    const req = route.request(), url = new URL(req.url());
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const json = value => route.fulfill({ headers, json: value });
    if (url.pathname === '/api/info') return json({ provider: 'codex' });
    if (url.pathname === '/api/events') return route.fulfill({ headers, contentType: 'text/event-stream', body: ': connected\n\n' });
    if (url.pathname.endsWith('/history')) return json({ history: [] });
    if (url.pathname === '/api/messages') { polls++; return json({ state: done ? 'idle' : 'busy', messages }); }
    if (url.pathname === '/api/prompt') {
      const body = req.postDataJSON(); prompts.push(body); messages.push({ id: messages.length + 1, type: 'user_prompt', text: body.text });
      if (prompts.length === 1) messages.push({ id: messages.length + 1, type: 'result', success: true, text: answer });
      else done = false;
      return json({ sessionId: 'voice-fixture' });
    }
    throw new Error(`Unexpected route ${url.pathname}`);
  });
  const event = eventType => page.evaluate(eventType => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { sysEvent: { eventType } } })), eventType);
  const body = () => page.evaluate(() => window.__body), status = () => page.evaluate(() => window.__status);
  const swipe = async (direction = 2) => { const before = await body(); await event(direction); await expect.poll(body).not.toBe(before); };
  await page.goto(vite.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled();
  await page.locator('#file-picker').setInputFiles({ name: 'conversation.md', mimeType: 'text/markdown', buffer: Buffer.from('# Conversation\n\n' + 'A document to ask about. '.repeat(500)) });
  await showLibrary(page); await page.locator('[data-document-id="conversation.md"] .document-card').click();
  await page.locator('#ask-open').click(); await page.locator('#ask-question').fill('First question'); await page.locator('#ask-send').click();
  await expect(page.locator('#ask-answer')).toContainText('Paragraph 0'); await expect.poll(body).toContain('Paragraph 39'); for (let i = 0; i < 4; i++) await swipe(1);
  const prior = await body();
  await event(9); await expect.poll(status).toContain('Listening'); assert.equal(await body(), prior.split('\n').slice(0, 7).join('\n')); await swipe();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { audioEvent: { audioPcm: new Uint8Array(64000), source: 'glasses' } } })));
  await expect.poll(() => page.evaluate(() => window.__speech?.partial)).toBe(true);
  const beforePartial = await body();
  for (const text of ['A', 'A live', 'A live spoken']) {
    await page.evaluate(text => window.__speech.onmessage({ data: { id: window.__speech.id, partial: { text, words: [] } } }), text);
    await expect(page.locator('#ask-question')).toHaveValue(text.trim());
    await expect.poll(() => page.evaluate(() => window.__reviewText)).toBe(text);
  }
  result.decoderWordsReachOverlay = true;
  await page.evaluate(() => window.__speech.onmessage({ data: { id: window.__speech.id, result: { text: 'A live spoken draft', words: [] } } }));
  await expect(page.locator('#ask-question')).toHaveValue('A live spoken draft');
  await expect.poll(() => page.evaluate(() => window.__reviewText)).toBe('A live spoken draft'); assert.equal(await body(), beforePartial); await swipe();
  // Include a tail after the latest draft. Release must expose Send/Cancel
  // immediately, while Tiny finishes that unfinished window in the background.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { audioEvent: { audioPcm: new Uint8Array(6400), source: 'glasses' } } })));
  await event(10); await expect(page.locator('#ask-review-cancel')).toBeVisible();
  await expect(page.locator('#ask-question')).toHaveValue('A live spoken draft');
  await expect(page.locator('#ask-status')).toContainText('Refining');
  await expect.poll(() => page.evaluate(() => window.__speech?.partial)).toBe(false);
  const beforeReview = await body();
  await page.evaluate(() => window.__speech.onmessage({ data: { id: window.__speech.id, result: { text: 'A spoken follow-up', words: [{ start: 2, end: 8, confidence: 0.75 }], backend: 'wasm', seconds: 2, loadMs: 0, transcribeMs: 10 } } }));
  result.instantReviewDuringCpuCompletion = true;
  await expect(page.locator('#ask-review-cancel')).toBeVisible(); await expect.poll(() => page.evaluate(() => window.__reviewText)).toBe('A spoken follow-up');
  assert.equal(await page.evaluate(() => window.__reviewHint), false); result.partialPreservesConversation = true;
  assert.equal(prompts.length, 1, 'Transcription alone never submits');
  await expect(page.locator('#ask-question-colors .speech-uncertain')).toHaveText('spoken');
  await expect(page.locator('#ask-question')).toHaveClass(/has-confidence/);
  await event(10); assert.equal(prompts.length, 1, 'Repeated release never submits');
  await page.screenshot({ path: `${out}/review.png` });
  await expect(page.locator('#ask-status')).toContainText('Refining');
  assert.equal(await page.evaluate(() => window.__speech.model), 'refine');
  await event(2); // Cancel must stay selected even if a refined result adds transcript pages.
  await page.evaluate(() => window.__speech.onmessage({ data: { id: window.__speech.id, result: { text: 'A corrected spoken follow-up about the surrounding text and the following section. '.repeat(3), model: 'Whisper Small English', backend: 'wasm', seconds: 2, loadMs: 1, transcribeMs: 20 } } }));
  await expect(page.locator('#ask-question')).toHaveValue(/A corrected spoken/);
  await expect(page.locator('#ask-status')).toHaveText('');
  assert.equal(prompts.length, 1, 'Background refinement does not submit');
  await page.screenshot({ path: `${out}/refined.png` });
  await event(0); await expect(page.locator('#ask-review-cancel')).toBeHidden();
  await expect.poll(async () => (await body()).startsWith(beforeReview)).toBe(true); assert.equal(prompts.length, 1);
  const dictated = async text => {
    await event(9); await expect.poll(status).toContain('Listening');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { audioEvent: { audioPcm: new Uint8Array(6400), source: 'glasses' } } })));
    const serial = await page.evaluate(() => window.__speechSerial || 0);
    await event(10); await expect.poll(status).toContain('Refining');
    await expect.poll(() => page.evaluate(() => window.__speechSerial)).toBeGreaterThan(serial);
    await page.evaluate(text => window.__speech.onmessage({ data: { id: window.__speech.id, result: { text, backend: 'wasm', seconds: 2, loadMs: 0, transcribeMs: 10 } } }), text);
    await expect(page.locator('#ask-review-cancel')).toBeVisible();
    await expect(page.locator('#ask-question')).toHaveValue(text.trim());
    await expect.poll(() => page.evaluate(() => window.__speech?.model)).toBe('refine');
  };
  await dictated('A longer question about this specific passage and the following sections. '.repeat(15));
  const firstReviewPage = await page.evaluate(() => window.__reviewText);
  assert.doesNotMatch(await status(), /\d+\/\d+/);
  await event(2); await event(2); await expect.poll(() => page.evaluate(() => window.__reviewText)).not.toBe(firstReviewPage);
  assert.doesNotMatch(await status(), /\d+\/\d+/);
  await event(3); await expect(page.locator('#ask-review-cancel')).toBeHidden(); assert.equal(prompts.length, 1);
  await dictated('A spoken follow-up');
  await page.evaluate(() => { window.__lateRefinement = window.__speech; });
  await page.locator('#ask-question').fill('An edited spoken follow-up');
  assert(await page.evaluate(() => window.__lateRefinement.cancelled && !window.__lateRefinement.stopped));
  await page.evaluate(() => window.__lateRefinement.onmessage({ data: { id: window.__lateRefinement.id, result: { text: 'A late correction that must be ignored' } } }));
  await expect(page.locator('#ask-question')).toHaveValue('An edited spoken follow-up');
  await expect.poll(() => page.evaluate(() => window.__reviewText)).toBe('An edited spoken follow-up');
  await event(0);
  await expect.poll(() => prompts.length).toBe(2); await expect.poll(status).toContain('Thinking');
  assert.match(prompts[1].text, /An edited spoken follow-up/);
  await expect(page.locator('#ask-answer')).toHaveText(''); await swipe();
  const beforePolls = polls;
  for (let i = 0; i < 4; i++) { await page.evaluate(() => window.__tickShadowTimers(4000)); await page.waitForTimeout(80); }
  await backToReading(page);
  for (let i = 0; i < 4; i++) { await page.evaluate(() => window.__tickShadowTimers(4000)); await page.waitForTimeout(80); }
  assert(polls - beforePolls <= 12, `Reply polling multiplied: ${polls - beforePolls}`);
  // Native timers must not start duplicate polling chains after shadow firing.
  const afterTicks = polls; await page.waitForTimeout(4400);
  // Reading retains the single active reply loop (700 ms), instead of falling
  // back to the four-second footer poll used after closing the session.
  assert(polls - afterTicks <= 7, `Old native timer callbacks restarted polling: ${polls - afterTicks}`);
  await page.locator('#ask-open').click(); await expect.poll(body).toContain('earlier answer'); await swipe(1);
  const historyPlace = await body();
  done = true; messages.push({ id: messages.length + 1, type: 'result', success: true, text: 'A new reply to the spoken follow-up.' });
  await expect(page.locator('#ask-answer')).toHaveText('A new reply to the spoken follow-up.');
  assert.equal(await body(), historyPlace, 'Completing a reply preserves manual navigation through earlier messages');
  for (let i = 0; i < 60 && await page.locator('#next').isEnabled(); i++) await swipe();
  await expect.poll(body).toContain('A new reply'); assert.equal(prompts.length, 2); assert.deepEqual(result.errors, []);
  result.historyPreservedWhileThinking = true;
  await event(9); await expect.poll(status).toContain('Listening'); await event(10);
  await expect(page.locator('#ask-status')).toContainText('No speech');
  assert.match(await body(), /A new reply/);
  await dictated('Keep the fast result after a failure');
  await page.evaluate(() => window.__speech.onmessage({ data: { id: window.__speech.id, error: 'Model failed in fixture', fatal: false } }));
  await expect(page.locator('#ask-status')).toHaveText('');
  await expect(page.locator('#ask-question')).toHaveValue('Keep the fast result after a failure');
  await page.locator('#ask-review-cancel').click();
  await dictated('Cancel on the phone');
  await page.evaluate(() => { window.__lateRefinement = window.__speech; }); await page.locator('#ask-review-cancel').click();
  await expect(page.locator('#ask-review-cancel')).toBeHidden(); await expect(page.locator('#ask-question')).toHaveValue('');
  assert(await page.evaluate(() => window.__lateRefinement.cancelled && !window.__lateRefinement.stopped));
  await page.evaluate(() => window.__lateRefinement.onmessage({ data: { id: window.__lateRefinement.id, result: { text: 'Late after cancel' } } }));
  await expect(page.locator('#ask-question')).toHaveValue('');
  result.backgroundRefinement = true; result.editAndCancelIgnoreLateRefinement = true; result.refinementFailureKeepsDraft = true;
  assert.equal(prompts.length, 2);
  const turns = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('even-reader:preferences:v1')).askChats).flat());
  assert(turns.every(turn => turn.state === 'complete'), 'A failed microphone attempt preserves completed conversation turns');
  result.failedVoiceKeepsHistory = true;
  await dictated('Send the first draft now');
  await page.evaluate(() => { window.__lateRefinement = window.__speech; });
  await event(0); await expect.poll(() => prompts.length).toBe(3);
  assert(await page.evaluate(() => window.__lateRefinement.cancelled && !window.__lateRefinement.stopped));
  await page.evaluate(() => window.__lateRefinement.onmessage({ data: { id: window.__lateRefinement.id, result: { text: 'Must not change the submitted question' } } }));
  assert.match(prompts[2].text, /Send the first draft now/);
  assert(!prompts[2].text.includes('Must not change'));
  done = true; messages.push({ id: messages.length + 1, type: 'result', success: true, text: 'Reply to the first draft.' });
  await expect(page.locator('#ask-answer')).toHaveText('Reply to the first draft.');
  await dictated('Discard when leaving Ask');
  await page.evaluate(() => { window.__lateRefinement = window.__speech; });
  await backToReading(page);
  assert(await page.evaluate(() => window.__lateRefinement.cancelled && !window.__lateRefinement.stopped));
  await page.evaluate(() => window.__lateRefinement.onmessage({ data: { id: window.__lateRefinement.id, result: { text: 'Late after leaving' } } }));
  await page.locator('#ask-open').click(); await expect(page.locator('#ask-review-cancel')).toBeHidden();
  await expect(page.locator('#ask-question')).toHaveValue('');
  assert.equal(prompts.length, 3);
  result.sendAndCloseCancelRefinement = true;

  const pendingCpu = async () => {
    await event(9); await expect.poll(status).toContain('Listening');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { audioEvent: { audioPcm: new Uint8Array(64000), source: 'glasses' } } })));
    await expect.poll(() => page.evaluate(() => window.__speech?.model === 'fast' && window.__speech.partial)).toBe(true);
    await page.evaluate(() => window.__speech.onmessage({ data: { id: window.__speech.id, result: { text: 'Live draft ready to send', words: [], backend: 'wasm', transcribeMs: 10 } } }));
    await expect(page.locator('#ask-question')).toHaveValue('Live draft ready to send');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { audioEvent: { audioPcm: new Uint8Array(6400), source: 'glasses' } } })));
    await event(10); await expect(page.locator('#ask-review-cancel')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__speech?.partial)).toBe(false);
    await page.evaluate(() => { window.__cpu = { worker: window.__speech, id: window.__speech.id }; });
    await expect(page.locator('#ask-status')).toContainText('Refining');
  };
  const lateCpu = () => page.evaluate(() => window.__cpu.worker.onmessage({ data: { id: window.__cpu.id, result: { text: 'Late CPU text that must never replace an edit or be submitted' } } }));
  await pendingCpu(); await page.locator('#ask-question').fill('Phone edit while CPU finishes');
  assert(await page.evaluate(() => window.__cpu.worker.cancelled)); await lateCpu();
  await expect(page.locator('#ask-question')).toHaveValue('Phone edit while CPU finishes');
  await page.locator('#ask-review-cancel').click();
  await pendingCpu(); await page.locator('#ask-review-cancel').click(); await lateCpu();
  await expect(page.locator('#ask-question')).toHaveValue(''); await expect(page.locator('#ask-review-cancel')).toBeHidden();
  await pendingCpu();
  await page.evaluate(() => window.__cpu.worker.onmessage({ data: { id: window.__cpu.id, error: 'CPU completion failed in fixture', fatal: false } }));
  await expect(page.locator('#ask-status')).toHaveText('');
  await expect(page.locator('#ask-question')).toHaveValue('Live draft ready to send'); await page.locator('#ask-review-cancel').click();
  // If release happened before the first word, a later decoder update is
  // still usable if finishing that pass fails. Keep it available to send.
  await event(9); await expect.poll(status).toContain('Listening');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { audioEvent: { audioPcm: new Uint8Array(6400), source: 'glasses' } } })));
  const earlySerial = await page.evaluate(() => window.__speechSerial);
  await event(10); await expect.poll(() => page.evaluate(() => window.__speechSerial)).toBeGreaterThan(earlySerial);
  await expect.poll(() => page.evaluate(() => window.__speech?.partial)).toBe(false);
  await page.evaluate(() => window.__speech.onmessage({ data: { id: window.__speech.id, partial: { text: 'Words first seen after release', words: [] } } }));
  await expect(page.locator('#ask-question')).toHaveValue('Words first seen after release');
  await page.evaluate(() => window.__speech.onmessage({ data: { id: window.__speech.id, error: 'CPU completion failed in fixture', fatal: false } }));
  await expect(page.locator('#ask-status')).toHaveText('');
  await expect(page.locator('#ask-question')).toHaveValue('Words first seen after release');
  await page.locator('#ask-review-cancel').click();
  await pendingCpu(); await event(0); await expect.poll(() => prompts.length).toBe(4);
  assert(await page.evaluate(() => window.__cpu.worker.cancelled)); await lateCpu();
  assert.match(prompts[3].text, /Live draft ready to send/); assert(!prompts[3].text.includes('Late CPU'));
  done = true; messages.push({ id: messages.length + 1, type: 'result', success: true, text: 'Reply to immediately sent live draft.' });
  await expect(page.locator('#ask-answer')).toHaveText('Reply to immediately sent live draft.');
  await pendingCpu(); await backToReading(page); await lateCpu();
  await page.locator('#ask-open').click(); await expect(page.locator('#ask-review-cancel')).toBeHidden();
  await expect(page.locator('#ask-question')).toHaveValue(''); assert.equal(prompts.length, 4);
  result.cpuCompletionIgnoresEditCancelSendAndClose = true; result.cpuFailureKeepsDraft = true;

  result.transcriptionRequiresConfirmation = true; result.cancelRestoresConversation = true; result.longReviewPages = true; result.phoneEditsReachGlasses = true;
  assert.deepEqual(result.errors, []);
  result.passed = true; result.scrollableDuringVoiceAndThinking = true; result.shadowTicks = 8; result.boundedReplyPolls = polls - beforePolls;
  await mkdir(out, { recursive: true });
  await page.screenshot({ path: `${out}/completed.png` });
} finally {
  await mkdir(out, { recursive: true });
  await writeFile(`${out}/results.json`, JSON.stringify(result, null, 2));
  await browser.close(); await vite.close();
}
console.log(JSON.stringify(result));
