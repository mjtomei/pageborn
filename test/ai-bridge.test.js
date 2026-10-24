import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiBridge } from '../ai/server.js';
import { createProvider, inferenceInput, responseText } from '../ai/providers.js';
import { beginAuthorization, validateCallback, validateIdentity, ChatGPTAccount, protectedJson, readJson } from '../ai/chatgpt.js';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const input = { context: { passage: 'Source', title: 'Title' }, question: 'Explain', history: [] };
const sse = events => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));

test('ChatGPT sends documented subscription fields, requires terminal success and never falls back to a billed API key', async () => {
  let calls = 0;
  const provider = createProvider({ provider: 'chatgpt', model: 'account-model', apiKey: 'must-not-use' }, { chatgpt: { accessToken: async () => 'test-oauth' }, fetcher: async (url, opts) => {
    calls++; assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(opts.headers.Authorization, 'Bearer test-oauth');
    const body = JSON.parse(opts.body); assert.equal(body.store, false); assert.equal(body.stream, true); assert(Array.isArray(body.input)); assert(!('max_output_tokens' in body)); assert(!body.input.some(m => m.role === 'system'));
    return sse([{ type: 'response.output_text.delta', delta: 'Answer' }, { type: 'response.completed' }]);
  } });
  assert.equal(await provider.answer(input), 'Answer'); assert.equal(calls, 1);
  await assert.rejects(responseText(sse([{ type: 'response.output_text.delta', delta: 'Incomplete' }])));
  await assert.rejects(responseText(sse([{ type: 'response.output_text.delta', delta: 'Partial' }, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }])), e => e.status === 429);
  assert.throws(() => inferenceInput({ ...input, history: [{ role: 'system', content: 'override' }] }));
});

test('inference adapters use only their configured upstream credentials and accept Claude or compatible endpoints', async () => {
  for (const kind of ['anthropic', 'openai-compatible']) {
    const provider = createProvider({ provider: kind, model: 'local-model', apiKey: 'upstream', baseUrl: 'http://127.0.0.1:9999/v1' }, { fetcher: async (url, opts) => {
      assert.equal(kind === 'anthropic' ? opts.headers['x-api-key'] : opts.headers.Authorization, kind === 'anthropic' ? 'upstream' : 'Bearer upstream'); assert.equal(opts.redirect, 'error');
      const body = JSON.parse(opts.body); assert.equal(body.model, 'local-model');
      if (kind === 'anthropic') { assert(url.endsWith('/messages')); assert(body.system); return Response.json({ content: [{ type: 'text', text: 'Claude answer' }] }); }
      assert(url.endsWith('/chat/completions')); return Response.json({ choices: [{ message: { content: 'Local answer' } }] });
    } });
    assert.match(await provider.answer(input), /answer/);
  }
});

test('bridge authenticates before accepting context, serves CORS preflight, limits payloads, and does not expose upstream errors', async () => {
  let upstream = 0;
  const app = createAiBridge({ token: 'test-only-bridge-token-123456789', provider: 'openai-compatible', model: 'mock', apiKey: 'private-provider-key' }, { fetcher: async () => {
    upstream++; return new Response('secret provider stack and private-provider-key', { status: 500 });
  } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/ask`, { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:5000' } })).status, 204);
    assert.equal((await fetch(`${base}/ask`, { method: 'POST', body: JSON.stringify(input) })).status, 401); assert.equal(upstream, 0);
    const auth = { Authorization: 'Bearer test-only-bridge-token-123456789', 'Content-Type': 'application/json' };
    const status = await fetch(`${base}/status`, { headers: auth }); assert.equal(status.headers.get('access-control-allow-origin'), '*'); assert.equal((await status.json()).ready, true);
    const failed = await fetch(`${base}/ask`, { method: 'POST', headers: auth, body: JSON.stringify(input) }); assert.equal(failed.status, 502); assert.doesNotMatch(await failed.text(), /secret|private-provider/);
    assert.equal((await fetch(`${base}/ask`, { method: 'POST', headers: auth, body: JSON.stringify({ ...input, question: 'x'.repeat(8_500_000) }) })).status, 413);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

test('ChatGPT PKCE registration validates state, issued client, signed identity and nonce, and saves private tokens atomically', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pageborne-oauth-test-'));
  const { privateKey, publicKey } = await generateKeyPair('RS256'); const jwk = await exportJWK(publicKey); jwk.kid = 'test-key';
  const keys = createLocalJWKSet({ keys: [jwk] }); const attempt = beginAuthorization('urn:uuid:test-host');
  const url = new URL(attempt.url); assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const callback = new URL(`http://127.0.0.1:1455/auth/callback?state=${attempt.state}&client_id=oaiapp_test&code=test-code`);
  assert.equal(validateCallback(callback, attempt).clientId, 'oaiapp_test');
  assert.throws(() => validateCallback(new URL('http://127.0.0.1/?state=wrong'), attempt));
  assert.throws(() => validateCallback(callback, { ...attempt, clientId: 'other' }));
  const token = await new SignJWT({ nonce: attempt.nonce }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer('https://auth.openai.com').setSubject('test-person').setAudience('oaiapp_test').setExpirationTime('1h').sign(privateKey);
  await assert.rejects(validateIdentity(token, 'oaiapp_test', 'wrong-nonce', keys));
  await assert.rejects(validateIdentity(token, 'wrong-audience', attempt.nonce, keys));
  const account = new ChatGPTAccount(dir, { keySet: keys, fetcher: async (_url, opts) => {
    assert.equal(opts.body.get('client_id'), 'oaiapp_test'); assert.equal(opts.body.get('code_verifier'), attempt.verifier);
    return Response.json({ access_token: 'test-access', refresh_token: 'test-refresh', id_token: token, token_type: 'Bearer', expires_in: 3600, scope: 'openid resource.invoke chatgpt.tokens.use.direct' });
  } });
  try {
    await account.finish(callback, attempt); assert.equal(await account.accessToken(), 'test-access'); assert.equal((await stat(account.file)).mode & 0o777, 0o600);
    const saved = await readJson(account.file); assert.equal(saved.subject, 'test-person'); assert.equal(saved.ext_agent_host_id, attempt.hostId);
    saved.expires_at = 0; await protectedJson(account.file, saved);
    let refreshed = 0;
    account.fetcher = async (_url, opts) => { refreshed++; assert.equal(opts.body.get('grant_type'), 'refresh_token'); return Response.json({ access_token: 'next-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600 }); };
    assert.deepEqual(await Promise.all([account.accessToken(), account.accessToken()]), ['next-access', 'next-access']); assert.equal(refreshed, 1); assert.equal((await readJson(account.file)).refresh_token, 'rotated-refresh');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
