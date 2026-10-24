import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createReaderState } from '../integrations/even-terminal/pageborne-reader-state.js';
import { SharedReaderState, readerScope } from '../src/shared-reader-state.js';
import { askChatKey } from '../src/ask-models.js';
const anchor = n => ({ id: `q${n}`, aliases: [`local${n}`], position: n, page: 1 });
const input = (sessionId, anchors = [], agent = 'claude') => ({ document: 'paper.md', agent, sessionId, anchors });
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { libraryDir: path.join(root, 'library'), stateDir: path.join(root, 'terminal') };
  return { root, options, store: createReaderState(options) };
}
test('library metadata survives restart and concurrent devices retain all model histories and anchors', async t => {
  const { options, store } = await fixture(t);
  await Promise.all([store.update(input('claude-old', [anchor(1)])), store.update(input('codex-old', [anchor(2)], 'codex'))]);
  await Promise.all([store.update(input('claude-old', [anchor(3)])), store.update(input('claude-new', [anchor(4)]))]);
  const saved = await createReaderState(options).read();
  assert.equal(saved.records.length, 2);
  const claude = saved.records.find(r => r.agent === 'claude');
  assert.equal(claude.primary, 'claude-old');
  assert.deepEqual(claude.sessions.map(s => s.id), ['claude-old', 'claude-new']);
  assert.deepEqual(claude.sessions[0].anchors.map(a => a.id), ['q1', 'q3']);
  const files = await readdir(path.join(options.libraryDir, '.pageborne/reader-state'));
  assert.deepEqual(files, [`${saved.instanceId}.json`]);
  assert.ok(saved.libraryId);
});
test('different Terminal instances and library folders have isolated links', async t => {
  const { options, store } = await fixture(t); await store.update(input('private', [anchor(1)]));
  const a = await store.read();
  const b = await createReaderState({ ...options, instanceId: randomUUID() }).read();
  const c = await createReaderState({ ...options, libraryDir: options.libraryDir + '-other' }).read();
  assert.deepEqual(b.records, []); assert.deepEqual(c.records, []);
  assert.notEqual(readerScope(a), readerScope(b)); assert.notEqual(readerScope(a), readerScope(c));
  await assert.rejects(store.update({ ...input('bad'), document: '../paper.md' }), /Invalid/);
  await assert.rejects(store.update(input('bad', [{ ...anchor(1), position: Infinity }])), /Invalid/);
});
test('device migration and remote discovery share sessions without leaking links to a replacement instance', async t => {
  const { store } = await fixture(t), config = { mode: 'terminal', endpoint: 'https://example.test', agent: 'claude' };
  const doc = { id: 'paper.md', positionKey: 'local\npaper.md' }, oldKey = askChatKey(config, doc.positionKey);
  let prefs = { askSessions: { [oldKey]: { sessionId: 'saved-codex' } }, askChats: { [oldKey]: [{ id: 'q1', question: 'Private text', answer: 'Private answer', position: 15 }] } };
  const posts = []; let remote = await store.read();
  const shared = new SharedReaderState({ client: () => ({ config, api: async (_route, options) => {
    if (options.body) { posts.push(options.body); return store.update(options.body); } return remote;
  } }), documents: () => [doc], read: () => prefs, save: patch => Object.assign(prefs, patch) });
  await shared.sync();
  assert.equal(posts.length, 1); assert.equal(posts[0].sessionId, 'saved-codex');
  assert.ok(!JSON.stringify(posts).includes('Private'));
  const originalScope = readerScope(remote), scopedKey = askChatKey({ ...config, chatScope: originalScope }, doc.positionKey);
  assert.equal(prefs.askSessions[scopedKey].sessionId, 'saved-codex');
  remote = { ...remote, instanceId: randomUUID(), records: [] }; posts.length = 0;
  await shared.sync(); assert.equal(posts.length, 0); assert.equal(prefs.askSessions[scopedKey].sessionId, 'saved-codex');
  // A fresh device using a different URL discovers the original session.
  remote = await store.read(); let fresh = {};
  shared.read = () => fresh; shared.save = patch => Object.assign(fresh, patch);
  await shared.sync(); assert.equal(fresh.askSessions[scopedKey].sessionId, 'saved-codex');
  fresh.askChats = { [scopedKey]: [{ id: 'remote-turn', remoteId: 'q1', question: 'Private text', answer: 'Complete' }] };
  await shared.sync(); assert.equal(fresh.askChats[scopedKey][0].position, 15);
});
