import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'vite';
import { installPaperWorkspaces, workspaceCapabilities } from '../integrations/even-terminal/pageborne-workspaces.js';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';
import { showLibrary, showTool, hideSettings, backToReading } from './ui-helpers.mjs';

const useWebkit = process.argv.includes('--webkit');
const out = `test-results/library-sync-${useWebkit ? 'webkit' : 'chromium'}`; await mkdir(out, { recursive: true });
const libraryDir = await mkdtemp(path.join(tmpdir(), 'pageborne-sync-browser-'));
const app = express(), sessions = new Map(), prompts = []; let session = 0, manifestCalls = 0, blockRead = false, releaseRead, holdReply = false, finishReply;
const attachments = new Map(); let expectedOriginal = '# Desktop revised\n\nUpdated shared text.';
let manifestFixture = null;
app.use((req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  if (req.get('authorization') !== 'Bearer fixture-token') return res.sendStatus(401); next();
});
app.use(express.json({ limit: '10mb' }));
app.use('/api/pageborne/library', (req, res, next) => {
  manifestCalls++;
  if (manifestFixture && req.method === 'GET' && req.path === '/') return res.json(manifestFixture);
  next();
});
app.use('/api/pageborne/library/read', async (_req, _res, next) => { if (blockRead) { blockRead = false; await new Promise(resolve => releaseRead = resolve); } next(); });
const router = express.Router(); installPaperWorkspaces(router, { libraryDir, baseDir: path.join(libraryDir, 'legacy'), defaultBase: path.join(libraryDir, 'sessions') }); app.use('/api', router);
app.get('/api/info', (_req, res) => res.json({ provider: 'codex', pageborne: workspaceCapabilities() }));
app.get('/api/events', (_req, res) => { res.type('text/event-stream'); res.flushHeaders(); res.write(':ok\n\n'); const timer = setInterval(() => res.write(':ok\n\n'), 1000); res.on('close', () => clearInterval(timer)); });
app.get('/api/sessions/:id/history', (_req, res) => res.json({ history: [] }));
app.get('/api/messages', (req, res) => res.json({ state: finishReply ? 'busy' : 'idle', messages: sessions.get(req.query.sessionId) || [] }));
app.post('/api/prompt', async (req, res) => {
  try {
    const id = req.body.sessionId || `sync-${++session}`;
    const announced = req.body.text.match(/Paper files \(read them as needed; not inline context\):\n([^\n]+)/);
    const files = announced ? JSON.parse(announced[1]) : attachments.get(id);
    attachments.set(id, files);
    const original = files.files.find(f => f.name.startsWith('original.'));
    assert.equal(path.dirname(original.path), path.dirname(files.index));
    assert.equal(await readFile(original.path, 'utf8'), expectedOriginal);
    assert(files.index.startsWith(path.join(libraryDir, '.pageborne/reflow') + '/'));
    assert(req.body.text.includes('saved snapshot of the version open in the reader'));
    const previous = sessions.get(id) || [], n = previous.at(-1)?.id || 0;
    prompts.push({ id, original: original.path, reflow: files.index, announced: !!announced });
    sessions.set(id, [...previous, { id: n + 1, type: 'user_prompt', text: req.body.text }]);
    const answer = prompts.length === 1 ? 'Read the shared desktop original.' : `Snapshot answer ${prompts.length}.`;
    const finish = () => { sessions.get(id).push({ id: n + 2, type: 'result', success: true, text: answer }); finishReply = null; };
    if (holdReply) { holdReply = false; finishReply = finish; } else finish();
    res.status(202).json({ sessionId: id });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
const api = app.listen(0, '127.0.0.1'); await new Promise(resolve => api.once('listening', resolve));
const endpoint = `http://127.0.0.1:${api.address().port}`; process.env.PAGEBORNE_ASK_ORIGINS = endpoint;
const vite = await createServer({ cacheDir: `.state/vite-sync-${useWebkit ? 'webkit' : 'chrome'}`, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, clearScreen: false }); await vite.listen();
const browser = await (useWebkit ? webkit : chromium).launch({ executablePath: useWebkit ? process.env.WEBKIT_PATH : '/usr/bin/google-chrome', headless: true });
const result = { passed: false, errors: [], physicalGlasses: false, actualAgents: false }; let page;
try {
  for (const route of ['library', 'library/read', 'library/commit', 'library/remove', 'files/status']) {
    assert.equal((await fetch(endpoint + '/api/pageborne/' + route, { method: route === 'library' ? 'GET' : 'POST' })).status, 401);
  }
  await writeFile(path.join(libraryDir, 'desktop.md'), '# Desktop\n\nOriginal shared text.');
  await writeFile(path.join(libraryDir, 'figure.pdf'), pdfFixture());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const storage = new Map();
  await context.exposeFunction('__storage', ({ method, data }) => {
    if (method === 'getLocalStorage' && /^pageborne:models:v1:[a-f0-9]{64}$/.test(data.key)) return JSON.stringify({ id: 'fixture', chunks: 1, headers: {} });
    return method === 'getLocalStorage' ? storage.get(data.key) || '' : (storage.set(data.key, data.value), true);
  });
  await context.addInitScript(({ endpoint }) => {
    if (!localStorage.getItem('even-reader:preferences:v1')) localStorage.setItem('even-reader:preferences:v1', JSON.stringify({ ask: { mode: 'terminal', endpoint, token: 'fixture-token', agent: 'codex' } }));
    window.__microphones = 0; window.__body = ''; window.__status = ''; window.__footer = {};
    const NativeWorker = Worker;
    window.Worker = class {
      constructor(url, options) { if (!String(url).includes('ensemble-worker')) return new NativeWorker(url, options); }
      postMessage(data) { if (data.operation === 'prepare') queueMicrotask(() => this.onmessage?.({ data: { id: data.id, result: { model: data.model, backend: data.backend, verified: true } } })); }
      terminate() {}
    };
    window.flutter_inappwebview = { async callHandler(_, payload) {
      const message = JSON.parse(payload);
      if (message.method.endsWith('LocalStorage')) return window.__storage(message);
      if (message.method === 'audioControl') window.__microphones++;
      const texts = message.method === 'textContainerUpgrade' ? [message.data] : message.data?.textObject || [];
      for (const text of texts) { if (text.containerName === 'body') window.__body = text.content; if (['status', 'commands'].includes(text.containerName)) window.__footer[text.containerName] = text.content; }
      window.__status = [window.__footer.status, window.__footer.commands].join(' ');
      return ['createStartUpPageContainer', 'updateImageRawData'].includes(message.method) ? 0 : true;
    } };
  }, { endpoint });
  page = await context.newPage(); page.on('pageerror', error => result.errors.push(error.message));
  await page.goto(vite.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.__status)).toContain('Hold to sync');
  await page.locator('#file-picker').setInputFiles({ name: 'phone.txt', mimeType: 'text/plain', buffer: Buffer.from('Uploaded from phone.') });
  await expect(page.locator('[data-document-id="phone.txt"]')).toBeVisible();
  const event = eventType => page.evaluate(eventType => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { sysEvent: { eventType } } })), eventType);
  await event(9); await event(10);
  await expect(page.locator('#library-sync-status')).toContainText('Synced ', { timeout: 30000 });
  await expect(page.locator('#doc-count')).toHaveText('3'); assert.equal(await page.evaluate(() => window.__microphones), 0);
  assert.equal(await readFile(path.join(libraryDir, 'phone.txt'), 'utf8'), 'Uploaded from phone.');
  await expect.poll(() => page.evaluate(() => window.__status)).toMatch(/Library synced\s+Tap to open · Hold to sync/);
  result.glassesHold = true;
  manifestFixture = { version: 1, id: 'capacity-fixture', directory: '/fixture', files: Array.from({ length: 5 }, (_, i) => ({
    name: `${i}.pdf`, bytes: 16 * 1024 * 1024, sha256: 'a'.repeat(64),
  })) };
  const beforeCapacity = manifestCalls;
  await page.locator('#library-sync').click();
  await expect(page.locator('#library-sync-status')).toContainText('phone limit is 64 MiB');
  await expect.poll(() => page.evaluate(() => window.__status)).toContain('Library full; see phone');
  assert.equal(manifestCalls - beforeCapacity, 1, 'capacity failure must not transfer or delete files');
  await expect(page.locator('#doc-count')).toHaveText('3');
  manifestFixture = null;
  await page.locator('#library-sync').click();
  await expect(page.locator('#library-sync-status')).toContainText('Synced ');
  result.capacityFailureKeepsLibrary = true;
  await page.screenshot({ path: path.join(out, 'synced-phone.png') });
  await writeFile(path.join(libraryDir, 'desktop.md'), '# Desktop revised\n\nUpdated shared text.');
  await page.locator('#library-sync').click(); await expect(page.locator('#library-sync-status')).toContainText('Synced ');
  await page.locator('[data-document-id="desktop.md"] .document-card').click();
  await expect(page.locator('#title')).toHaveText('Desktop revised');
  await page.locator('#ask-open').click(); await page.locator('#ask-question').fill('Read the original file.'); await page.locator('#ask-send').click();
  await expect(page.locator('#ask-answer')).toContainText('Read the shared desktop original.', { timeout: 20000 });
  assert.equal(prompts.length, 1); result.askUsesLibrary = true;
  // Keep the reader on its existing version while desktop edits before and
  // during the next reply. Both prompts must stay in the same native session.
  const first = prompts[0];
  await writeFile(path.join(libraryDir, 'desktop.md'), '# Desktop newest\n\nChanged before asking.');
  holdReply = true;
  await page.locator('#ask-question').fill('Continue despite the desktop edit.'); await page.locator('#ask-send').click();
  await expect.poll(() => prompts.length).toBe(2);
  assert.equal(prompts[1].id, first.id); assert.equal(prompts[1].original, first.original); assert.equal(prompts[1].announced, false);
  await writeFile(path.join(libraryDir, 'desktop.md'), '# Desktop newest\n\nChanged during the reply.');
  assert.equal(await readFile(first.original, 'utf8'), expectedOriginal);
  finishReply(); await expect(page.locator('#ask-answer')).toContainText('Snapshot answer 2.');
  await backToReading(page); await showLibrary(page);
  await page.locator('#library-sync').click(); await expect(page.locator('#library-sync-status')).toContainText('1 received');
  assert.equal(await readFile(path.join(libraryDir, 'desktop.md'), 'utf8'), '# Desktop newest\n\nChanged during the reply.');
  await page.locator('[data-document-id="desktop.md"] .document-card').click();
  await expect(page.locator('#title')).toHaveText('Desktop newest');
  await page.locator('#ask-open').click();
  expectedOriginal = '# Desktop newest\n\nChanged during the reply.';
  await page.locator('#ask-question').fill('Now explain the newer version.'); await page.locator('#ask-send').click();
  await expect(page.locator('#ask-answer')).toContainText('Snapshot answer 3.');
  assert.equal(prompts[2].id, first.id); assert.notEqual(prompts[2].original, first.original); assert.equal(prompts[2].announced, true);
  assert.equal(await readFile(first.original, 'utf8'), '# Desktop revised\n\nUpdated shared text.');
  await expect(page.locator('#ask-messages')).toContainText('Read the shared desktop original.');
  await expect(page.locator('#ask-messages')).toContainText('Snapshot answer 2.');
  result.desktopEditBeforeAsk = true; result.desktopEditDuringReply = true; result.sameSessionAfterSync = true;
  await backToReading(page); await showLibrary(page);
  await page.locator('[data-document-id="phone.txt"] .document-delete').click();
  await expect(page.locator('.delete-question')).toContainText('Next sync');
  await page.locator('[data-confirm-delete="phone.txt"]').click(); await expect(page.locator('[data-document-id="phone.txt"]')).toHaveCount(0);
  await rm(path.join(libraryDir, 'figure.pdf'));
  await page.locator('#library-sync').click(); await expect(page.locator('#library-sync-status')).toContainText('2 deleted');
  await expect(page.locator('#doc-count')).toHaveText('1'); assert(!(await readdir(libraryDir)).includes('phone.txt'));
  await page.reload(); await expect(page.locator('#import')).toBeEnabled(); await showLibrary(page);
  await page.locator('#library-sync').click(); await expect(page.locator('#library-sync-status')).toContainText('0 received');
  await expect(page.locator('#doc-count')).toHaveText('1'); result.persistedDeletions = true;
  // Leave/cancel a real HTTP download, then resume it without duplicate files.
  await writeFile(path.join(libraryDir, 'cancel.md'), '# Retry\n\n' + 'Large text. '.repeat(80000));
  blockRead = true; releaseRead = null; await page.locator('#library-sync').click();
  await expect.poll(() => !!releaseRead).toBe(true); await page.locator('#library-sync-cancel').click();
  await expect(page.locator('#library-sync-status')).toContainText('Sync cancelled'); releaseRead();
  await page.locator('#library-sync').click(); await expect(page.locator('#library-sync-status')).toContainText('Synced ', { timeout: 30000 });
  await expect(page.locator('[data-document-id="cancel.md"]')).toHaveCount(1); result.cancelResume = true;
  await page.locator('#library-close').click();
  await event(3); await expect.poll(() => page.evaluate(() => window.__status)).toContain('Hold to sync');
  const callsBeforeHold = manifestCalls;
  await event(9); await event(9); await event(10); // Repeated hold events still start only one run.
  await expect(page.locator('#library-sync-status')).toContainText('Synced ');
  assert.equal(manifestCalls - callsBeforeHold, 1);
  assert.equal(await page.evaluate(() => window.__microphones), 0);
  const preview = await page.locator('#preview').evaluate(canvas => canvas.toDataURL('image/png'));
  await writeFile(path.join(out, 'glasses-preview.png'), Buffer.from(preview.split(',')[1], 'base64'));
  await page.locator('#library-close').click();
  await page.screenshot({ path: path.join(out, 'picker-hold.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(result.errors, []); result.passed = true; result.manifestAndTransferRequests = manifestCalls;
  await context.close();
} catch (error) { result.failure = error.stack; await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); throw error; }
finally {
  releaseRead?.(); await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
  await browser.close(); await vite.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); await rm(libraryDir, { recursive: true, force: true });
}
console.log(JSON.stringify(result));
