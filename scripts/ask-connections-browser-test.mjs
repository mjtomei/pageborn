import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'vite';
import { installPaperWorkspaces } from '../integrations/even-terminal/pageborne-workspaces.js';
import { showLibrary, showTool, hideSettings, backToReading } from './ui-helpers.mjs';

const dir = path.resolve('test-results/ask-connections'); await mkdir(dir, { recursive: true });
let foldersEnabled = false; let folderRequests = 0;
const apiRequests = []; const prompts = []; const sessions = new Map(); let serial = 0; let delayPost = false; let releasePost;
const app = express();
app.use((_req, res, next) => { res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }); next(); });
app.options('/{*path}', (_req, res) => res.sendStatus(204)); app.use(express.json());
app.use((req, res, next) => { if (req.get('authorization') !== 'Bearer test-key') return res.sendStatus(401); next(); });
app.get('/v1/models', (_req, res) => res.json({ data: [{ id: 'test-model' }] }));
app.post('/v1/chat/completions', (req, res) => { apiRequests.push(req.body); res.json({ choices: [{ message: { content: 'Direct provider answer.' } }] }); });
app.get('/api/events', (req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.flushHeaders(); res.write(':connected\n\n'); const timer = setInterval(() => res.write(':heartbeat\n\n'), 1000); res.on('close', () => clearInterval(timer)); });
app.get('/api/info', (req, res) => res.json({ provider: req.query.provider, model: 'desktop-selected-model', ...(foldersEnabled ? { pageborne: { workspaces: 1 } } : {}) }));
const folderRouter = express.Router(); folderRouter.use((_req, _res, next) => { if (_req.path === '/pageborne/workspace') folderRequests++; next(); }); installPaperWorkspaces(folderRouter); app.use('/api', folderRouter);
app.get('/api/sessions', (req, res) => res.json({ sessions: [{ id: 'configured-session', title: 'Paper discussion · custom desktop settings', status: 'idle' }, ...[...sessions].filter(([, s]) => s.provider === req.query.provider).map(([id]) => ({ id, title: `Paper ${id}`, status: 'idle' }))] }));
app.get('/api/sessions/:id/history', (_req, res) => res.json({ history: [] }));
app.get('/api/messages', (req, res) => {
  const s = sessions.get(req.query.sessionId) || { messages: [] };
  res.json({ state: 'idle', messages: s.messages.filter(m => m.id > Number(req.query.after || 0)) });
});
app.post('/api/prompt', async (req, res) => {
  if (req.body.cwd) await access(req.body.cwd);
  prompts.push(req.body); const id = req.body.sessionId || `paper-session-${++serial}`;
  const old = sessions.get(id)?.messages || []; const n = old.at(-1)?.id || 0;
  sessions.set(id, { provider: req.body.provider, messages: [...old, { id: n + 1, type: 'user_prompt', text: req.body.text }, { id: n + 2, type: 'result', success: true, text: `Desktop answer from ${id}.` }] });
  if (delayPost) await new Promise(r => { releasePost = r; });
  res.status(202).json({ sessionId: id, provider: req.body.provider });
});
const api = app.listen(0, '127.0.0.1'); await new Promise(r => api.once('listening', r));
const endpoint = `http://127.0.0.1:${api.address().port}`;
const desktopHome = await mkdtemp(path.join(os.tmpdir(), 'pageborne-desktop-browser-'));
process.env.PAGEBORNE_ASK_ORIGINS = endpoint;
const vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, clearScreen: false }); await vite.listen();
const cache = path.join(os.homedir(), '.cache/ms-playwright');
const candidates = [process.env.CHROME_PATH, chromium.executablePath(), ...(await readdir(cache)).filter(n => /^chromium-\d+$/.test(n)).flatMap(n => [path.join(cache, n, 'chrome-linux/chrome'), path.join(cache, n, 'chrome-linux64/chrome')])].filter(Boolean);
const executablePath = (await Promise.all(candidates.map(async f => { try { await access(f); return f; } catch { return null; } }))).find(Boolean);
const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); const result = { passed: false, errors: [] };
page.on('pageerror', e => result.errors.push(e.message)); const storage = new Map();
await page.exposeFunction('__storage', ({ method, data }) => { if (method === 'getLocalStorage') return storage.get(data.key) || ''; storage.set(data.key, data.value); return true; });
await page.addInitScript(() => {
  window.__body = ''; window.flutter_inappwebview = { async callHandler(_name, serialized) {
    const m = JSON.parse(serialized); if (m.method.endsWith('LocalStorage')) return window.__storage(m);
    if (['createStartUpPageContainer', 'rebuildPageContainer'].includes(m.method)) { window.__body = m.data.textObject.find(t => t.containerName === 'body')?.content || ''; return m.method === 'createStartUpPageContainer' ? 0 : true; }
    if (m.method === 'textContainerUpgrade' && m.data.containerName === 'body') window.__body = m.data.content;
    return m.method === 'updateImageRawData' ? 0 : true;
  } };
});
const open = async file => { await showLibrary(page); await page.locator(`[data-document-id="${file}"] .document-card`).click(); await expect(page.locator('#ask-open')).toBeEnabled(); };
const ask = async (question, answer) => { if (!await page.locator('#ask-panel').isVisible()) await page.locator('#ask-open').click(); await page.locator('#ask-question').fill(question); await page.locator('#ask-send').click(); await expect(page.locator('#ask-answer')).toContainText(answer); };
try {
  await page.goto(vite.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled(); await expect(page.locator('#connection-state')).toHaveText('Connected');
  await page.locator('#file-picker').setInputFiles(['one.md', 'two.md'].map(name => ({ name, mimeType: 'text/markdown', buffer: Buffer.from('# Same title\n\n' + `${name}: the argument in this document. `.repeat(100)) })));
  await expect(page.locator('#doc-count')).toHaveText('2'); await open('one.md');
  await showTool(page, 'settings'); await expect(page.locator('#ask-mode')).toHaveValue('provider');
  await page.locator('#ask-provider-url').fill(endpoint + '/v1'); await page.locator('#ask-model').fill('test-model'); await page.locator('#ask-api-key').fill('test-key'); await page.locator('#ask-config-save').click();
  await expect(page.locator('#ask-config-status')).toContainText('Saved for all documents'); assert.equal(apiRequests.length, 0);
  await page.screenshot({ path: path.join(dir, 'provider-settings.png'), fullPage: true }); await hideSettings(page);
  await ask('Direct question on paper one', 'Direct provider answer.'); assert.equal(apiRequests.at(-1).messages.length, 3);
  await backToReading(page); await ask('Followup after closing Ask', 'Direct provider answer.');
  assert.equal(apiRequests.at(-1).messages.length, 5); await open('two.md'); await ask('Different paper', 'Direct provider answer.'); assert.equal(apiRequests.at(-1).messages.length, 3);
  result.directProviderAndIsolatedHistory = true;
  await showTool(page, 'settings'); await page.locator('#ask-mode').selectOption('terminal'); await page.locator('#ask-endpoint').fill(endpoint + '/api'); await page.locator('#ask-token').fill('test-key'); await page.locator('#ask-agent').selectOption('codex'); await expect(page.locator('#ask-cwd')).toHaveValue(''); await page.locator('#ask-cwd').fill(desktopHome); await page.locator('#ask-config-save').click();
  await expect(page.locator('#ask-config-status')).toContainText('Saved for all documents'); assert.equal(prompts.length, 0);
  await page.screenshot({ path: path.join(dir, 'desktop-settings.png'), fullPage: true }); await hideSettings(page);
  await open('one.md'); await ask('First desktop question', 'paper-session-1'); assert.equal(prompts[0].cwd, desktopHome); assert(!prompts[0].sessionId);
  assert(prompts[0].text.startsWith('Same title\n\nPageborne question ')); assert(!('sessionTitle' in prompts[0]));
  await expect(page.locator('#ask-session-label')).toContainText('codex · Same title');
  result.paperSessionTitle = true;
  await backToReading(page); await ask('Followup desktop question', 'paper-session-1'); assert.equal(prompts[1].sessionId, 'paper-session-1'); assert(!prompts[1].cwd);
  await open('two.md'); await page.locator('#ask-open').click(); await page.locator('.ask-details').evaluate(el => el.open = true); await page.locator('#ask-paper-session').evaluate(el => el.open = true); await page.locator('#ask-paper-cwd').fill(desktopHome + '/override'); await mkdir(desktopHome + '/override'); await ask('Second paper desktop question', 'paper-session-2'); assert(!prompts[2].sessionId); assert.equal(prompts[2].cwd, desktopHome + '/override'); assert.equal(folderRequests, 0);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await page.waitForTimeout(650); await page.reload(); await expect(page.locator('#import')).toBeEnabled();
  await open('one.md'); await ask('After WebView reload', 'paper-session-1'); assert.equal(prompts[3].sessionId, 'paper-session-1');
  result.perPaperSessionsAndReload = true;
  await page.locator('.ask-details').evaluate(el => el.open = true); await page.locator('#ask-paper-session summary').click(); await page.locator('#ask-sessions-refresh').click(); await expect(page.locator('#ask-session-choice option')).toHaveCount(4);
  await page.locator('#ask-session-choice').selectOption('paper-session-2'); await page.locator('#ask-session-use').click(); await expect(page.locator('#ask-session-label')).toContainText('another paper');
  await page.locator('#ask-session-choice').selectOption('configured-session'); await page.locator('#ask-session-use').click(); await ask('Use custom desktop options', 'configured-session'); assert.equal(prompts.at(-1).sessionId, 'configured-session');
  assert.deepEqual(Object.keys(prompts.at(-1)).sort(), ['provider', 'sessionId', 'text']);
  result.existingSessionAndCrossPaperGuard = true;
  // Change agents globally; each paper gets an independent Claude binding.
  await showTool(page, 'settings'); await page.locator('#ask-agent').selectOption('claude'); await page.locator('#ask-config-save').click(); await hideSettings(page);
  await ask('Claude question', 'paper-session-3'); assert.equal(prompts.at(-1).provider, 'claude'); assert(!prompts.at(-1).sessionId); assert.equal(prompts.at(-1).cwd, prompts[0].cwd); result.standardCwdOption = true;
  await open('two.md'); delayPost = true; await page.locator('#ask-open').click(); await page.locator('#ask-question').fill('Question that outlives the open panel'); await page.locator('#ask-send').click(); await expect.poll(() => !!releasePost).toBe(true);
  await open('one.md'); releasePost(); delayPost = false;
  await expect.poll(() => page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('even-reader:preferences:v1')).askSessions).some(b => b.sessionId === 'paper-session-4'))).toBe(true);
  const sent = prompts.length; await open('two.md'); await expect(page.locator('#ask-footer')).toHaveText('Ask · Unread reply', { timeout: 15000 }); await page.locator('#ask-footer').click(); await expect(page.locator('#ask-answer')).toContainText('paper-session-4'); assert.equal(prompts.length, sent);
  result.agentIsolationAndCancelledReplyRecovery = true;
  await backToReading(page);
  // Phone chat does not consume the glasses' unread cursor (0.8.56). Read the
  // short reply through the actual glasses menu/accepted-frame path instead.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { menuItemClickEvent: { itemID: 10 } } })));
  await expect(page.locator('#ask-footer')).toHaveText('Ask · No new replies');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { sysEvent: { eventType: 0 } } })));
  const external = sessions.get('paper-session-4'); const nextEvent = external.messages.at(-1).id + 1; external.messages.push({ id: nextEvent, type: 'user_prompt', text: 'Followup from desktop' }, { id: nextEvent + 1, type: 'result', success: true, text: 'New reply from a terminal conversation.' });
  await expect(page.locator('#ask-footer')).toHaveText('Ask · Unread reply', { timeout: 15000 });
  await expect.poll(() => page.evaluate(() => window.__body)).not.toContain('New reply from a terminal');
  await page.locator('#ask-footer').click(); await expect(page.locator('#ask-answer')).toContainText('New reply from a terminal conversation.'); assert.equal(prompts.length, sent); result.footerNotificationsAndDesktopReplies = true;
  await page.locator('.ask-details').evaluate(el => el.open = true); await page.locator('#ask-paper-session').evaluate(el => el.open = true); await page.screenshot({ path: path.join(dir, 'paper-session.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: path.join(dir, 'paper-session-dark.png'), fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const diagnostics = await page.evaluate(() => localStorage.getItem('even-reader:diagnostics:v1')); assert(!diagnostics.includes('test-key')); assert(!diagnostics.includes('Direct question'));
  await showTool(page, 'settings'); await page.locator('#ask-folders').check(); await page.locator('#ask-base-dir').fill(desktopHome + '/papers'); await page.locator('#ask-config-save').click();
  await expect(page.locator('#ask-config-status')).toContainText('Saved for all documents'); await hideSettings(page);
  await page.locator('#ask-open').click(); await page.locator('.ask-details').evaluate(el => el.open = true); await page.locator('#ask-paper-session').evaluate(el => el.open = true); await page.locator('#ask-session-new').click(); await page.locator('#ask-workspace').click();
  await expect(page.locator('#ask-session-label')).toContainText('does not offer automatic'); assert.equal(folderRequests, 0);
  foldersEnabled = true; await page.locator('#ask-workspace').click();
  await expect(page.locator('#ask-paper-cwd')).toHaveValue(/session-/); const prepared = await page.locator('#ask-paper-cwd').inputValue();
  await access(path.join(prepared, 'paper.json')); await ask('Use prepared folder', 'paper-session-5'); assert.equal(prompts.at(-1).cwd, prepared); assert.equal(folderRequests, 1);
  await page.locator('#ask-session-new').click(); await ask('Another session for the same paper', 'paper-session-6'); assert.notEqual(prompts.at(-1).cwd, prepared); assert.equal(path.dirname(prompts.at(-1).cwd), path.dirname(prepared));
  result.optionalCustomTerminalDirectories = true;
  await showTool(page, 'settings'); await page.locator('#ask-config-clear').click();
  assert.equal(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('even-reader:preferences:v1')).askSessions).length), 0);
  result.forgetConnectionAndPrivateDiagnostics = true; assert.deepEqual(result.errors, []); result.passed = true;
} catch (error) { result.failure = error.message; await page.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }); throw error; }
finally { await writeFile(path.join(dir, 'results.json'), JSON.stringify(result, null, 2)); await browser.close(); await vite.close(); api.closeAllConnections(); await new Promise(r => api.close(r)); await rm(desktopHome, { recursive: true, force: true }); }
console.log(JSON.stringify(result));
