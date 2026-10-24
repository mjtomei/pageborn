import test from 'node:test';
import assert from 'node:assert/strict';
import { webConfig } from '../server/web-config.js';

const base = { PAGEBORNE_WEB_UPSTREAM: 'http://127.0.0.1:3456', PAGEBORNE_WEB_TOKEN_FILE: '/private/token' };
test('web configuration uses explicit upstream and discovers only Tailscale identity', () => {
  const config = webConfig(base, '/reader', { Self: { DNSName: 'reader.example.', UserID: '42', TailscaleIPs: ['100.64.0.2'] }, User: { '42': { LoginName: 'owner@example.com' } } });
  assert.equal(config.upstream, base.PAGEBORNE_WEB_UPSTREAM);
  assert.equal(config.tokenFile, '/private/token');
  assert.equal(config.hostname, 'reader.example');
  assert.equal(config.allowedLogin, 'owner@example.com');
  assert.equal(config.allowLocal, false);
  assert.equal(config.distDir, '/reader/dist-web');
});
test('web configuration supports explicit identity, provider, paths and local testing', () => {
  const config = webConfig({ ...base, PAGEBORNE_WEB_HOSTNAME: 'reader.example', PAGEBORNE_WEB_ALLOWED_LOGIN: 'friend', PAGEBORNE_WEB_AGENT: 'codex', PAGEBORNE_WEB_PORT: '4000', PAGEBORNE_WEB_DIST: '/build/web' }, '/reader');
  assert.equal(config.agent, 'codex'); assert.equal(config.port, 4000); assert.equal(config.distDir, '/build/web');
  assert.equal(config.allowedLogin, 'friend');
  const local = webConfig({ ...base, PAGEBORNE_WEB_TOKEN_FILE: '', EVEN_TERMINAL_STATE_DIR: '/terminal/state', PAGEBORNE_WEB_AUTH: 'local' }, '/reader');
  assert.equal(local.tokenFile, '/terminal/state/token'); assert.equal(local.allowLocal, true); assert.equal(local.hostname, undefined);
});
test('web configuration fails closed and rejects embedded credentials without echoing them', () => {
  assert.throws(() => webConfig({}, '/reader'), /UPSTREAM/);
  assert.throws(() => webConfig({ PAGEBORNE_WEB_UPSTREAM: base.PAGEBORNE_WEB_UPSTREAM }, '/reader'), /TOKEN_FILE/);
  assert.throws(() => webConfig(base, '/reader'), /Tailscale/);
  for (const upstream of ['https://user:private-value@example.com', 'https://example.com/path', 'https://example.com?token=private-value', 'file:///tmp/a']) {
    assert.throws(() => webConfig({ ...base, PAGEBORNE_WEB_UPSTREAM: upstream }, '/reader'), error => /UPSTREAM/.test(error.message) && !error.message.includes('private-value'));
  }
  for (const [key, value] of [['PAGEBORNE_WEB_AUTH','none'], ['PAGEBORNE_WEB_PORT','0'], ['PAGEBORNE_WEB_PORT','65536'], ['PAGEBORNE_WEB_AGENT','invalid']]) {
    assert.throws(() => webConfig({ ...base, PAGEBORNE_WEB_AUTH: 'local', [key]: value }, '/reader'));
  }
});
