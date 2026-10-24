import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'vite';
import { installPaperWorkspaces, workspaceCapabilities } from '../integrations/even-terminal/pageborne-workspaces.js';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';
import { showLibrary, showTool, hideSettings, waitForPdfReady, backToReading } from './ui-helpers.mjs';

const out = path.resolve('test-results/ask-files'); await mkdir(out, { recursive: true });
const baseDir = await mkdtemp(path.join(tmpdir(), 'pageborne-files-browser-'));
const app = express(); const sessions = new Map(), prompts = [], chunks = []; let id = 0, holdUpload = false, releaseUpload;
app.use((req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  if (req.get('authorization') !== 'Bearer fixture-token') return res.sendStatus(401); next();
});
app.use(express.json({ limit: '10mb' }));
app.use('/api/pageborne/files/chunk', async (req, _res, next) => {
  chunks.push(req.body.file.name); if (holdUpload) { holdUpload = false; await new Promise(resolve => releaseUpload = resolve); } next();
});
const router = express.Router(); installPaperWorkspaces(router, { baseDir, defaultBase: baseDir }); app.use('/api', router);
app.get('/api/info', (_req, res) => res.json({ provider: 'codex', pageborne: { ...workspaceCapabilities(), librarySync: undefined } }));
app.get('/api/events', (_req, res) => { res.type('text/event-stream'); res.flushHeaders(); res.write(':ok\n\n'); const timer = setInterval(() => res.write(':ok\n\n'), 1000); res.on('close', () => clearInterval(timer)); });
app.get('/api/sessions/:id/history', (_req, res) => res.json({ history: [] }));
app.get('/api/sessions', (_req, res) => res.json({ sessions: [{ id: 'manually-started', title: 'Manually started in prepared folder', status: 'idle' }] }));
app.get('/api/messages', (req, res) => res.json({ state: 'idle', messages: sessions.get(req.query.sessionId) || [] }));
app.post('/api/prompt', async (req, res) => {
  try {
    const position = JSON.parse(req.body.text.match(/Current reading position \(source material\):\n([^\n]+)/)[1]);
    const lines = (await readFile(position.file, 'utf8')).split('\n');
    const line = lines[position.line - 1]; assert(line != null, 'pointer line exists');
    assert(!('quote' in position) && !('passage' in position) && !('focus' in position));
    if (line.length > 40) assert(!req.body.text.includes(line), 'document text must be read from the file');
    assert(req.body.text.length < 6000 && !req.body.text.includes('Reading context (source material)'), 'prompt uses a pointer, not a large inline passage');
    const sid = req.body.sessionId || `files-${++id}`; const messages = sessions.get(sid) || []; const serial = messages.at(-1)?.id || 0;
    prompts.push({ ...req.body, position, line, id: sid });
    messages.push({ id: serial + 1, type: 'user_prompt', text: req.body.text }, { id: serial + 2, type: 'result', success: true, text: `Read from the file at line ${position.line}: ${line}` }); sessions.set(sid, messages);
    res.status(202).json({ sessionId: sid });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
const api = app.listen(0, '127.0.0.1'); await new Promise(resolve => api.once('listening', resolve));
const endpoint = `http://127.0.0.1:${api.address().port}`; process.env.PAGEBORNE_ASK_ORIGINS = endpoint;
const vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, clearScreen: false }); await vite.listen();
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const result = { passed: false, errors: [], cases: [] }; let page;
try {
  assert.equal((await fetch(endpoint + '/api/pageborne/files/status', { method: 'POST' })).status, 401);
  for (const native of [false, true]) {
    const context = await browser.newContext({ viewport: native ? { width: 390, height: 844 } : { width: 1280, height: 1000 }, recordVideo: { dir: path.join(out, native ? 'phone' : 'desktop') } });
    const storage = new Map();
    await context.exposeFunction('__storage', ({ method, data }) => { if (method === 'getLocalStorage') return storage.get(data.key) || ''; storage.set(data.key, data.value); return true; });
    if (native) await context.addInitScript(() => { window.flutter_inappwebview = { async callHandler(_, payload) {
      const message = JSON.parse(payload); if (message.method.endsWith('LocalStorage')) return window.__storage(message);
      return ['createStartUpPageContainer', 'updateImageRawData'].includes(message.method) ? 0 : true;
    } }; });
    page = await context.newPage(); page.on('pageerror', error => result.errors.push(error.message));
    await page.goto(vite.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled();
    await showTool(page, 'settings'); await page.locator('#ask-mode').selectOption('terminal'); await page.locator('#ask-endpoint').fill(endpoint);
    await page.locator('#ask-token').fill('fixture-token'); await page.locator('#ask-agent').selectOption('codex');
    if (native) { await page.locator('#ask-folders').check(); await page.locator('#ask-base-dir').fill(path.join(baseDir, 'phone-session-base')); }
    await page.locator('#ask-config-save').click(); await hideSettings(page);
    await showLibrary(page);
    await page.locator('#file-picker').setInputFiles([
      { name: 'guide.md', mimeType: 'text/markdown', buffer: Buffer.from('# Reference\n\n' + Array.from({ length: 200 }, (_, n) => `## Section ${n}\n\n` + `An explanation of paragraph ${n} and its reasoning. `.repeat(20)).join('\n\n')) },
      { name: 'paper.pdf', mimeType: 'application/pdf', buffer: pdfFixture('annotations') },
    ]);
    const open = async file => { await showLibrary(page); await page.locator(`[data-document-id="${file}"] .document-card`).click(); await expect(page.locator('#ask-open')).toBeEnabled(); if (file.endsWith('.pdf')) await waitForPdfReady(page); };
    for (const file of ['guide.md', 'paper.pdf']) {
      await open(file); await page.locator('#position').evaluate(el => { el.value = '150'; el.dispatchEvent(new Event('input')); }); await page.waitForTimeout(150);
      const start = prompts.length; const beforeChunks = chunks.length; holdUpload = true; releaseUpload = null;
      await page.locator('#ask-open').click(); let preparedCwd;
      if (native && file.endsWith('.pdf')) {
        await page.locator('.ask-details').evaluate(el => el.open = true); await page.locator('#ask-paper-session').evaluate(el => el.open = true);
        await page.locator('#ask-workspace').click(); await expect(page.locator('#ask-paper-cwd')).not.toHaveValue('');
        preparedCwd = await page.locator('#ask-paper-cwd').inputValue();
        await page.locator('#ask-sessions-refresh').click(); await page.locator('#ask-session-choice').selectOption('manually-started'); await page.locator('#ask-session-use').click();
        await page.locator('.ask-details').evaluate(el => el.open = false);
      }
      await page.locator('#ask-question').fill('Explain the current sentence.'); await page.locator('#ask-send').click();
      await expect.poll(() => !!releaseUpload).toBe(true);
      await backToReading(page); await expect(page.locator('#ask-footer')).toHaveAttribute('data-busy', 'true');
      await page.locator('#ask-footer').click(); await expect(page.locator('#ask-status')).toHaveAttribute('data-busy', 'true');
      assert.equal(prompts.length, start); releaseUpload();
      await expect(page.locator('#ask-answer')).toContainText('Read from the file', { timeout: 15000 });
      assert.equal(prompts.length, start + 1); assert(chunks.length > beforeChunks); assert(prompts.at(-1).text.includes('Paper files (read them as needed'));
      const source = JSON.parse(prompts.at(-1).text.match(/Paper files \(read them as needed; not inline context\):\n([^\n]+)/)[1]);
      const original = source.files.find(f => f.name.startsWith('original.')); const originalBytes = await readFile(original.path);
      if (native) {
        const cwd = preparedCwd || prompts.at(-1).cwd; assert(cwd.startsWith(path.join(baseDir, 'phone-session-base') + path.sep));
        if (preparedCwd) { assert.equal(prompts.at(-1).sessionId, 'manually-started'); assert.equal(prompts.at(-1).cwd, undefined); }
        assert.equal(path.dirname(source.index), path.join(cwd, 'files'));
        for (const file of source.files) assert.equal(path.dirname(file.path), path.join(cwd, 'files'));
      } else assert.equal(prompts.at(-1).cwd, undefined);
      if (file.endsWith('.pdf')) assert(originalBytes.equals(pdfFixture('annotations')));
      else assert(originalBytes.toString().includes('Section 199'));
      const originalSession = prompts.at(-1).id; const firstLine = prompts.at(-1).position.line; const uploaded = chunks.length;
      await expect(page.locator('#ask-source-label')).toHaveText('Paper files and current position');
      await backToReading(page); await page.locator('#position').evaluate(el => { el.value = '850'; el.dispatchEvent(new Event('input')); }); await page.waitForTimeout(150);
      await page.locator('#ask-open').click(); await page.locator('#ask-question').fill('And what about this part?'); await page.locator('#ask-send').click();
      await expect.poll(() => prompts.length).toBe(start + 2); await expect(page.locator('#ask-status')).toHaveAttribute('data-busy', 'false');
      assert.equal(prompts.at(-1).id, originalSession); assert.equal(chunks.length, uploaded); assert.notEqual(prompts.at(-1).position.line, firstLine);
      assert(!prompts.at(-1).text.includes('Paper files (read them as needed')); assert(prompts.at(-1).text.includes('Current reading position'));
      await page.screenshot({ path: path.join(out, `${native ? 'phone' : 'desktop'}-${file}.png`) });
      result.cases.push({ native, file, originalAvailable: true, pointerMoves: true, uploadsReused: true, backgroundSubmission: true, savedInsideSession: native, promptCharacters: prompts.at(-1).text.length });
    }
    // Reload retains the conversation and advertised revision; a new question
    // neither reuploads unchanged bytes nor repeats the initial file listing.
    const count = chunks.length, before = prompts.length;
    await page.reload(); await expect(page.locator('#import')).toBeEnabled(); await open('paper.pdf'); await page.locator('#ask-open').click();
    await page.locator('#ask-question').fill('Verify this against the original.'); await page.locator('#ask-send').click(); await expect.poll(() => prompts.length).toBe(before + 1);
    assert.equal(chunks.length, count); assert(!prompts.at(-1).text.includes('Paper files (read them as needed'));
    await context.close();
  }
  assert.deepEqual(result.errors, []); result.passed = true;
} catch (error) { result.failure = error.stack; await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); throw error; }
finally {
  await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2)); releaseUpload?.();
  await browser.close(); await vite.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); await rm(baseDir, { recursive: true, force: true });
}
console.log(JSON.stringify(result));
