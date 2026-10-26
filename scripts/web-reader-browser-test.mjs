import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'vite';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { installLibrarySync } from '../integrations/even-terminal/pageborne-library.js';
import { installReaderState, createReaderState } from '../integrations/even-terminal/pageborne-reader-state.js';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';
import { displayProbe } from './display-probe.mjs';
import { createWebApp } from '../server/web-app.js';
import { displayQuestion } from '../integrations/even-terminal/pageborne-conversation.js';
const root = await mkdtemp(path.join(tmpdir(), 'web-reader-'));
const libraryDir = path.join(root, 'library'); await mkdir(libraryDir);
const options = { libraryDir, stateDir: path.join(root, 'state') };
await writeFile(path.join(libraryDir, 'paper.md'), '# Reading on a smaller screen\n\nA **formatted** introduction with [a safe link](https://example.com).\n\n' + Array.from({ length: 25 }, (_, i) => `## Chapter ${i+1}\n\n` + 'A long paragraph about reading and understanding complicated ideas. '.repeat(12)).join('\n\n') + '\n\n<script>window.unsafeMarkdown = true</script>');
await writeFile(path.join(libraryDir, 'original.pdf'), pdfFixture());
const store = createReaderState(options);
await store.update({ document: 'paper.md', agent: 'codex', sessionId: 'shared-paper', anchors: [{ id: 'question-1', aliases: [], position: 60 }] });
await store.update({ document: 'original.pdf', agent: 'codex', sessionId: 'shared-pdf', anchors: [{ id: 'question-1', aliases: [], position: 60, page: 2 }] });
const app = express(); app.use(express.json({ limit: '2mb' }));
const api = express.Router(); installLibrarySync(api, options); installReaderState(api, options);
let turns = [{ id: 'question-1', question: 'What is the main idea?', answer: 'The answer from the existing desktop session.', state: 'complete' }];
turns[0].activities = [{ id: 'thinking', kind: 'thinking', text: 'Checking the relevant passage.', state: 'complete' },
 { id: 'tool', kind: 'tool', text: 'Read paper.md and inspect the document using this command with a longer description that needs truncation…', state: 'complete' }];
let busy = false, prompts = [], messages = [];
api.get('/info', (_req,res) => res.json({ pageborne: { conversationSync: 1, librarySync: 1 } }));
api.get('/pageborne/conversation', (req,res) => res.json({ version: 1, sessionId: req.query.sessionId, state: busy ? 'busy' : 'idle', turns }));
api.get('/events', (req,res) => { res.setHeader('Content-Type','text/event-stream'); res.write(': connected\n\n'); const timer = setInterval(() => res.write(': ping\n\n'), 1000); req.on('close', () => clearInterval(timer)); });
api.get('/sessions/history', (_req,res) => res.json({ sessions: [] }));
api.get('/sessions/:id/history', (_req,res) => res.json({ history: [] }));
api.get('/messages', (_req,res) => res.json({ state: busy ? 'busy' : 'idle', messages }));
api.post('/prompt', (req,res) => {
 const parsed = displayQuestion(req.body.text); prompts.push(req.body); busy = true;
 messages.push({ id: messages.length + 1, type: 'user_prompt', text: req.body.text });
 turns.push({ id: parsed.marker, ...parsed, answer: '', state: 'pending' });
 res.json({ sessionId: req.body.sessionId });
});
app.use('/api', api);
const backend = app.listen(0,'127.0.0.1'); await new Promise(r => backend.once('listening',r));
const built = !!process.env.WEB_BUILT;
const vite = built ? null : await createServer({ mode: 'web', plugins: [displayProbe(), { name: 'web-fixture', transform(code,id) {
 if (id.endsWith('/src/web-pdf.js')) return code.replace('this.port = new PdfWorker();', `window.__pdfSteps = ['worker']; this.port = new PdfWorker(); this.port.addEventListener('message', e => window.__pdfSteps.push(e.data.action || 'message'));`)
 .replace('this.pdf = await Promise.race', `window.__pdfSteps.push('document'); this.pdf = await Promise.race`)
 .replace('const blocks = [];', `window.__pdfSteps.push('loaded'); const blocks = [];`)
 .replace('await this.text(1);', `window.__pdfSteps.push('text'); await this.text(1); window.__pdfSteps.push('done');`);
 }, configureServer(server) { server.middlewares.use('/web/config', (req,res) => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ mode: 'terminal', endpoint: `http://${req.headers.host}`, token: 'fixture', agent: 'claude' })); }); } }], cacheDir: '.state/vite-web-test', server: { host:'127.0.0.1', port:0, hmr:false, proxy: { '/api': `http://127.0.0.1:${backend.address().port}` } }, clearScreen: false });
await vite?.listen();
let production;
if (built) { production = createWebApp({ distDir: path.resolve(process.env.WEB_DIST || 'dist-web'), upstream: `http://127.0.0.1:${backend.address().port}`, upstreamToken: 'fixture', allowLocal: true }).listen(0, '127.0.0.1'); await new Promise(r => production.once('listening', r)); }
const baseUrl = production ? `http://127.0.0.1:${production.address().port}` : vite.resolvedUrls.local[0];
await mkdir('test-results/web-reader', { recursive: true });
const results = [];
try {
 for (const engine of (process.env.WEBKIT_ONLY ? [webkit] : [chromium, webkit])) {
  const browser = await engine.launch({ executablePath: engine === chromium ? '/usr/bin/google-chrome' : process.env.WEBKIT_PATH, headless: true });
  try { for (const viewport of [{ width:393,height:852 },{ width:834,height:1194 }]) {
   const page = await browser.newPage({ viewport }); const errors=[]; page.on('pageerror',e=>errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') console.error('browser:', m.text().slice(0,500)); });
   let startupAttempts = 0; const codeResponses = [];
   if (built) {
    // A dropped cellular request must recover without asking the user to clear
    // Safari's caches. Do this against the actual bundled entry and compressed server.
    await page.route(/\/assets\/main-[\w-]+\.js$/, async route => { if (++startupAttempts === 1) await route.abort('failed'); else await route.continue(); });
    page.on('response', response => { if (/\/assets\/.*\.(js|css)$/.test(response.url()) && response.status() === 200) codeResponses.push(response); });
   }
   try {
    await page.goto(baseUrl, { waitUntil: 'commit', timeout: 30000 });
    await expect(page.locator('[data-document-id="paper.md"]')).toBeAttached({ timeout:30000 });
    if (built) {
     assert.equal(startupAttempts, 2);
     assert.equal(await page.locator('link[rel="modulepreload"]').count(), 0);
     const sizes = await Promise.all(codeResponses.map(async r => Number((await r.allHeaders())['content-length'] || 0)));
     assert.ok(sizes.reduce((sum, n) => sum + n, 0) < 1_000_000, `Startup download: ${sizes}`);
     assert.ok(codeResponses.every(r => !/\/(?:web-pdf|pdf)-/.test(new URL(r.url()).pathname)));
    }
    if (await page.locator('#library-panel').getAttribute('data-open') !== 'true') await page.locator('#library-toggle').click();
    await page.locator('[data-document-id="paper.md"] .document-card').click();
    await expect(page.locator('.web-prose strong')).toHaveText('formatted');
    assert.equal(await page.evaluate(()=>window.unsafeMarkdown), undefined);
    await expect(page.locator('#web-nearby')).toBeVisible({ timeout:15000 });
    await page.screenshot({path:`test-results/web-reader/${engine.name()}-${viewport.width}-reader.png`});
    await page.locator('#web-nearby').click();
    await expect(page.locator('#web-chat-dialog')).toBeVisible();
    await expect(page.locator('.ask-message-activity')).toHaveCount(1);
    await expect(page.locator('#ask-messages')).not.toContainText('Checking the relevant passage.');
    const action = await page.locator('.ask-message-activity .ask-message-text').evaluate(el => ({
      height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight),
      overflow: getComputedStyle(el).textOverflow, width: el.clientWidth, contentWidth: el.scrollWidth }));
    assert(action.height <= action.line + 1); assert.equal(action.overflow, 'ellipsis');
    assert(action.contentWidth > action.width);
    assert.notEqual(await page.locator('.ask-message-activity').first().evaluate(el => getComputedStyle(el).color),
      await page.locator('.ask-message-assistant').first().evaluate(el => getComputedStyle(el).color));
    await expect(page.locator('#ask-messages')).toContainText('existing desktop session');
    await expect(page.locator('#ask-chat-model')).toHaveValue('codex');
    await page.screenshot({path:`test-results/web-reader/${engine.name()}-${viewport.width}-chat.png`});
    await page.getByRole('button',{name:/^Go to the passage/}).first().click();
    await expect(page.locator('#web-chat-dialog')).not.toBeVisible();
    assert.ok(await page.locator('#web-document').evaluate(el=>el.scrollTop)>1000);
    await page.locator('#web-chat').click();
    turns = [...turns,{id:'external',question:'Sent elsewhere',answer:'A synchronized reply.',state:'complete'}];
    if (!built) await page.evaluate(()=>window.__askUI.pollFooter());
    await expect(page.locator('#ask-messages')).toContainText('Sent elsewhere');
    await store.update({ document: 'paper.md', agent: 'codex', sessionId: 'shared-paper', anchors: [{ id: 'external', aliases: [], position: 40 }] });
    await expect(page.getByRole('button', { name: /^Go to the passage/ })).toHaveCount(2, { timeout: 15000 });
    await page.locator('#ask-question').fill('Web first question'); await page.locator('#ask-send').click();
    await expect.poll(() => prompts.length).toBe(1);
    await page.locator('#ask-question').fill('Web follow-up while busy'); await expect(page.locator('#ask-send')).toBeEnabled(); await page.locator('#ask-send').click();
    await expect.poll(() => prompts.length).toBe(2);
    assert(prompts.every(p => p.sessionId === 'shared-paper'));
    await page.locator('#web-chat-close').click(); await expect(page.locator('#web-speak')).toBeEnabled(); await page.locator('#web-chat').click();
    turns.at(-2).state = 'complete'; turns.at(-2).answer = 'First web answer';
    turns.at(-1).state = 'complete'; turns.at(-1).answer = 'Second web answer'; busy = false;
    await expect(page.locator('#ask-messages')).toContainText('First web answer'); await expect(page.locator('#ask-answer')).toHaveText('Second web answer');
    assert(!await page.locator('#ask-messages').innerText().then(t => t.includes('Pageborne question')));
    await page.locator('#web-chat-close').click();
    await page.locator('#library-toggle').click();
    await page.locator('[data-document-id="original.pdf"] .document-card').click();
    await expect(page.locator('.web-pdf-page')).toHaveCount(2,{timeout:30000});
    await expect.poll(()=>page.locator('.web-pdf-page canvas').first().evaluate(c=>c.width)).toBeGreaterThan(100);
    await expect(page.locator('#web-nearby')).toBeVisible({timeout:15000});
    await page.locator('#web-nearby').click();
    await page.getByRole('button',{name:/^Go to the passage/}).first().click();
    await expect(page.locator('#web-page-label')).toHaveText('Page 2 of 2');
    await expect(page.locator('.web-pdf-page[data-page="2"]')).toHaveAttribute('data-rendered', /[0-9]+/, {timeout: 30000});
    await page.screenshot({path:`test-results/web-reader/${engine.name()}-${viewport.width}-pdf.png`});
    if (!built) {
    await page.evaluate(() => {
      window.__voiceCalls = []; const ask = window.__askUI;
      window.__voiceOriginal = { hold: ask.hold, release: ask.release };
      ask.hold = async source => { window.__voiceCalls.push(['hold', source]); };
      ask.release = async () => { window.__voiceCalls.push(['release']); };
    });
    const mic = await page.locator('#web-speak').boundingBox();
    await page.mouse.move(mic.x+mic.width/2,mic.y+mic.height/2); await page.mouse.down();
    await expect(page.locator('#web-speak')).toHaveClass(/recording/);
    await page.mouse.up();
    await expect(page.locator('#web-chat-dialog')).toBeVisible();
    assert.deepEqual(await page.evaluate(()=>window.__voiceCalls), [['hold','phone'],['release']]);
    await page.evaluate(() => Object.assign(window.__askUI, window.__voiceOriginal));
    } else await page.locator('#web-chat').click();
    await page.locator('#ask-question').focus();
    await page.evaluate(() => {
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: Object.assign(new EventTarget(), { height: 400, width: innerWidth, offsetTop: 0, offsetLeft: 0, scale: 1 }) });
      window.dispatchEvent(new Event('resize'));
    });
    const form = await page.locator('#ask-form').boundingBox(); assert.ok(form.y+form.height <= 401, JSON.stringify(form));
    await page.screenshot({path:`test-results/web-reader/${engine.name()}-${viewport.width}-keyboard.png`});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(errors,[]);
    results.push({browser:engine.name(),width:viewport.width,passed:true});
   } catch(error) { await page.screenshot({path:`test-results/web-reader/${engine.name()}-${viewport.width}-failure.png`}); console.error({errors, pdfSteps: await page.evaluate(()=>window.__pdfSteps), text: (await page.locator('body').innerText()).slice(-1600)}); throw error; }
   finally { await page.close(); turns=turns.slice(0,1); busy=false; prompts=[]; messages=[]; }
  }} finally { await browser.close(); }
 }
 console.log(JSON.stringify(results,null,2));
} finally { await vite?.close(); production?.closeAllConnections(); production?.close(); backend.closeAllConnections(); backend.close(); await rm(root,{recursive:true,force:true}); }
