import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, open, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const tokenEndpoint = `${issuer}/api/accounts/oauth/token`;
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export async function protectedJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(tmp, file); }
  finally { await unlink(tmp).catch(() => {}); }
}
export async function readJson(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
// Both the CLI and bridge may refresh the same rotating token. Serialize the
// read/refresh/atomic-replace sequence across processes, not just promises.
async function credentialLock(dir, operation) {
  await mkdir(dir, { recursive: true, mode: 0o700 }); const file = path.join(dir, 'chatgpt.lock'); let lock;
  const end = Date.now() + 30000;
  while (!lock) {
    try { lock = await open(file, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const age = Date.now() - (await stat(file).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
      if (age > 180000) { await unlink(file).catch(() => {}); continue; }
      if (Date.now() > end) throw new Error('Another ChatGPT account operation is still running. Try again.');
      await new Promise(r => setTimeout(r, 150));
    }
  }
  try { return await operation(); } finally { await lock.close(); await unlink(file).catch(() => {}); }
}
export function beginAuthorization(hostId, clientId = 'dynamic_agent_client', port = 1455) {
  const state = randomBytes(32).toString('base64url'); const nonce = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url'); const redirect = `http://127.0.0.1:${port}/auth/callback`;
  const url = new URL(`${issuer}/api/accounts/authorize`);
  url.search = new URLSearchParams({ client_id: clientId, ...(clientId === 'dynamic_agent_client' ? { agent_name_hint: 'Pageborne' } : {}),
    ext_agent_host_id: hostId, response_type: 'code', redirect_uri: redirect, scope: scopes, resource, state, nonce,
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
  return { url: url.href, state, nonce, verifier, redirect, clientId, hostId };
}
export function validateCallback(url, attempt) {
  if (url.searchParams.get('state') !== attempt.state) throw new Error('Sign-in state did not match.');
  if (url.searchParams.has('error')) throw new Error('ChatGPT sign-in was declined.');
  const code = url.searchParams.get('code');
  const clientId = url.searchParams.get('client_id') || (attempt.clientId !== 'dynamic_agent_client' ? attempt.clientId : '');
  if (!code || !clientId || clientId === 'dynamic_agent_client' || attempt.clientId !== 'dynamic_agent_client' && clientId !== attempt.clientId) throw new Error('Incomplete or mismatched client registration.');
  return { code, clientId };
}
export async function validateIdentity(idToken, clientId, nonce, keySet, subject) {
  const { payload } = await jwtVerify(idToken, keySet, { issuer, audience: clientId, requiredClaims: ['exp', 'sub', 'nonce'], clockTolerance: 5 });
  if (payload.nonce !== nonce || subject && payload.sub !== subject) throw new Error('ChatGPT sign-in identity did not match.');
  return { subject: payload.sub, issuer: payload.iss, email: payload.email };
}
function tokenRecord(data, old = {}) {
  const granted = typeof data.scope === 'string' ? data.scope.split(/\s+/) : old.scopes;
  if (!granted?.includes('chatgpt.tokens.use.direct') || !granted.includes('resource.invoke')) throw new Error('ChatGPT plan usage was not authorized.');
  if (data.token_type?.toLowerCase() !== 'bearer' || !data.access_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error('Invalid ChatGPT token response.');
  return { ...old, access_token: data.access_token, refresh_token: data.refresh_token || old.refresh_token,
    id_token: data.id_token || old.id_token, scopes: granted, expires_at: Date.now() + data.expires_in * 1000 };
}
export class ChatGPTAccount {
  constructor(dir, { fetcher = fetch, keySet = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)) } = {}) {
    this.dir = dir; this.file = path.join(dir, 'chatgpt.json'); this.fetcher = fetcher; this.keySet = keySet;
  }
  async isSignedIn() { const saved = await readJson(this.file); return !!(saved?.refresh_token || saved?.access_token && saved.expires_at > Date.now()); }
  async tokens(fields) {
    const response = await this.fetcher(tokenEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields), signal: AbortSignal.timeout(20000), redirect: 'error' });
    if (!response.ok) throw new Error(`ChatGPT authorization failed (${response.status}). Sign in again; no API-key fallback was used.`);
    return response.json();
  }
  async finish(url, attempt) {
    const { code, clientId } = validateCallback(url, attempt);
    return credentialLock(this.dir, async () => {
      const old = await readJson(this.file);
      const data = await this.tokens({ grant_type: 'authorization_code', client_id: clientId, code,
        code_verifier: attempt.verifier, redirect_uri: attempt.redirect, resource });
      const identity = await validateIdentity(data.id_token, clientId, attempt.nonce, this.keySet, old?.client_id === clientId ? old.subject : undefined);
      const record = tokenRecord(data, { ...identity, client_id: clientId, ext_agent_host_id: attempt.hostId });
      await protectedJson(this.file, record);
      return true;
    });
  }
  async accessToken() {
    return credentialLock(this.dir, async () => {
      let saved = await readJson(this.file);
      if (!saved?.access_token) throw Object.assign(new Error('Sign in with ChatGPT on the bridge.'), { status: 503 });
      if (saved.expires_at < Date.now() + 60000) {
        if (!saved.refresh_token) throw Object.assign(new Error('Sign in again with ChatGPT.'), { status: 503 });
        const data = await this.tokens({ grant_type: 'refresh_token', client_id: saved.client_id, refresh_token: saved.refresh_token, resource });
        saved = tokenRecord(data, saved); await protectedJson(this.file, saved);
      }
      return saved.access_token;
    });
  }
  async models() {
    const response = await this.fetcher(`${resource}/models`, { headers: { Authorization: `Bearer ${await this.accessToken()}` }, signal: AbortSignal.timeout(20000), redirect: 'error' });
    if (!response.ok) throw new Error(`Could not list ChatGPT models (${response.status}).`);
    const data = await response.json(); return (data.models || []).filter(m => m.visibility === 'list').map(m => ({ model: m.slug, name: m.display_name }));
  }
  async login({ port = 1455, onUrl = console.log } = {}) {
    let host = await readJson(path.join(this.dir, 'host.json'));
    if (!host) { host = { id: `urn:uuid:${randomUUID()}` }; await protectedJson(path.join(this.dir, 'host.json'), host); }
    const old = await readJson(this.file);
    const attempt = beginAuthorization(host.id, old?.client_id, port);
    let finished = false; let completing = false; let resolveLogin, rejectLogin;
    const done = new Promise((resolve, reject) => { resolveLogin = resolve; rejectLogin = reject; });
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, attempt.redirect);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'GET' || url.pathname !== '/auth/callback') { res.writeHead(404).end('Not found'); return; }
      if (completing || finished) { res.writeHead(409).end('Sign-in is already being handled.'); return; }
      // Unrelated requests to the loopback listener cannot cancel the real flow.
      if (url.searchParams.get('state') !== attempt.state) { res.writeHead(400).end('Sign-in state did not match.'); return; }
      completing = true;
      try { await this.finish(url, attempt); finished = true; res.end('Pageborne is connected to ChatGPT. You may close this tab.'); resolveLogin(); }
      catch (error) { res.writeHead(400).end('Sign-in failed. See the Pageborne terminal and try again.'); rejectLogin(error); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    const timer = setTimeout(() => rejectLogin(new Error('Sign-in timed out. Run login again.')), 10 * 60000);
    try { onUrl(attempt.url); await done; }
    finally { clearTimeout(timer); server.closeAllConnections(); await new Promise(r => server.close(r)); }
  }
  async logout() {
    return credentialLock(this.dir, async () => {
      const saved = await readJson(this.file); if (!saved) return true;
      let revoked = !saved.refresh_token;
      try {
        if (saved.refresh_token) {
          const discovery = await this.fetcher(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15000) });
          const endpoint = (await discovery.json()).revocation_endpoint;
          if (new URL(endpoint).origin !== issuer) throw new Error('Invalid revocation endpoint.');
          const response = await this.fetcher(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: saved.refresh_token, token_type_hint: 'refresh_token', client_id: saved.client_id }), signal: AbortSignal.timeout(15000), redirect: 'error' });
          revoked = response.ok;
        }
      } catch {}
      const { subject, email, client_id, ext_agent_host_id } = saved;
      await protectedJson(this.file, { subject, email, client_id, ext_agent_host_id }); return revoked;
    });
  }
}
