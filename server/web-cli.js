import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebApp } from './web-app.js';
import { webConfig } from './web-config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
async function main() {
  if (process.argv.includes('--help')) return console.log(`Pageborne phone/iPad web reader
  npm run start:web                 Load .env.local and start the loopback server
  PAGEBORNE_WEB_UPSTREAM            Required: your Terminal HTTP(S) origin
  PAGEBORNE_WEB_TOKEN_FILE          Required: path to its plain-text pairing token
  EVEN_TERMINAL_STATE_DIR           Alternative: directory containing the token file
  PAGEBORNE_WEB_AUTH                tailscale (default), or local for desktop testing
  PAGEBORNE_WEB_HOSTNAME            Tailscale Serve hostname; auto-detected if omitted
  PAGEBORNE_WEB_ALLOWED_LOGIN       Allowed Tailscale login; auto-detected if omitted
  PAGEBORNE_WEB_AGENT               claude (default) or codex for new chats
  PAGEBORNE_WEB_PORT                Loopback port (default 3463)
  PAGEBORNE_WEB_DIST                Built web directory (default dist-web)
See CONFIGURATION.md. Never expose this listener through a generic public proxy.`);
  let tailscale;
  if ((process.env.PAGEBORNE_WEB_AUTH || 'tailscale') === 'tailscale'
    && (!process.env.PAGEBORNE_WEB_HOSTNAME || !process.env.PAGEBORNE_WEB_ALLOWED_LOGIN)) {
    try { tailscale = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 })); }
    catch { throw new Error('Tailscale identity discovery failed. Sign into Tailscale or supply PAGEBORNE_WEB_HOSTNAME and PAGEBORNE_WEB_ALLOWED_LOGIN.'); }
  }
  const config = webConfig(process.env, root, tailscale);
  let upstreamToken;
  try { upstreamToken = (await readFile(config.tokenFile, 'utf8')).trim(); }
  catch { throw new Error('Could not read the configured Terminal token file. Check its path and permissions.'); }
  if (!upstreamToken || /\s/.test(upstreamToken)) throw new Error('The Terminal token file must contain one nonempty token, not pairing JSON.');
  await readFile(path.join(config.distDir, 'index.html')).catch(() => { throw new Error('Build the web reader first: npm run build:web'); });
  const server = createWebApp({ ...config, upstreamToken }).listen(config.port, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  console.log(`Pageborne web reader on 127.0.0.1:${config.port}; open ${config.allowLocal ? `http://127.0.0.1:${config.port}/` : `https://${config.hostname}/`}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
