import test from 'node:test';
import assert from 'node:assert/strict';
import { askChatKey, askScopeKey, defaultAskAgent, retainAskModels, askConfigFor } from '../src/ask-models.js';

const config = { mode: 'terminal', endpoint: 'https://desktop.test', agent: 'claude', token: 'private' };
const key = (paper, agent) => askChatKey({ ...config, agent }, paper);

test('default applies to new chats; saved per-document and librarian choices win', () => {
  const choices = { defaultAgent: 'claude', selections: { [askScopeKey('old')]: 'codex', [askScopeKey(null)]: 'codex' } };
  assert.equal(askConfigFor(config, choices, 'new').agent, 'claude');
  assert.equal(askConfigFor(config, choices, 'old').agent, 'codex');
  assert.equal(askConfigFor(config, choices, null).agent, 'codex');
  assert.equal(askConfigFor(config, { ...choices, defaultAgent: 'codex' }, 'new').agent, 'codex');
  assert.equal(defaultAskAgent(config, { defaultAgent: 'invalid' }), 'claude');
  assert.notEqual(key(null, 'codex'), key('library', 'codex'));
  assert.notEqual(key('old', 'codex'), key('old', 'claude'));
});

test('upgrade keeps old chats on their agent before applying a new default', () => {
  const bindings = { [key('old', 'codex')]: { sessionId: 'codex-session' }, [key('both', 'codex')]: { sessionId: 'codex-both' }, [key('both', 'claude')]: { sessionId: 'claude-both' },
    [key(null, 'codex')]: { pending: { marker: 'still-running' } } };
  const chats = { [key('cached-only', 'codex')]: [{ question: 'Old question', answer: 'Old answer' }] };
  const original = structuredClone({ bindings, chats });
  const next = retainAskModels(config, { defaultAgent: 'claude' }, bindings, chats);
  assert.equal(askConfigFor(config, next, 'old').agent, 'codex');
  assert.equal(askConfigFor(config, next, 'both').agent, 'claude');
  assert.equal(askConfigFor(config, next, 'cached-only').agent, 'codex');
  assert.equal(askConfigFor(config, next, null).agent, 'codex');
  assert.equal(retainAskModels(config, next, bindings, chats), next, 'migration is idempotent');
  assert.deepEqual({ bindings, chats }, original, 'history and session bindings are never rewritten');
  assert(!JSON.stringify(next).includes('private'), 'choices contain no connection credentials');
});

test('explicit model selection survives defaults, reconnects and legacy history', () => {
  const choices = { defaultAgent: 'codex', selections: { [askScopeKey('paper')]: 'claude' } };
  assert.equal(retainAskModels(config, choices, { [key('paper', 'codex')]: { sessionId: 'old' } }), choices);
  assert.equal(askConfigFor({ ...config, endpoint: 'https://new.test' }, choices, 'paper').agent, 'claude');
  assert.deepEqual(retainAskModels({ ...config, endpoint: 'https://new.test' }, {}, { [key('paper', 'codex')]: { sessionId: 'old' } }), {});
  assert.deepEqual(retainAskModels(config, {}, { broken: { sessionId: 'x' }, null: {}, '"string"': {}, [key('empty', 'codex')]: { cwd: '/folder' } }), {});
  const direct = { mode: 'provider', baseUrl: 'https://api.test', model: 'custom-model' };
  assert.equal(askConfigFor(direct, choices, 'paper'), direct);
});
