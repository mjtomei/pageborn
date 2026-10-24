#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { networkInterfaces } from 'node:os';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import QRCode from 'qrcode';
import { createApp } from './app.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const help = `Pageborne — local Markdown and PDFs on G2

  npm start -- [serve]   Serve the app for Prototype Mode
  npm start -- qr        Print the current prototype URL and QR
  --host ADDRESS         Bind address (default: detected LAN IPv4)
  --port PORT            Listen port (default: 3460)
  --url URL              Phone-facing URL for the static preview
  --help                 Show this help

This development server serves app files only. Use Add files on the phone.
Documents stay in phone storage. The installed .ehpk needs no server.
`;
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  host: { type: 'string' }, port: { type: 'string', default: '3460' },
  url: { type: 'string' }, help: { type: 'boolean' },
} });
const stateDir = path.join(root, '.state');
async function showQr(url) {
  const options = { errorCorrectionLevel: 'M', margin: 4, color: { dark: '#000000ff', light: '#ffffffff' } };
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(stateDir, 'preview.png'), await QRCode.toBuffer(url, { ...options, type: 'png', scale: 10 }));
  console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
  console.log(`Open in Even Hub → profile → Prototype Mode:\n${url}\nQR image: ${path.join(stateDir, 'preview.png')}`);
}
async function main() {
  if (values.help) return console.log(help);
  const command = positionals[0] || 'serve';
  if (command === 'qr') return showQr(JSON.parse(await readFile(path.join(stateDir, 'preview.json'), 'utf8')).url);
  if (command !== 'serve') throw new Error(`Unknown command: ${command}. Use --help.`);
  await access(path.join(root, 'dist/index.html')).catch(() => { throw new Error('Build the debug app first: npm run build:debug'); });
  const lan = Object.entries(networkInterfaces()).flatMap(([name, addrs]) => /^(docker|br-|veth|lo)/.test(name) ? [] : (addrs || []).filter(a => a.family === 'IPv4' && !a.internal));
  const host = values.host || lan[0]?.address || '127.0.0.1';
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1–65535.');
  const address = host === '0.0.0.0' || host === '::' ? (lan[0]?.address || '127.0.0.1') : host;
  const url = new URL(values.url || `http://${address.includes(':') ? `[${address}]` : address}:${port}/`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('--url must be an HTTP(S) origin without a path, query, fragment, or credentials.');
  }
  const server = createApp({ distDir: path.join(root, 'dist') }).listen(port, host);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(stateDir, 'preview.json'), JSON.stringify({ url: url.href }));
  console.log(`Pageborne static preview on ${host}:${port}. Documents are stored on the phone.`);
  await showQr(url.href);
  console.log('Press Ctrl+C to stop.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
