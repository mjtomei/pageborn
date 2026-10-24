import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProfile, profilePaths, validateBuild } from '../scripts/build-profile.mjs';

const privateEnv = { PAGEBORNE_DEBUG_ASK_ORIGINS: 'https://private.example', PAGEBORNE_ASK_ORIGINS: 'http://127.0.0.1:3456' };
test('release ignores private and generic debug origins even when both are inherited', () => {
  for (const mode of ['release', 'production', 'unexpected-mode']) {
    assert.deepEqual(buildProfile(mode, privateEnv), { channel: 'release', diagnostics: false, origins: [] });
  }
  const profile = buildProfile('release', { ...privateEnv, PAGEBORNE_RELEASE_ASK_ORIGINS: 'https://approved.example' });
  assert.deepEqual(profile.origins, ['https://approved.example']);
});
test('debug uses local configuration or an explicit test override without mixing origins', () => {
  assert.deepEqual(buildProfile('debug', { PAGEBORNE_DEBUG_ASK_ORIGINS: privateEnv.PAGEBORNE_DEBUG_ASK_ORIGINS }), { channel: 'debug', diagnostics: true, origins: ['https://private.example'] });
  assert.deepEqual(buildProfile('development', privateEnv).origins, ['http://127.0.0.1:3456']);
  assert.deepEqual(buildProfile('debug', { ...privateEnv, PAGEBORNE_ASK_ORIGINS: '' }).origins, []);
  assert.throws(() => buildProfile('debug', { PAGEBORNE_DEBUG_ASK_ORIGINS: 'https://private.example?token=secret' }));
});
test('separate package paths and metadata checks reject mixed or stale artifacts', () => {
  assert.notEqual(profilePaths('debug').dist, profilePaths('release').dist);
  assert.notEqual(profilePaths('debug').package, profilePaths('release').package);
  assert.throws(() => profilePaths('other'));
  const debug = { ...buildProfile('debug', privateEnv), version: '1.0.0' };
  assert.doesNotThrow(() => validateBuild(debug, 'debug', '1.0.0', debug.origins));
  assert.throws(() => validateBuild(debug, 'release', '1.0.0', debug.origins));
  assert.throws(() => validateBuild(debug, 'debug', '1.0.1', debug.origins));
  assert.throws(() => validateBuild(debug, 'debug', '1.0.0', []));
  assert.throws(() => validateBuild({ ...debug, diagnostics: false }, 'debug', '1.0.0', debug.origins));
});
