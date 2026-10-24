import test from 'node:test';
import assert from 'node:assert/strict';
import { ImportQueue } from '../src/import-queue.js';
import { readLocalFile } from '../src/library.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('imports accept more files while busy and complete independently with bounded concurrency', async () => {
  const reads = new Map(); const reports = new Map(); const saved = []; let live = 0; let maximum = 0;
  const queue = new ImportQueue({
    prepare: async (file, progress) => {
      const wait = deferred(); reads.set(file.name, wait); reports.set(file.name, progress);
      maximum = Math.max(maximum, ++live);
      try { await wait.promise; return { id: file.name }; } finally { live--; }
    },
    save: async doc => { saved.push(doc.id); return doc; },
  });
  const [slow, fast] = queue.enqueue([new File(['text'], 'slow.md'), new File(['text'], 'fast.md')]);
  const [later] = queue.enqueue([new File(['text'], 'later.md')]);
  assert.equal(later.phase, 'queued');
  reports.get('slow.md')({ phase: 'reading', loaded: 2, total: 4 });
  assert.equal(slow.loaded, 2);
  reads.get('fast.md').resolve(); await tick();
  assert.equal(fast.phase, 'done'); assert.equal(slow.phase, 'reading'); assert.equal(later.phase, 'reading');
  assert.deepEqual(saved, ['fast.md']);
  queue.clearFinished(); assert.deepEqual(queue.jobs, [slow, later]);
  reads.get('slow.md').reject(new Error('Could not read this file'));
  reads.get('later.md').resolve(); await queue.idle();
  assert.equal(slow.phase, 'failed'); assert.match(slow.error, /Could not read/);
  assert.equal(later.phase, 'done'); assert.equal(maximum, 2);
  assert.ok([slow, fast, later].every(job => job.file === null), 'release original File references');
  queue.clearFinished(); assert.equal(queue.jobs.length, 0);
});

test('a file is only Added after its transaction commits and storage errors do not stop the queue', async () => {
  const commit = deferred();
  const queue = new ImportQueue({ concurrency: 1, prepare: async file => ({ id: file.name }),
    save: async doc => { if (doc.id === 'full.md') { await commit.promise; throw new DOMException('No space', 'QuotaExceededError'); } return doc; },
  });
  const [first, second] = queue.enqueue([new File([], 'full.md'), new File([], 'good.md')]);
  await tick(); assert.equal(first.phase, 'saving'); assert.equal(second.phase, 'queued');
  commit.resolve(); await queue.idle();
  assert.equal(first.phase, 'failed'); assert.match(first.error, /storage is full/);
  assert.equal(second.phase, 'done');
});

test('chunked reads report actual bytes and preserve multibyte UTF-8 across chunk boundaries', async () => {
  const source = 'x'.repeat(128 * 1024 - 1) + '👓 café 你好\n' + 'long word '.repeat(17000);
  const file = new File([source], 'large.md'); const progress = [];
  const doc = await readLocalFile(file, event => progress.push(event));
  assert.equal(doc.content, source); assert.equal(doc.bytes, file.size); assert.ok(doc.words > 34000);
  const reading = progress.filter(p => p.phase === 'reading');
  assert.equal(reading[0].loaded, 0); assert.equal(reading.at(-1).loaded, file.size);
  assert.ok(reading.some(p => p.loaded > 0 && p.loaded < p.total));
  assert.equal(progress.at(-1).phase, 'checking');
  const broken = new File([new Uint8Array([0xf0, 0x9f])], 'broken.md');
  await assert.rejects(readLocalFile(broken), /UTF-8/);
});
