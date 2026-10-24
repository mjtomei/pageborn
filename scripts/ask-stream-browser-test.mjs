import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { createServer } from 'vite';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';
import { showLibrary, showTool, hideSettings, waitForPdfReady, backToReading } from './ui-helpers.mjs';

const out = path.resolve('test-results/ask-stream'); await mkdir(out, { recursive: true });
const sessions = new Map(); const prompts = []; let serial = 0; let holdAck = false; let releaseAck;
const token = 'stream-test-token'; const app = express();
app.use((req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  if (req.get('authorization') !== `Bearer ${token}`) return res.sendStatus(401); next();
});
app.use(express.json({ limit: '8mb' }));
app.get('/api/info', (_req, res) => res.json({ provider: 'codex' }));
app.get('/api/events', (_req, res) => { res.type('text/event-stream'); res.flushHeaders(); res.write(':ok\n\n'); const timer = setInterval(() => res.write(':heartbeat\n\n'), 1000); res.on('close', () => clearInterval(timer)); });
app.get('/api/sessions/:id/history', (_req, res) => res.json({ history: [] }));
app.get('/api/messages', (req, res) => res.json(sessions.get(req.query.sessionId) || { state: 'idle', messages: [] }));
app.post('/api/prompt', async (req, res) => {
  const id = req.body.sessionId || `stream-${++serial}`; const session = sessions.get(id) || { messages: [] };
  session.state = 'busy'; session.messages.push({ id: (session.messages.at(-1)?.id || 0) + 1, type: 'user_prompt', text: req.body.text }); sessions.set(id, session);
  prompts.push({ ...req.body, id });
  if (holdAck) await new Promise(r => { releaseAck = r; });
  res.status(202).json({ sessionId: id, provider: 'codex' });
});
const api = app.listen(0, '127.0.0.1'); await new Promise(r => api.once('listening', r));
const endpoint = `http://127.0.0.1:${api.address().port}`; process.env.PAGEBORNE_ASK_ORIGINS = endpoint;
const vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, clearScreen: false }); await vite.listen();
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const result = { passed: false, errors: [] }; let page;
const emit = (id, event) => { const s = sessions.get(id); s.messages.push({ id: s.messages.at(-1).id + 1, ...event }); if (event.type === 'result') s.state = 'idle'; };
const source = '# Context book\n\n' + Array.from({ length: 500 }, (_, i) => `Paragraph ${i}. ${'The blue notebook contains twelve pages about the argument. '.repeat(20)}`).join('\n\n');
try {
  for (const native of [false, true]) {
    const name = native ? 'phone' : 'desktop'; const cases = [];
    const context = await browser.newContext({ viewport: native ? { width: 440, height: 806 } : { width: 1280, height: 1000 }, recordVideo: { dir: path.join(out, name), size: { width: 960, height: 900 } } });
    await context.addInitScript(() => { if (!localStorage.getItem('even-reader:preferences:v1')) localStorage.setItem('even-reader:preferences:v1', JSON.stringify({ askContextTokens: 5000 })); });
    const storage = new Map(); await context.exposeFunction('__storage', ({ method, data }) => { if (method === 'getLocalStorage') return storage.get(data.key) || ''; storage.set(data.key, data.value); return true; });
    if (native) await context.addInitScript(() => {
      window.__body = ''; window.__status = ''; window.__thinkingFrames = [];
      window.flutter_inappwebview = { async callHandler(_, serialized) {
        const m = JSON.parse(serialized); if (m.method.endsWith('LocalStorage')) return window.__storage(m);
        if (['createStartUpPageContainer', 'rebuildPageContainer'].includes(m.method)) for (const t of m.data.textObject || []) { if (t.containerName === 'body') window.__body = t.content; if (t.containerName === 'status') window.__status = t.content; }
        if (m.method === 'textContainerUpgrade') { if (m.data.containerName === 'body') window.__body = m.data.content; if (m.data.containerName === 'status') window.__status = m.data.content; }
        if (window.__status.includes('Thinking') && !window.__thinkingFrames.includes(window.__status)) window.__thinkingFrames.push(window.__status);
        return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
      } };
    });
    page = await context.newPage(); page.on('pageerror', e => result.errors.push(e.message));
    await page.goto(vite.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled();
    await showTool(page, 'settings'); await expect(page.locator('#ask-context-tokens')).toHaveCount(0);
    await page.locator('#ask-mode').selectOption('terminal'); await page.locator('#ask-endpoint').fill(endpoint); await page.locator('#ask-token').fill(token); await page.locator('#ask-agent').selectOption('codex');
    await page.locator('#ask-config-save').click(); await hideSettings(page); await showLibrary(page);
    await page.locator('#file-picker').setInputFiles([
      { name: 'context.md', mimeType: 'text/markdown', buffer: Buffer.from(source) },
      { name: 'paper.pdf', mimeType: 'application/pdf', buffer: pdfFixture('annotations') },
    ]);
    const open = async file => { await showLibrary(page); await page.locator(`[data-document-id="${file}"] .document-card`).click(); await expect(page.locator('#bookmark')).toBeEnabled({ timeout: 30000 }); if (file.endsWith('.pdf')) await waitForPdfReady(page); };
    const position = async () => { await page.waitForTimeout(150); return page.locator('#position').inputValue(); }; // Controls update on the display tick.
    const back = async () => { await backToReading(page); await expect(page.locator('#ask-panel')).toBeHidden(); };
    for (const file of ['context.md', 'paper.pdf']) {
      await open(file);
      await page.locator('#position').evaluate(el => { el.value = '400'; el.dispatchEvent(new Event('input')); });
      await page.waitForTimeout(200); // Allow the requested percentage to snap to a real text row.
      const originalPosition = await position(); const before = prompts.length;
      holdAck = file.endsWith('.pdf'); releaseAck = null;
      await page.locator('#ask-open').click(); await page.locator('#ask-question').fill('Explain the notebook argument.'); await page.locator('#ask-send').click();
      await expect.poll(() => prompts.length).toBe(before + 1); const prompt = prompts.at(-1); const id = prompt.id;
      await expect(page.locator('#ask-status')).toHaveAttribute('data-busy', 'true');
      assert.match(await page.locator('#ask-status').evaluate(el => getComputedStyle(el, '::before').animationName), /ask-thinking/);
      if (native && !holdAck) await expect.poll(() => page.evaluate(() => window.__thinkingFrames.length)).toBeGreaterThan(0);
      const originalContext = JSON.parse(prompt.text.match(/Reading context \(source material\):\n([^\n]+)/)[1]); const text = originalContext.passage;
      if (file.endsWith('.md')) { assert.equal(text.length, 400000); assert(text.includes(originalContext.focus)); }
      await back(); await expect(page.locator('#position')).toHaveValue(originalPosition);
      await expect(page.locator('#ask-footer')).toHaveText('Ask · Thinking…');
      // Reopen before the new session ID has returned, then acknowledge it.
      if (holdAck) {
        await page.locator('#ask-footer').click(); await expect(page.locator('#ask-status')).toHaveAttribute('data-busy', 'true');
        assert.equal(prompts.length, before + 1); releaseAck(); holdAck = false; await back();
      }
      const partial = 'STREAMED ANSWER: ' + 'The first part explains the notebook. '.repeat(100);
      emit(id, { type: 'text_delta', text: partial });
      await page.locator('#next').click(); const continuedPosition = await position();
      await expect(page.locator('#ask-panel')).toBeHidden();
      if (native) await expect.poll(() => page.evaluate(() => window.__body)).not.toContain('The first part explains');
      await page.locator('#ask-footer').click(); await expect(page.locator('#ask-answer')).toHaveText(partial);
      await expect(page.locator('#ask-send')).toBeDisabled(); assert.equal(prompts.length, before + 1);
      if (native) await expect.poll(() => page.evaluate(() => window.__body)).not.toContain('The first part explains');
      // Phone navigation leaves the glasses alone; the explicit glasses
      // shortcut opens the conversation, and swipes page through it.
      await page.locator('#preview').focus(); await page.keyboard.press('KeyC');
      if (native) await expect.poll(() => page.evaluate(() => window.__body)).toContain('The first part explains');
      const previousAnswerPage = native ? await page.evaluate(() => window.__body) : null;
      await page.keyboard.press('ArrowUp'); // Page back through the incomplete answer.
      if (native) await expect.poll(() => page.evaluate(() => window.__body)).not.toBe(previousAnswerPage);
      const nativeAnswerPage = native ? await page.evaluate(() => window.__body) : null;
      await expect(page.locator('.ask-message-user')).toHaveText('YouExplain the notebook argument.');
      await page.locator('#ask-history').evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
      const chatTop = await page.locator('#ask-history').evaluate(el => el.scrollTop);
      emit(id, { type: 'text_delta', text: 'A later part arrives.' });
      await expect(page.locator('#ask-answer')).toHaveText(partial + 'A later part arrives.');
      await page.waitForTimeout(80);
      assert.equal(await page.locator('#ask-history').evaluate(el => el.scrollTop), chatTop);
      await expect(page.locator('#ask-latest')).toBeVisible();
      await page.locator('#ask-latest').click();
      await expect.poll(() => page.locator('#ask-history').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
      if (native) await expect.poll(() => page.evaluate(() => window.__body)).toBe(nativeAnswerPage);
      await page.screenshot({ path: path.join(out, `${name}-${file}-streaming.png`) });
      await back(); await expect(page.locator('#position')).toHaveValue(continuedPosition);
      const completed = partial + 'A later part arrives. COMPLETE.'; emit(id, { type: 'result', success: true, text: completed });
      await expect(page.locator('#ask-footer')).toHaveText('Ask · Unread reply', { timeout: 10000 });
      await expect(page.locator('#ask-panel')).toBeHidden(); await expect(page.locator('#position')).toHaveValue(continuedPosition);
      if (native) await expect.poll(() => page.evaluate(() => window.__status)).toContain('● Tap: Ask');
      await page.screenshot({ path: path.join(out, `${name}-${file}-notification.png`) });
      await page.locator('#ask-footer').click(); await expect(page.locator('#ask-answer')).toHaveText(completed);
      await page.locator('#preview').focus(); await page.keyboard.press('KeyC');
      await expect(page.locator('#ask-status')).toHaveAttribute('data-busy', 'false');
      await expect(page.locator('.ask-message-user')).toHaveCount(1);
      await expect(page.locator('.ask-message-assistant')).toHaveCount(1);
      await expect(page.locator('#ask-footer')).toHaveText('Ask · No new replies'); assert.equal(prompts.length, before + 1);
      await back(); await expect(page.locator('#position')).toHaveValue(continuedPosition);
      // Read the same reply again after it has been acknowledged.
      await page.locator('#ask-open').click(); await expect(page.locator('#ask-answer')).toHaveText(completed); await back();
      // A stock server receives a fresh snapshot on every follow-up, including
      // the newly selected place, without starting a second paper conversation.
      await page.locator('#position').evaluate(el => { el.value = '850'; el.dispatchEvent(new Event('input')); }); await position();
      assert.equal(prompts.length, before + 1); // Moving alone does not ask anything.
      await page.locator('#ask-open').click(); await page.locator('#ask-question').fill('Explain this later passage.'); await page.locator('#ask-send').click();
      await expect.poll(() => prompts.length).toBe(before + 2);
      assert.equal(prompts.at(-1).sessionId, id);
      const followupContext = JSON.parse(prompts.at(-1).text.match(/Reading context \(source material\):\n([^\n]+)/)[1]);
      assert(followupContext.position > originalContext.position); assert(followupContext.passage.length > 0);
      assert(!prompts.at(-1).text.includes('Paper files (read them'));
      emit(id, { type: 'result', success: true, text: 'Answer about the later passage.' });
      await expect(page.locator('#ask-answer')).toHaveText('Answer about the later passage.'); await back();
      cases.push({ file, streamed: true, readDuringThinking: true, reopenedWhileThinking: true, notificationAndReturn: true, positionPreserved: true, freshFollowupContext: true, posts: 2, contextCharacters: text.length });
    }
    await open('context.md'); const before = prompts.length;
    await page.locator('#ask-open').click(); await page.locator('#ask-question').fill('Explain with the fixed context.'); await page.locator('#ask-send').click();
    await expect.poll(() => prompts.length).toBe(before + 1); const id = prompts.at(-1).id;
    const fixed = JSON.parse(prompts.at(-1).text.match(/Reading context \(source material\):\n([^\n]+)/)[1]).passage;
    assert.equal(fixed.length, 400000);
    emit(id, { type: 'text_delta', text: 'Restored after reload. ' }); await expect(page.locator('#ask-answer')).toHaveText('Restored after reload. ');
    await page.reload(); await expect(page.locator('#import')).toBeEnabled(); await open('context.md');
    await page.locator('#ask-open').click(); await expect(page.locator('#ask-answer')).toHaveText('Restored after reload. ');
    await expect(page.locator('.ask-message-user')).toHaveCount(3);
    await expect(page.locator('.ask-message-user').first()).toContainText('Explain the notebook argument.');
    await expect(page.locator('.ask-message-user').last()).toContainText('Explain with the fixed context.');
    assert.equal(prompts.length, before + 1);
    await page.emulateMedia({ reducedMotion: 'reduce' }); assert.equal(await page.locator('#ask-status').evaluate(el => getComputedStyle(el, '::before').animationName), 'none');
    emit(id, { type: 'result', success: true, text: 'Restored after reload. Complete.' }); await expect(page.locator('#ask-answer')).toHaveText('Restored after reload. Complete.'); await back();
    await showTool(page, 'settings'); await expect(page.locator('#ask-context-tokens')).toHaveCount(0); await hideSettings(page);
    assert.equal(prompts.length, before + 1); result[name] = { cases, reducedMotion: true, pendingReloadDoesNotResubmit: true, fixed100kContextIgnoresOldPreference: true };
    await context.close(); await copyFile(await page.video().path(), path.join(out, `${name}-stream-and-return.webm`));
  }
  assert.deepEqual(result.errors, []); result.passed = true;
} catch (error) { result.failure = error.stack; await page?.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {}); throw error; }
finally {
  await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2)); await browser.close(); await vite.close();
  releaseAck?.(); api.closeAllConnections(); await new Promise(r => api.close(r));
}
console.log(JSON.stringify(result));
