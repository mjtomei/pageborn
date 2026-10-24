import test from 'node:test';
import assert from 'node:assert/strict';
import { debugTerminalConnection } from '../scripts/debug-terminal.mjs';
import { automaticTerminalConfig, migrateTerminalPreferences } from '../src/terminal-pairing.js';

const profile = { channel: 'debug', origins: ['https://terminal.example'] };
const env = { PAGEBORNE_DEBUG_TERMINAL_STATE: '/private/pairing.json' };
test('automatic pairing is opt-in and release never reads private credentials', () => {
  const forbidden = () => { throw new Error('Must not read a private file'); };
  assert.equal(debugTerminalConnection(profile, {}, forbidden), null);
  assert.equal(debugTerminalConnection({ ...profile, channel: 'release' }, env, forbidden), null);
  assert.equal(debugTerminalConnection(profile, { ...env, PAGEBORNE_ASK_ORIGINS: '' }, forbidden), null);
});
test('automatic pairing uses the allowed host and saved token with stock Terminal defaults', () => {
  const config = debugTerminalConnection(profile, env, () => JSON.stringify({ token: 'test-pairing-token', cwd: '/not-for-the-phone', host: '127.0.0.1', port: 3456 }));
  assert.deepEqual(config, { mode: 'terminal', endpoint: profile.origins[0], token: 'test-pairing-token', agent: 'codex', cwd: '', paperDirectories: false, baseDir: '', previewEndpoint: 'http://127.0.0.1:3456' });
  assert.equal(debugTerminalConnection(profile, { ...env, PAGEBORNE_DEBUG_TERMINAL_AGENT: 'claude' }, () => '{"token":"test"}').agent, 'claude');
});
test('local desktop preview uses the local server but a loopback phone WebView always uses the public host', () => {
  const config = { endpoint: 'https://terminal.example', previewEndpoint: 'http://127.0.0.1:3456', token: 'test' };
  assert.equal(automaticTerminalConfig(config, { evenHost: false, hostname: '127.0.0.1' }).endpoint, config.previewEndpoint);
  assert.equal(automaticTerminalConfig(config, { evenHost: true, hostname: '127.0.0.1' }).endpoint, config.endpoint);
  assert.equal(automaticTerminalConfig(config, { evenHost: false, hostname: 'preview.example' }).endpoint, config.endpoint);
  assert.equal(automaticTerminalConfig({ endpoint: config.endpoint }, { evenHost: false, hostname: 'localhost' }).endpoint, config.endpoint);
  assert.equal(automaticTerminalConfig(null, { evenHost: false, hostname: 'localhost' }), null);
});
test('Tailscale-bound Terminal uses its actual endpoint on desktop and phone, with explicit old-address aliases', () => {
  const endpoint = 'http://100.96.1.2:3456';
  const config = debugTerminalConnection({ ...profile, origins: [endpoint] }, { ...env,
    PAGEBORNE_DEBUG_TERMINAL_PREVIOUS_URLS: 'https://old.example/, http://127.0.0.1:3456/api/' },
  () => JSON.stringify({ token: 'test', host: '100.96.1.2', port: 3456 }));
  assert.equal(config.previewEndpoint, undefined);
  assert.deepEqual(config.previousEndpoints, ['https://old.example', 'http://127.0.0.1:3456']);
  for (const evenHost of [false, true]) assert.equal(automaticTerminalConfig(config, { evenHost, hostname: '127.0.0.1' }).endpoint, endpoint);
});
test('address migration preserves paper sessions, pending replies, chats and deletion baselines once without credentials', () => {
  const old = 'https://old.example', endpoint = 'http://100.96.1.2:3456';
  const key = (host, agent = 'codex', mode = 'terminal') => JSON.stringify(['paper', mode, host, agent, '']);
  const pending = { sessionId: 'same-session', pending: { marker: 'in-flight' }, documentFiles: { workspaceId: 'paper-directory' } };
  const preferences = { askSessions: { [key(old)]: pending, [key(old, 'claude')]: { sessionId: 'claude-session' },
    [key(old, 'model', 'provider')]: { unrelated: true }, 'invalid-json': {} },
  askChats: { [key(old)]: [{ id: 'turn', question: 'Question', answer: 'Answer' }] },
  librarySync: { [old]: { id: 'same-library', directory: '/papers', files: { 'deleted.md': 'hash' }, at: 123 } } };
  const config = { endpoint, previousEndpoints: [old], token: 'never-persist' };
  assert(migrateTerminalPreferences(preferences, config));
  assert.deepEqual(preferences.askSessions[key(endpoint)], pending);
  assert.equal(preferences.askSessions[key(endpoint, 'claude')].sessionId, 'claude-session');
  assert.equal(preferences.askSessions[key(endpoint, 'model', 'provider')], undefined);
  assert.deepEqual(preferences.askChats[key(endpoint)], preferences.askChats[key(old)]);
  assert.deepEqual(preferences.librarySync[endpoint], preferences.librarySync[old]);
  preferences.librarySync[endpoint].files['new.md'] = 'new-hash';
  assert.equal(preferences.librarySync[old].files['new.md'], undefined);
  delete preferences.askSessions[key(endpoint)];
  assert.equal(migrateTerminalPreferences(preferences, config), false);
  assert.equal(preferences.askSessions[key(endpoint)], undefined);
  assert(!JSON.stringify(preferences).includes(config.token));
  const existing = { askSessions: { [key(old)]: pending, [key(endpoint)]: { sessionId: 'new-session' } }, librarySync: { [endpoint]: { id: 'new-library' }, [old]: { id: 'old-library' } } };
  migrateTerminalPreferences(existing, config);
  assert.equal(existing.askSessions[key(endpoint)].sessionId, 'new-session');
  assert.equal(existing.librarySync[endpoint].id, 'new-library');
  assert.equal(migrateTerminalPreferences({}, null), false);
});
test('automatic pairing fails closed for missing tokens, malformed state and unapproved servers without echoing secrets', () => {
  for (const contents of ['{}', '{"token":""}', '{"token":123}', '{"token":"secret with spaces"}', '{bad-private-token']) {
    assert.throws(() => debugTerminalConnection(profile, env, () => contents), e => e.message.startsWith('Could not configure automatic debug pairing.') && !e.message.includes('private-token'));
  }
  assert.throws(() => debugTerminalConnection(profile, { ...env, PAGEBORNE_DEBUG_TERMINAL_URL: 'https://other.example' }, () => '{"token":"test"}'));
  assert.throws(() => debugTerminalConnection({ ...profile, origins: [...profile.origins, 'https://other.example'] }, env, () => '{"token":"test"}'));
});
