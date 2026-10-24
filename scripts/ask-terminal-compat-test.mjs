// Runs Pageborne against the actual local fork's routers and native Claude
// adapter. Agent owners are simulated; no real account or session is used.
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm, access, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EvenTerminal } from '../src/ask-terminal.js';
import { paperFile } from '../src/ask-documents.js';

const fork = path.resolve(process.env.EVEN_TERMINAL_FORK || '..');
const load = file => import(pathToFileURL(path.join(fork, file)));
const core = await load('dist/routes/core.js'); const events = await load('dist/routes/events.js');
await core.codexProvider.close(); await core.claudeProvider.close();
const emit = (id, msg) => { const eventId = events.pushMessage(id, msg); events.broadcast(id, msg, eventId); };
const home = await mkdtemp(path.join(tmpdir(), 'pageborne-compat-')); let native;
process.env.PAGEBORNE_LIBRARY_DIR = path.join(home, 'library');
const codexSessions = new Map(); const cwdCalls = []; const titleCalls = [];
Object.assign(core.codexProvider, {
  async getInfo() { return { provider: 'codex', model: 'Fixture', version: '0.8.1-shared.1' }; },
  async getConversation(id) { return [{ id: `${id}:turn`, status: 'completed', items: [
    { id: 'mobile-user', type: 'userMessage', content: [{ type: 'text', text: 'Question from Codex mobile' }] },
    { id: 'mobile-answer', type: 'agentMessage', text: 'Answer from the shared session' },
  ] }]; },
  async attach() {}, getStatus: () => ({ state: 'idle', provider: 'codex' }),
  async getHistory() { return []; }, async listSessions() { return [...codexSessions].map(([id, title]) => ({ id, title: typeof title === 'string' ? title : 'Paper', status: 'idle' })); },
  async setSessionTitle(id, title) { titleCalls.push({ id, title }); codexSessions.set(id, title); },
  async prompt(id, text, cwd) {
    id ||= crypto.randomUUID(); if (cwd) { await access(cwd); cwdCalls.push(cwd); }
    if (!codexSessions.has(id)) codexSessions.set(id, true); emit(id, { type: 'user_prompt', text }); emit(id, { type: 'result', success: true, text: 'Codex fixture answer.' });
    return { sessionId: id, provider: 'codex' };
  },
});
const nativeEvents = []; const cloudId = 'cse_pageborneFixture';
const append = (type, text) => nativeEvents.push({ sequence_num: String(nativeEvents.length + 1), event_id: crypto.randomUUID(), payload: { uuid: crypto.randomUUID(), session_id: cloudId, type, message: { role: type, content: text } } });
append('user', 'Earlier desktop question'); append('assistant', 'Earlier desktop answer');
const metadata = { id: cloudId, title: 'Paper session', status: 'active', environment_kind: 'bridge', connection_status: 'connected', worker_status: 'idle', requires_action_details_list: [] };
const { createRemoteClaudeProvider } = await load('dist/claude/remote/provider.js');
native = createRemoteClaudeProvider(emit, { bindings: () => [], pollMs: 20, client: {
  async listSessions() { return [metadata]; }, async getSession() { return metadata; },
  async events(_id, { cursor, order = 'asc', limit = 200 } = {}) {
    let data = nativeEvents.filter(e => !cursor || (order === 'desc' ? BigInt(e.sequence_num) < BigInt(cursor) : BigInt(e.sequence_num) > BigInt(cursor)));
    if (order === 'desc') data = [...data].reverse(); return { data: data.slice(0, limit), next_cursor: null };
  },
  async send(_id, payload) { append('user', payload.message.content); append('assistant', 'Native Claude fixture answer, without a result event.'); return { results: [{}] }; }, close() {},
} });
Object.assign(core.claudeProvider, native);
const app = express(); app.use(express.json()); app.use('/api', (req, res, next) => req.get('authorization') === 'Bearer fork-token' ? next() : res.sendStatus(401), events.default, core.default);
const upstream = app.listen(0, '127.0.0.1'); await new Promise(r => upstream.once('listening', r));
const config = { mode: 'terminal', endpoint: `http://127.0.0.1:${upstream.address().port}`, token: 'fork-token', agent: 'codex', cwd: home };
const result = { passed: false, fork }; const watches = [];
try {
  const input = { paperId: 'test-paper', question: 'Explain the test passage.', context: { title: 'Fixture', passage: 'The test passage.' } };
  const codex = new EvenTerminal(config, { pollMs: 20 }); let binding;
  assert.equal((await codex.ask(input, {}, b => { binding = b; })).answer, 'Codex fixture answer.');
  const id = binding.sessionId; await codex.ask(input, binding, b => { binding = b; }); assert.equal(binding.sessionId, id); assert.equal(cwdCalls.length, 1); result.codexCreateAndResume = true;
  assert.deepEqual(titleCalls, [{ id, title: 'Fixture' }]);
  assert.equal((await codex.sessions()).find(s => s.id === id).title, input.context.title);
  assert.equal((await codex.serverInfo()).pageborne.sessionTitles, 1); result.paperSessionTitle = true;
  assert.equal((await codex.serverInfo()).pageborne.conversationSync, 1);
  const conversation = await codex.conversation(binding);
  assert.equal(conversation.sessionId, id); assert.equal(conversation.turns[0].question, 'Question from Codex mobile');
  assert.equal(conversation.turns[0].answer, 'Answer from the shared session');
  assert.equal((await fetch(config.endpoint + '/api/pageborne/conversation?sessionId=' + id)).status, 401);
  assert.equal(await readFile(path.join(fork, 'dist/routes/pageborne-conversation.js'), 'utf8'), await readFile('integrations/even-terminal/pageborne-conversation.js', 'utf8'));
  result.authenticatedConversationSync = true;
  assert.equal(await readFile(path.join(fork, 'dist/routes/pageborne-session-titles.js'), 'utf8'), await readFile('integrations/even-terminal/pageborne-session-titles.js', 'utf8'));
  assert.equal(await readFile(path.join(fork, 'dist/routes/pageborne-workspaces.js'), 'utf8'), await readFile('integrations/even-terminal/pageborne-workspaces.js', 'utf8'));
  assert.equal(await readFile(path.join(fork, 'dist/routes/pageborne-files.js'), 'utf8'), await readFile('integrations/even-terminal/pageborne-files.js', 'utf8'));
  assert.equal(await readFile(path.join(fork, 'dist/routes/pageborne-library.js'), 'utf8'), await readFile('integrations/even-terminal/pageborne-library.js', 'utf8'));
  assert.equal((await codex.serverInfo()).pageborne.librarySync, 1);
  const library = await codex.api('pageborne/library'); assert.deepEqual(library.files, []); assert.equal(library.directory, process.env.PAGEBORNE_LIBRARY_DIR);
  assert.equal((await fetch(config.endpoint + '/api/pageborne/library')).status, 401); result.authenticatedLibrary = true;
  const folders = new EvenTerminal({ ...config, cwd: '', paperDirectories: true, baseDir: path.join(home, '.pageborne/papers') });
  const files = await Promise.all([paperFile('original.md', 'The original paper.'), paperFile('reflow.md', 'The reading text.'), paperFile('index.json', '{}')]);
  const fileInput = { ...input, paper: async () => ({ files, position: { line: 1 } }) };
  let folderBinding;
  await folders.ask(fileInput, {}, b => { folderBinding = b; }); const firstFolder = folderBinding.cwd;
  await access(path.join(firstFolder, 'paper.json')); assert(folderBinding.managedWorkspace);
  assert.equal(path.dirname(folderBinding.documentFiles.position.file), path.join(firstFolder, 'files'));
  assert.equal(await readFile(folderBinding.documentFiles.position.file, 'utf8'), 'The reading text.');
  await folders.ask(fileInput, folderBinding, b => { folderBinding = b; }); assert.equal(folderBinding.cwd, firstFolder);
  await folders.ask(fileInput, {}, b => { folderBinding = b; }); assert.notEqual(folderBinding.cwd, firstFolder); assert.equal(path.dirname(folderBinding.cwd), path.dirname(firstFolder));
  const noAuth = await fetch(`${config.endpoint}/api/pageborne/workspace`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(noAuth.status, 401);
  result.optionalSessionDirectories = true;
  result.paperFilesInsideSession = true;
  const claude = new EvenTerminal({ ...config, agent: 'claude' }, { pollMs: 100 });
  await assert.rejects(claude.ask(input, {}, () => {}), /existing Remote Control/);
  assert.equal((await claude.sessions())[0].id, cloudId);
  const abort = new AbortController(); const watching = claude.watch(cloudId, abort.signal).catch(() => {}); watches.push({ abort, watching });
  let cb = { sessionId: cloudId };
  const answer = await claude.ask(input, cb, value => { cb = value; }); assert.match(answer.answer, /Native Claude fixture answer/); result.nativeClaudeAttachmentAndIdleCompletion = true;
  append('user', 'Question typed in the normal terminal'); append('assistant', 'Reply to the terminal question');
  let state;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { state = await claude.peek(cb); if (state.kind === 'ready') break; cb = { ...cb, idleCandidate: state.idleCandidate }; await new Promise(r => setTimeout(r, 100)); }
  assert.equal(state.answer, 'Reply to the terminal question'); result.desktopOriginatedReplyAndSse = true;
  const shared = await claude.conversation(cb);
  assert.equal(shared.turns.at(-1).question, 'Question typed in the normal terminal');
  assert.equal(shared.turns.at(-1).answer, 'Reply to the terminal question');
  result.nativeClaudeConversationSync = true;
  const preparations = [];
  core.claudeProvider.prepareSession = async request => {
    preparations.push(request); return { sessionId: request.requestId, cwd: request.cwd, title: request.title, provider: 'claude' };
  };
  const fresh = new EvenTerminal({ ...config, agent: 'claude' });
  assert.equal((await fresh.serverInfo()).pageborne.nativeSessionCreation, 1);
  const request = { requestId: crypto.randomUUID(), title: 'Librarian' };
  const prepared = await fresh.api('pageborne/session', { body: request });
  assert.equal(prepared.cwd, process.env.PAGEBORNE_LIBRARY_DIR);
  assert.equal(prepared.sessionId, request.requestId);
  assert.equal((await fetch(config.endpoint + '/api/pageborne/session?provider=claude', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })).status, 401);
  result.authenticatedNativeCreation = true; result.passed = true;
} finally {
  for (const w of watches) w.abort.abort(); await Promise.all(watches.map(w => w.watching));
  native.close(); upstream.closeAllConnections(); await new Promise(r => upstream.close(r));
  await rm(home, { recursive: true, force: true }); await mkdir('test-results/ask-connections', { recursive: true }); await writeFile('test-results/ask-connections/fork-compatibility.json', JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result));
