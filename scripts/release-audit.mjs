import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';

// Inspect only files eligible for the source snapshot. Local deployment values
// are read solely as redacted search needles, never printed or copied.
const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean))].filter(existsSync);
const needles = new Set();
for (const file of ['.env.local', '.env.debug.local', '.env.web.local']) {
  if (!existsSync(file)) continue;
  const env = parseEnv(readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (/^PAGEBORNE_(?:DEBUG_|WEB_).*(?:ORIGINS|URLS?|UPSTREAM)$/.test(key)) {
      for (const item of value.split(',')) {
        try { const url = new URL(item.trim()); if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) { needles.add(url.origin); needles.add(url.hostname); } } catch { /* Config validation handles malformed settings. */ }
      }
    }
    if (['PAGEBORNE_DEBUG_TERMINAL_STATE', 'PAGEBORNE_WEB_TOKEN_FILE', 'EVEN_TERMINAL_STATE_DIR'].includes(key)) {
      needles.add(value);
      const tokenFile = key === 'EVEN_TERMINAL_STATE_DIR' ? `${value}/token` : value;
      if (existsSync(tokenFile)) {
        const text = readFileSync(tokenFile, 'utf8').trim();
        try { const token = JSON.parse(text).token; if (typeof token === 'string' && token.length >= 16) needles.add(token); }
        catch { if (text.length >= 16 && !/\s/.test(text)) needles.add(text); }
      }
    }
  }
}
const problems = [];
const home = homedir();
function inspect(name, data) {
  if (/(^|\/)(?:\.state|node_modules|test-results|playwright-report|\.git)(\/|$)|\.ehpk$|(^|\/)\.env(?:$|\.(?!example$)[^/]+$)/.test(name)) problems.push(`${name}: private/generated file`);
  if (data.length > 100 * 1024 * 1024) problems.push(`${name}: exceeds the source file size limit`);
  // The prebuilt ONNX Runtime dependency contains its public Actions build root.
  // Normalize that exact upstream root, not arbitrary compiler paths or binaries.
  const paths = data.toString('utf8').replaceAll('/home/runner/work/onnxruntime-build/onnxruntime-build/', '/upstream/onnxruntime/');
  if (home !== '/' && paths.includes(home + '/')) problems.push(`${name}: current user's absolute home path`);
  for (const value of needles) if (data.includes(Buffer.from(value))) { problems.push(`${name}: private deployment value`); break; }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(data.toString('utf8'))) problems.push(`${name}: private key material`);
}
for (const file of files) {
  const data = readFileSync(file);
  inspect(file, data);
  if (file.endsWith('.tgz') || file.startsWith('vendor/packages/')) problems.push(`${file}: obsolete vendored package`);
}
if (process.argv.includes('--built')) {
  function inspectBuilt(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) { inspectBuilt(file); continue; }
      const bytes = readFileSync(file);
      const data = file.endsWith('.gz') ? gunzipSync(bytes) : bytes;
      inspect(file, data);
    }
  }
  for (const directory of ['dist-release', 'dist-web']) {
    if (existsSync(directory)) inspectBuilt(directory);
    else problems.push(`${directory}: build before checking public artifacts`);
  }
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (!/^git\+https:\/\/github\.com\/mjtomei\/browser-stt\.git#[a-f0-9]{40}$/.test(pkg.dependencies['@pageborne/browser-stt'])) problems.push('package.json: Browser STT must use a full pinned source revision');
const fontSource = 'vendor/licenses/liberation/liberation-fonts-1.07.4.tar.gz';
if (!existsSync(fontSource) || createHash('sha256').update(readFileSync(fontSource)).digest('hex') !== 'ad98b7498dc2992f7f0868f79b65ce4a720a3acdb63ab3f1f1cb6881117a5406') problems.push('Liberation font source archive missing or changed');
if (pkg.scripts.build !== 'npm run build:release' || pkg.scripts.pack !== 'npm run pack:release') problems.push('package.json: public build/pack must default to release');
for (const file of ['.env.local', '.env.debug.local', '.env.web.local']) {
  try { execFileSync('git', ['check-ignore', '--no-index', file], { stdio: 'ignore' }); }
  catch { problems.push(`${file}: must be ignored`); }
}
if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
else console.log(`Source audit passed: ${files.length} files; private config excluded; pinned source dependency checked.`);
