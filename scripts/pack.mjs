import { askManifest } from '../ai/build.js';
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { profilePaths, validateBuild } from './build-profile.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || args.length && !['--debug', '--release'].includes(args[0])) throw new Error('Use pack.mjs --debug or --release.');
const channel = args[0]?.slice(2) || 'release';
const paths = profilePaths(channel); const dist = path.join(root, paths.dist);
const stateDir = path.resolve(process.env.EVEN_READER_STATE || path.join(root, '.state'));
const sourceManifest = JSON.parse(await readFile(path.join(root, 'app.json'), 'utf8'));
const profile = JSON.parse(await readFile(path.join(dist, 'build-info.json'), 'utf8'));
const origins = JSON.parse(await readFile(path.join(dist, 'ask-origins.json'), 'utf8'));
validateBuild(profile, channel, sourceManifest.version, origins);
const manifest = askManifest(sourceManifest, origins, ['https://huggingface.co', 'https://us.aws.cdn.hf.co', 'https://cdn-lfs.huggingface.co', 'https://cdn-lfs-us-1.hf.co', 'https://cas-bridge.xethub.hf.co']);
const sdk = JSON.parse(await readFile(path.join(root, 'node_modules/@evenrealities/even_hub_sdk/package.json'), 'utf8'));
const tmp = await mkdtemp(path.join(os.tmpdir(), 'even-reader-pack-'));
const indexPath = path.join(dist, 'index.html'), indexHtml = await readFile(indexPath, 'utf8');
try {
  const file = path.join(tmp, 'app.json');
  await writeFile(file, JSON.stringify(manifest, null, 2));
  // Also expose the manifest when serving the built directory as a dev app.
  await writeFile(path.join(dist, 'app.json'), JSON.stringify(manifest, null, 2));
  // Only the installed package requires Even's native storage. Served browser
  // previews retain their normal startup and IndexedDB cache.
  if (!indexHtml.includes('<head>')) throw new Error('Package entrypoint has no head element.');
  await writeFile(indexPath, indexHtml.replace('<head>', '<head><meta name="pageborne-host" content="even">'));
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/@evenrealities/evenhub-cli/main.js'),
    'pack', file, dist, '--sdk-ver', sdk.version, '-o', path.join(root, paths.package)], { stdio: 'inherit', cwd: root });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Even Hub pack failed (${result.status}).`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(stateDir, `package-manifest-${channel}.json`), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  console.log(`${channel} package: ${paths.package}. Diagnostics ${profile.diagnostics ? 'on' : 'off'}. ${origins.length} AI origin(s) enabled.`);
} finally { await writeFile(indexPath, indexHtml); await rm(tmp, { recursive: true, force: true }); }
