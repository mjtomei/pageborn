import test from 'node:test';
import assert from 'node:assert/strict';
import { PdfWork } from '../src/pdf-work.js';

test('PDF preparation, preview and cleanup share one lane; abandoned previews never render', async () => {
  const work = new PdfWork(); const calls = []; let release;
  const prepare = work.run(async () => { calls.push('prepare'); await new Promise(resolve => { release = resolve; }); });
  const controller = new AbortController();
  const stale = work.run(() => { calls.push('stale'); }, controller.signal);
  const cancelled = assert.rejects(stale, /preview closed/);
  const preview = work.run(() => { calls.push('preview'); });
  const cleanup = work.run(() => { calls.push('cleanup'); });
  controller.abort(); await cancelled;
  assert.equal(work.jobs.length, 2); assert.deepEqual(calls, ['prepare']);
  release(); await Promise.all([prepare, preview, cleanup]);
  assert.deepEqual(calls, ['prepare', 'preview', 'cleanup']);
  await assert.rejects(work.run(() => { throw new Error('bad page'); }), /bad page/);
  assert.equal(await work.run(() => 'next page'), 'next page');
});

test('closing a PDF rejects queued previews immediately without waiting for a suspended worker', async () => {
  const work = new PdfWork(); let release;
  const active = work.run(() => new Promise(resolve => { release = resolve; }));
  const queued = work.run(() => assert.fail('closed work ran'));
  const rejected = assert.rejects(queued, /PDF closed/);
  work.close(); await rejected;
  await assert.rejects(work.run(() => {}), /PDF closed/);
  release(); await active;
});
