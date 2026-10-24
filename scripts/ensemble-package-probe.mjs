// Add inactive, checksum-pinned ensemble assets to an isolated debug build.
// Run after building that checkout, then use its normal pack.mjs --debug.
import { readFile, writeFile, mkdir, copyFile, rm, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const reader = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const args = process.argv.slice(2);
const positional = args.filter(arg => !arg.startsWith('--'));
if (!positional[0] || positional.length > 2 || args.some(arg => arg.startsWith('--') && arg !== '--chunked')) {
  throw Error('Usage: node scripts/ensemble-package-probe.mjs ISOLATED_CHECKOUT [STT_CHECKOUT] [--chunked]');
}
const target = await realpath(path.resolve(positional[0]));
if (!positional[1] && !process.env.BROWSER_STT_RESEARCH) throw Error('Supply STT_CHECKOUT or set BROWSER_STT_RESEARCH.');
const speech = path.resolve(positional[1] || process.env.BROWSER_STT_RESEARCH);
const chunked = args.includes('--chunked');
if (target === reader) throw Error('Use an isolated built checkout as the first argument.');
const dist = path.join(target, 'dist');
const profile = JSON.parse(await readFile(path.join(dist, 'build-info.json')));
if (profile.channel !== 'debug') throw Error('The model-package probe is private debug only.');
const selection = JSON.parse(await readFile(path.join(speech, 'benchmarks/ensemble-selection.json')));
const provenance = JSON.parse(await readFile(path.join(speech, 'benchmarks/ensemble-provenance.json')));
const pins = new Map(provenance.modelFiles.map(f => [f.file.replace(/^models\//, ''), f]));
const manifest = { version: profile.version, inferenceEnabled: false, chunked, models: [], totalBytes: 0 };
// This directory belongs only to this probe. Clear it so switching chunk formats
// cannot silently leave duplicate copies of the same model in the next package.
await rm(path.join(dist, 'ensemble-models'), { recursive: true, force: true });
for (const model of selection.measuredModelFiles) {
  const entry = { name: model.model, files: [], bytes: 0 };
  for (const file of model.files) {
    const source = path.join(speech, '.state/ensemble/models', file.file);
    const bytes = await readFile(source), hash = createHash('sha256').update(bytes).digest('hex');
    const pin = pins.get(file.file);
    if (!pin || pin.bytes !== bytes.length || pin.sha256 !== hash || bytes.length !== file.bytes) throw Error(`Unverified asset: ${file.file}`);
    const local = `ensemble-models/${file.file}`, destination = path.join(dist, local);
    await mkdir(path.dirname(destination), { recursive: true });
    const item = { file: local, bytes: bytes.length, sha256: hash };
    if (chunked && bytes.length > 32 * 1024 * 1024) {
      item.parts = [];
      for (let at = 0; at < bytes.length; at += 32 * 1024 * 1024) {
        const chunk = bytes.subarray(at, at + 32 * 1024 * 1024), suffix = `.part${item.parts.length}`;
        await writeFile(destination + suffix, chunk);
        item.parts.push({ file: local + suffix, bytes: chunk.length, sha256: createHash('sha256').update(chunk).digest('hex') });
      }
      await rm(destination, { force: true });
    } else await copyFile(source, destination);
    entry.files.push(item); entry.bytes += bytes.length;
  }
  manifest.models.push(entry); manifest.totalBytes += entry.bytes;
}
await writeFile(path.join(dist, 'ensemble-models.json'), JSON.stringify(manifest, null, 2));
const licenses = path.join(dist, 'licenses/ensemble-models'); await mkdir(licenses, { recursive: true });
for (const [name, url] of [
  ['conformer-Apache-2.0.txt', 'https://raw.githubusercontent.com/NVIDIA/NeMo/main/LICENSE'],
  ['zipformer-Apache-2.0.txt', 'https://raw.githubusercontent.com/k2-fsa/icefall/master/LICENSE'],
]) {
  const r = await fetch(url); if (!r.ok) throw Error(`Could not retrieve ${name}`);
  const license = await r.text(); if (!license.includes('Apache License')) throw Error(`Unexpected ${name}`);
  await writeFile(path.join(licenses, name), license);
}
await copyFile(path.join(speech, 'vendor/stt/moonshine-LICENSE'), path.join(licenses, 'moonshine-LICENSE.txt'));
await writeFile(path.join(licenses, 'NOTICE.txt'), 'Inactive model-package probe. Conformer CTC Small: NVIDIA NeMo, ONNX conversion distributed by k2-fsa. Zipformer 20M: k2-fsa icefall/sherpa-onnx. Moonshine Base: Moonshine AI, ONNX conversion by onnx-community. Exact files and hashes: ensemble-models.json. No new inference code is enabled.\n');
await build({ entryPoints: [path.join(reader, 'scripts/ensemble-probe-worker.js')], bundle: true, format: 'esm', target: 'es2022', outfile: path.join(dist, 'ensemble-probe-worker.js') });
await copyFile(path.join(reader, 'scripts/ensemble-probe-ui.js'), path.join(dist, 'ensemble-probe-ui.js'));
const htmlPath = path.join(dist, 'index.html'), html = await readFile(htmlPath, 'utf8');
if (!html.includes('ensemble-probe-ui.js')) await writeFile(htmlPath, html.replace('</body>', '<script type="module" src="./ensemble-probe-ui.js"></script></body>'));
await writeFile(path.join(target, 'ensemble-probe-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ version: profile.version, modelBytes: manifest.totalBytes, models: manifest.models.map(m => ({ name: m.name, bytes: m.bytes })), retainsTiny: true, inferenceEnabled: false }));
