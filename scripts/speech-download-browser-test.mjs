// IndexedDB model caching + streaming integrity in Chromium and desktop WebKit.
// Small deterministic weights exercise transport/cache behavior, not inference.
import { chromium, webkit } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Prebundle the package modules dynamically imported by this cache test before
// navigation, so Vite cannot invalidate the page midway through an IDB write.
const server = await createServer({ mode: 'debug', optimizeDeps: { include: ['@pageborne/browser-stt/speech-download', '@pageborne/browser-stt/speech-model-cache'] }, server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const results = { passed: false, physicalPhone: false, browsers: [] };
try {
  for (const [name, engine] of [['chrome', chromium], ['webkit', webkit]]) {
    const profile = await mkdtemp(path.join(os.tmpdir(), 'pageborne-download-test-'));
    const options = { headless: true, ...(name === 'chrome' ? { executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] } : process.env.WEBKIT_PATH ? { executablePath: process.env.WEBKIT_PATH } : {}) };
    let browser = await engine.launchPersistentContext(profile, options);
    try {
      let page = await browser.newPage(); await page.goto(origin);
      // Same-origin, fresh JS scope after navigation; cache must survive it.
      const run = async mode => page.evaluate(async mode => {
        const { speechDownloader, SPEECH_CACHE } = await import('/src/speech-download.js');
        const { speechModelStorage } = await import('/src/speech-model-cache.js');
        const bytes = new Uint8Array(9 * 1024 * 1024 + 17); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
        const entry = { local: 'model/weights.onnx', url: `${location.origin}/test-immutable-weights`, bytes: bytes.length, sha256: hash };
        const base = new URL('/stt/', location.href).href; let requests = 0; const progress = [];
        const cache = await speechModelStorage.open(SPEECH_CACHE);
        if (mode === 'cold' || mode === 'corrupt') await cache.delete(entry.url);
        const before = await cache.match(entry.url);
        const cachedHeaders = before ? Object.fromEntries(before.headers) : null;
        const loader = speechDownloader({ base, entries: [entry], progress: value => progress.push(value), fetch: async () => {
          requests++; if (mode === 'warm') throw new Error('offline');
          let offset = 0;
          return new Response(new ReadableStream({ pull(sink) {
            if (offset === bytes.length) return sink.close();
            const end = Math.min(bytes.length, offset + 65536); const chunk = bytes.slice(offset, end); offset = end;
            if (mode === 'corrupt' && offset === bytes.length) chunk[0] ^= 1;
            sink.enqueue(chunk);
          } }));
        } });
        let size, error;
        try { size = (await (await loader.fetch(new URL(entry.local, base).href)).arrayBuffer()).byteLength; }
        catch (failure) { error = loader.error?.message || failure.message; }
        
        const cached = !!await cache.match(entry.url); cache.close();
        const chunks = await new Promise((resolve, reject) => {
          const opening = indexedDB.open(SPEECH_CACHE); opening.onerror = () => reject(opening.error);
          opening.onsuccess = () => { const db = opening.result; const count = db.transaction('chunks').objectStore('chunks').count(); count.onsuccess = () => { resolve(count.result); db.close(); }; count.onerror = () => reject(count.error); };
        });
        return { mode, size, error, requests, progress: progress.length, stats: loader.stats, cachedHeaders, cached, chunks };
      }, mode);
      const cold = await run('cold'); assert.equal(cold.size, 9437201); assert.equal(cold.requests, 1); assert(cold.cached && cold.progress > 0); assert.equal(cold.chunks, 3);
      await browser.close(); browser = await engine.launchPersistentContext(profile, options);
      page = await browser.newPage(); await page.goto(origin);
      const warm = await run('warm'); assert.equal(warm.size, cold.size); assert.equal(warm.requests, 0); assert.equal(warm.stats.downloadedBytes, 0);
      const corrupt = await run('corrupt'); assert.match(corrupt.error, /integrity/); assert(!corrupt.cached); assert.equal(corrupt.chunks, 0, 'Failed downloads leave no chunks behind');
      const retry = await run('retry'); assert.equal(retry.size, cold.size); assert(retry.cached);
      results.browsers.push({ name, cold, warm, corrupt, retry });
    } finally { await browser.close(); await rm(profile, { recursive: true, force: true }); }
  }
  results.passed = true;
} finally {
  await server.close(); await mkdir('test-results/speech-download', { recursive: true });
  await writeFile('test-results/speech-download/results.json', JSON.stringify(results, null, 2));
}
console.log(JSON.stringify(results, null, 2));
