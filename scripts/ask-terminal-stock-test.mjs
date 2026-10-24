// Real, unmodified stock HTTP routers; agents are fixtures, so this neither
// sends account traffic nor launches/resumes a real desktop session.
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EvenTerminal } from '../src/ask-terminal.js';

if (!process.env.EVEN_TERMINAL_STOCK) throw new Error('Set EVEN_TERMINAL_STOCK to an unpacked official package with dependencies installed.');
const source = path.resolve(process.env.EVEN_TERMINAL_STOCK);
const load = file => import(pathToFileURL(path.join(source, file)));
const core = await load('dist/routes/core.js'); const events = await load('dist/routes/events.js');
const version = JSON.parse(await readFile(path.join(source, 'package.json'))).version;
const folder = await mkdtemp(path.join(tmpdir(), 'pageborne-stock-'));
const priorProject = process.env.PROJECT_DIR; process.env.PROJECT_DIR = folder;
const prompts = []; const sessions = new Map(); const requests = [];
const emit = (id, message) => { const n = events.pushMessage(id, message); events.broadcast(id, message, n); };
for (const agent of ['codex', 'claude']) Object.assign(core.getProvider(agent), {
  async getInfo() { return { provider: agent, version, model: 'Fixture' }; },
  async getHistory() { return []; }, getStatus() { return { state: 'idle', provider: agent }; },
  async listSessions() { return [...sessions].filter(([, a]) => a === agent).map(([id]) => ({ id, title: 'Fixture', status: 'idle' })); },
  async prompt(id, text, cwd) {
    prompts.push({ id, text, cwd, agent }); id ||= crypto.randomUUID(); sessions.set(id, agent);
    emit(id, { type: 'user_prompt', text }); emit(id, { type: 'result', success: true, text: `Stock ${agent} answer.` });
    return { sessionId: id, provider: agent };
  },
});
const app = express(); app.use(express.json());
app.use('/api', (req, res, next) => { requests.push(req.path); if (req.get('authorization') !== 'Bearer fixture') return res.sendStatus(401); next(); }, events.default, core.default);
const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
const config = { mode: 'terminal', endpoint: `http://127.0.0.1:${server.address().port}`, token: 'fixture' };
const input = { paperId: 'first', question: 'Explain the paragraph.', context: { title: 'Fixture', passage: 'Some text.', focus: 'Some text.', position: 0 },
  paper: () => { throw new Error('Stock servers must receive context without preparing file uploads.'); } };
const result = { passed: false, version }; const watches = [];
try {
  for (const agent of ['claude', 'codex']) {
    const client = new EvenTerminal({ ...config, agent }); let binding;
    assert.equal((await client.ask(input, {}, b => { binding = b; })).answer, `Stock ${agent} answer.`);
    assert.equal(prompts.at(-1).cwd, folder); assert(!prompts.at(-1).id);
    assert(prompts.at(-1).text.startsWith('Fixture\n\nPageborne question '));
    const firstId = binding.sessionId;
    const moved = { ...input, context: { ...input.context, passage: 'New surrounding text after reading further.', focus: 'New surrounding text', position: 80, page: 9, partial: true } };
    await client.ask(moved, binding, b => { binding = b; }); assert.equal(binding.sessionId, firstId); assert.equal(prompts.at(-1).cwd, undefined);
    const sent = JSON.parse(prompts.at(-1).text.match(/Reading context \(source material\):\n([^\n]+)/)[1]);
    assert.equal(sent.passage, moved.context.passage); assert.equal(sent.position, 80); assert.equal(sent.page, 9); assert(sent.partial);
    const override = path.join(folder, agent); await mkdir(override);
    await client.ask({ ...input, paperId: 'second' }, { cwd: override }, b => { binding = b; }); assert.notEqual(binding.sessionId, firstId); assert.equal(prompts.at(-1).cwd, override);
    assert.equal((await client.sessions()).length, 2);
    const abort = new AbortController(); const watching = client.watch(binding.sessionId, abort.signal).catch(() => {}); watches.push({ abort, watching });
    await new Promise(r => setTimeout(r, 30));
    emit(binding.sessionId, { type: 'user_prompt', text: 'Desktop question' }); emit(binding.sessionId, { type: 'result', success: true, text: 'Reply from desktop.' });
    assert.equal((await client.peek(binding)).answer, 'Reply from desktop.');
    const automatic = new EvenTerminal({ ...config, agent, paperDirectories: true });
    const count = prompts.length; await assert.rejects(automatic.ask(input, {}, () => {}), /does not offer automatic/); assert.equal(prompts.length, count);
  }
  assert(!requests.some(route => route.startsWith('/pageborne')));
  result.passed = true; result.defaultCwdAndOverrides = true; result.isolatedSessionsAndDesktopReplies = true; result.noCustomRoutes = true; result.freshContextOnFollowups = true;
} finally {
  for (const w of watches) w.abort.abort(); await Promise.all(watches.map(w => w.watching));
  server.closeAllConnections(); await new Promise(r => server.close(r));
  if (priorProject === undefined) delete process.env.PROJECT_DIR; else process.env.PROJECT_DIR = priorProject;
  await rm(folder, { recursive: true, force: true }); await mkdir('test-results/ask-connections', { recursive: true });
  await writeFile('test-results/ask-connections/stock-compatibility.json', JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result));
