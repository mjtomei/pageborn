import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { speechDownloader } from '../src/speech-download.js';
import { speechDownloads, speechDownloadOrigins } from '../src/speech-download-config.js';
import { askManifest } from '../ai/build.js';

const bytes = new TextEncoder().encode('known model bytes');
const entry = { local: 'test/model.onnx', url: 'https://huggingface.co/test/pinned/model.onnx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
const base = 'https://app.test/stt/';
const local = new URL(entry.local, base).href;
function store() {
  const rows = new Map();
  return { rows, async open() { return {
    async match(key) { return rows.get(key)?.clone(); },
    async put(key, response) { rows.set(key, new Response(await response.arrayBuffer(), { headers: response.headers })); },
    async delete(key) { return rows.delete(key); },
  }; } };
}
test('pinned models download with progress, verify and reload from cache offline', async () => {
  const storage = store(), progress = []; let calls = 0;
  const loader = speechDownloader({ base, entries: [entry], storage, progress: text => progress.push(text), fetch: async (url, options) => {
    calls++; assert.equal(url, entry.url); assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.headers, undefined); return new Response(bytes);
  } });
  assert.deepEqual(new Uint8Array(await (await loader.fetch(local)).arrayBuffer()), bytes);
  assert.equal(calls, 1); assert(progress.some(text => text.includes('Downloading')));
  assert.equal(loader.stats.downloadedBytes, bytes.length);
  const warm = speechDownloader({ base, entries: [entry], storage, fetch: () => { throw new Error('offline'); } });
  assert.deepEqual(new Uint8Array(await (await warm.fetch(local)).arrayBuffer()), bytes);
  assert.equal(warm.stats.downloadedBytes, 0); assert.equal(warm.stats.cachedBytes, bytes.length);
});
test('truncated and corrupt downloads cannot be cached; retry succeeds', async () => {
  for (const bad of [bytes.subarray(0, 5), new Uint8Array(bytes.length), new Uint8Array(bytes.length + 1)]) {
    const storage = store();
    const loader = speechDownloader({ base, entries: [entry], storage, fetch: async () => new Response(bad) });
    await assert.rejects(async () => (await loader.fetch(local)).arrayBuffer(), /integrity/);
    assert.equal(storage.rows.size, 0);
    const retry = speechDownloader({ base, entries: [entry], storage, fetch: async () => new Response(bytes) });
    await (await retry.fetch(local)).arrayBuffer(); assert.equal(storage.rows.size, 1);
  }
});
test('unavailable cache and quota failures still allow inference', async () => {
  for (const storage of [null, { open: async () => { throw new Error('denied'); } }, { open: async () => ({ match: async () => null, put: async () => { throw new Error('quota'); } }) }]) {
    const loader = speechDownloader({ base, entries: [entry], storage, fetch: async () => new Response(bytes) });
    assert.deepEqual(new Uint8Array(await (await loader.fetch(local)).arrayBuffer()), bytes);
    assert.equal(loader.stats.cacheAvailable, false);
  }
});
test('cache corruption is rejected and removed before retry', async () => {
  const storage = store();
  storage.rows.set(entry.url, new Response(new Uint8Array(bytes.length), { headers: { 'x-pageborne-sha256': entry.sha256, 'content-length': String(bytes.length) } }));
  const loader = speechDownloader({ base, entries: [entry], storage, fetch: () => { throw new Error('should read cache'); } });
  await assert.rejects(async () => (await loader.fetch(local)).arrayBuffer(), /integrity/); assert.equal(storage.rows.size, 0);
});
test('a completed weight survives failure of another file and is reused on retry', async () => {
  const storage = store(), second = { ...entry, local: 'test/second.onnx', url: `${entry.url}?second` }, entries = [entry, second];
  const loader = speechDownloader({ base, entries, storage, fetch: async url => url === entry.url ? new Response(bytes) : new Response('', { status: 503 }) });
  await (await loader.fetch(local)).arrayBuffer(); 
  await assert.rejects(loader.fetch(new URL(second.local, base).href), /retry voice/);
  const calls = [];
  const retry = speechDownloader({ base, entries, storage, fetch: async url => { calls.push(url); return new Response(bytes); } });
  for (const item of entries) await (await retry.fetch(new URL(item.local, base).href)).arrayBuffer();
  assert.deepEqual(calls, [second.url]);
});
test('concurrent decoder requests download once and share the verified disk cache', async () => {
  const storage = store(); let requests = 0;
  const loader = speechDownloader({ base, entries: [entry], storage, fetch: async () => { requests++; return new Response(bytes); } });
  const load = async () => new Uint8Array(await (await loader.fetch(local)).arrayBuffer());
  const results = await Promise.all([load(), load(), load()]);
  assert(results.every(row => Buffer.from(row).equals(bytes))); assert.equal(requests, 1);
});
test('a metadata-only caller never blocks the subsequent weight reader', async () => {
  const storage = store(); let requests = 0;
  const loader = speechDownloader({ base, entries: [entry], storage, fetch: async () => { requests++; return new Response(bytes); } });
  const metadata = await loader.fetch(local); assert.equal(metadata.headers.get('content-length'), String(bytes.length));
  assert.deepEqual(new Uint8Array(await (await loader.fetch(local)).arrayBuffer()), bytes);
  assert.equal(requests, 1); await metadata.body.cancel();
});
test('only exact weight paths are intercepted; bundled files keep their original fetch', async () => {
  const calls = []; const loader = speechDownloader({ base, entries: [entry], storage: null, fetch: async (...args) => { calls.push(args); return new Response('local'); } });
  const options = { headers: { test: 'local' } };
  await loader.fetch('/stt/test/config.json', options);
  await loader.fetch('https://elsewhere.test/stt/test/model.onnx', options);
  assert.deepEqual(calls, [['/stt/test/config.json', options], ['https://elsewhere.test/stt/test/model.onnx', options]]);
});
test('stalled initial requests abort and offer retry', async () => {
  const loader = speechDownloader({ base, entries: [entry], storage: null, stallMs: 10, fetch: async (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')))) });
  await assert.rejects(loader.fetch(local), /retry voice/);
});
test('package permission includes fixed model origins independently of private AI origins', () => {
  assert.equal(speechDownloads.length, 2);
  assert.equal(speechDownloads.reduce((sum, row) => sum + row.bytes, 0), 585972125);
  assert(speechDownloads.every(row => row.sha256.length === 64 && row.url.includes('/482fb8ba081b6e906f92efe103622316b2a0cc69/')));
  const release = askManifest({ permissions: [] }, [], speechDownloadOrigins);
  assert.deepEqual(release.permissions.find(row => row.name === 'network').whitelist, speechDownloadOrigins);
});
