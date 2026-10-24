#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { protectedJson, readJson, ChatGPTAccount } from './chatgpt.js';
import { createAiBridge } from './server.js';
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  config: { type: 'string' }, host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string' }, help: { type: 'boolean' },
} });
const help = `Pageborne AI bridge — optional; the document library stays on your phone.
  npm run ai -- init        Create a private config and random bridge token
  npm run ai -- login       Experimental ChatGPT adapter (explicit opt-in required)
  npm run ai -- models      Experimental adapter's available models
  npm run ai -- logout      Revoke ChatGPT session and clear local credentials
  npm run ai -- serve       Run the authenticated bridge (default 127.0.0.1:3470)
  --config FILE             Config file (default ~/.config/pageborne-ai/config.json)
  --host ADDRESS            Listen address; put HTTPS in front for phone access
  --port PORT               Bridge port, or loopback callback port (login: 1455)

For login over SSH, forward the callback port:
  ssh -L 1455:127.0.0.1:1455 your-server
Then open the printed sign-in URL in your local browser.
See ASK-ABOUT-THIS.md for inference, transcription and app packaging settings.
The legacy ChatGPT adapter requires PAGEBORNE_EXPERIMENTAL_CHATGPT=1.
Its live account compatibility is not verified for this release.
`;
async function main() {
  if (values.help) return console.log(help);
  const file = path.resolve(values.config || path.join(homedir(), '.config/pageborne-ai/config.json'));
  const dir = path.dirname(file); const command = positionals[0] || 'serve'; const account = new ChatGPTAccount(dir);
  if (command === 'init') {
    if (await readJson(file)) throw new Error('Config already exists; it was not changed.');
    await protectedJson(file, { token: randomBytes(32).toString('base64url'), provider: 'openai-compatible', model: '',
      baseUrl: 'https://api.openai.com/v1', apiKey: '', transcription: { baseUrl: '', model: '', apiKey: '' } });
    console.log(`Created ${file}. Edit the provider/model, and copy its token to Pageborne Settings. No credentials are printed.`); return;
  }
  const port = Number(values.port || (command === 'login' ? 1455 : 3470));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
  const requireExperimental = () => {
    if (process.env.PAGEBORNE_EXPERIMENTAL_CHATGPT !== '1') throw new Error('The legacy ChatGPT adapter is experimental. Set PAGEBORNE_EXPERIMENTAL_CHATGPT=1 to opt in, or configure an API-key provider. See COMPATIBILITY.md.');
  };
  if (['login', 'models'].includes(command)) requireExperimental();
  if (command === 'login') {
    console.log('Continue with ChatGPT. Open this URL in the browser on the computer receiving the loopback callback:');
    await account.login({ port }); console.log('Connected. Run models, then set model in the bridge config.'); return;
  }
  if (command === 'models') return console.log(JSON.stringify(await account.models(), null, 2));
  if (command === 'logout') return console.log(await account.logout() ? 'Signed out and revoked the session.' : 'Local credentials cleared; remote revocation was not confirmed. Disconnect Pageborne in ChatGPT Settings.');
  if (command !== 'serve') throw new Error('Unknown command. Use --help.');
  const config = await readJson(file); if (!config) throw new Error('Run init first.');
  if (config.provider === 'chatgpt') requireExperimental();
  const server = createAiBridge(config, { chatgpt: account }).listen(port, values.host);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  console.log(`Pageborne AI bridge on ${values.host}:${port}. Provider: ${config.provider}. Prompts/audio are not logged or saved.`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
