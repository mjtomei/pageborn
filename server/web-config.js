import path from 'node:path';

// Resolve configuration separately from I/O so invalid settings fail before
// reading credentials. No pairing values go in the build.
export function webConfig(env, root, tailscale) {
  const auth = env.PAGEBORNE_WEB_AUTH || 'tailscale';
  if (!['tailscale', 'local'].includes(auth)) throw new Error('PAGEBORNE_WEB_AUTH must be tailscale or local.');
  const port = Number(env.PAGEBORNE_WEB_PORT || 3463);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a web port from 1024 to 65535.');
  const agent = env.PAGEBORNE_WEB_AGENT || 'claude';
  if (!['claude', 'codex'].includes(agent)) throw new Error('PAGEBORNE_WEB_AGENT must be claude or codex.');
  let url;
  try { url = new URL(env.PAGEBORNE_WEB_UPSTREAM); } catch { /* Report the setting, never its contents. */ }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Set PAGEBORNE_WEB_UPSTREAM to your Terminal HTTP(S) origin, without credentials, path, query or fragment.');
  }
  const tokenFile = env.PAGEBORNE_WEB_TOKEN_FILE
    || (env.EVEN_TERMINAL_STATE_DIR && path.join(env.EVEN_TERMINAL_STATE_DIR, 'token'));
  if (!tokenFile) throw new Error('Set PAGEBORNE_WEB_TOKEN_FILE (a plain-text Terminal token file) or EVEN_TERMINAL_STATE_DIR.');
  const config = { port, agent, upstream: url.origin, tokenFile: path.resolve(tokenFile),
    distDir: path.resolve(env.PAGEBORNE_WEB_DIST || path.join(root, 'dist-web')), allowLocal: auth === 'local' };
  if (auth === 'local') return config;
  // Discovery is optional when both identity settings are supplied explicitly.
  const hostname = (env.PAGEBORNE_WEB_HOSTNAME || tailscale?.Self?.DNSName || '').replace(/\.$/, '').toLowerCase();
  const allowedLogin = env.PAGEBORNE_WEB_ALLOWED_LOGIN || tailscale?.User?.[tailscale?.Self?.UserID]?.LoginName;
  if (!hostname || !allowedLogin) throw new Error('Sign into Tailscale, or set PAGEBORNE_WEB_HOSTNAME and PAGEBORNE_WEB_ALLOWED_LOGIN for your Tailscale Serve identity.');
  if (!/^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname)) throw new Error('PAGEBORNE_WEB_HOSTNAME must be a hostname without a scheme, path or port.');
  return { ...config, hostname, allowedLogin };
}
