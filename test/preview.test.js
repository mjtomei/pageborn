import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';

test('prototype hosting serves static app files and exposes no former server endpoints', async t => {
  const distDir = await mkdtemp(path.join(os.tmpdir(), 'reader-preview-'));
  await writeFile(path.join(distDir, 'index.html'), 'Local reader');
  const server = createApp({ distDir }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(distDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await (await fetch(origin)).text(), 'Local reader');
  for (const route of ['/api/library', '/api/document?id=a.md', '/api/state', '/api/health', '/api/debug/sessions', '/.state/token']) {
    assert.equal((await fetch(origin + route)).status, 404, route);
  }
  assert.equal((await fetch(origin + '/api/import?name=a.md', { method: 'POST', body: 'text' })).status, 404);
});
