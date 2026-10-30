import test from 'node:test';
import assert from 'node:assert/strict';
import { AtomicPhoneValue, PhoneLibrary, PhonePreferences, STORAGE_PREFIX, CHUNK_CHARS } from '../src/phone-storage.js';
import { localSnapshot, readLocalFile } from '../src/library.js';

function memoryPhone() {
  const values = new Map();
  return { values, failure: null, async get(key) { return values.get(key) || ''; },
    async set(key, value) { if (this.failure?.(key, value)) throw new Error('Storage write failed'); values.set(key, value); } };
}
const document = (text = '# Kept\n\nSaved on the phone', name = 'kept.md') => readLocalFile(new File([text], name));

test('phone documents survive a fresh library with no browser state, and deletions stay deleted', async () => {
  const kv = memoryPhone(); const first = new PhoneLibrary(kv); await first.read();
  const text = '# Long\n\n' + 'a'.repeat(CHUNK_CHARS - 9) + '👓 café\n'.repeat(16000);
  const progress = []; await first.save(await document(text), value => progress.push(value));
  assert.ok(progress.length > 3); assert.equal(progress.at(-1).loaded, progress.at(-1).total);
  const second = new PhoneLibrary(kv);
  assert.equal((await second.read()).documents[0].content, text);
  await second.remove('kept.md');
  assert.equal((await new PhoneLibrary(kv).read(first.snapshot)).documents.length, 0, 'stale browser copies cannot resurrect deleted files');
  assert.ok([...kv.values].filter(([key]) => key.includes(':doc:')).every(([, value]) => value === ''), 'deleted body chunks are cleared');
});

test('failed chunks and interrupted index commits preserve the previous complete library', async () => {
  for (const location of ['body', 'index', 'pointer']) {
    const kv = memoryPhone(); const first = new PhoneLibrary(kv); await first.read(); await first.save(await document());
    kv.failure = (key, value) => value && (location === 'body' ? key.includes(':doc:') : location === 'index' ? /:library:[ab]:\d+$/.test(key) : key === `${STORAGE_PREFIX}:library`);
    await assert.rejects(first.save(await document('# New\n\n' + 'text '.repeat(10000), 'new.md')), /Storage write failed/);
    kv.failure = null;
    const reopened = new PhoneLibrary(kv); const restored = await reopened.read();
    assert.deepEqual(restored.documents.map(d => d.id), ['kept.md']);
    assert.equal(kv.values.get(`${STORAGE_PREFIX}:pending`), '', 'restart cleans an interrupted import journal');
    await reopened.save(await document('# Retry', 'new.md'));
    assert.equal((await new PhoneLibrary(kv).read()).documents.length, 2);
  }
});

test('phone migration resumes without duplicate files and preserves old bookmark keys', async () => {
  const kv = memoryPhone(); const old = localSnapshot({ server: 'https://old.example', documents: [await document('# First', 'first.md'), await document('# Second', 'second.md')] });
  let bodies = 0; kv.failure = key => key.includes(':doc:') && ++bodies === 2;
  await assert.rejects(new PhoneLibrary(kv).read(old)); kv.failure = null;
  const restored = await new PhoneLibrary(kv).read(old);
  assert.deepEqual({ ...restored, documents: restored.documents.map(({ revision, sha256, ...doc }) => doc) }, old);
});

test('concurrent saves use distinct names and index commits never lose an import', async () => {
  const kv = memoryPhone(); const store = new PhoneLibrary(kv); await store.read();
  await Promise.all([store.save(await document('# One')), store.save(await document('# Two'))]);
  assert.deepEqual((await new PhoneLibrary(kv).read()).documents.map(d => d.id), ['kept.md', 'kept (2).md']);
});

test('incomplete saved content fails visibly without resetting the phone library', async () => {
  const kv = memoryPhone(); const store = new PhoneLibrary(kv); await store.read(); await store.save(await document());
  const pointer = kv.values.get(`${STORAGE_PREFIX}:library`);
  const bodyKey = [...kv.values.keys()].find(key => key.includes(':doc:')); kv.values.set(bodyKey, 'truncated');
  await assert.rejects(new PhoneLibrary(kv).read(), /incomplete/);
  assert.equal(kv.values.get(`${STORAGE_PREFIX}:library`), pointer);
});

test('large preference values commit atomically and coalesce to the latest reading position', async () => {
  const kv = memoryPhone(); const errors = [];
  const preferences = new PhonePreferences(kv, error => errors.push(error), 0);
  await preferences.read({});
  const state = { positions: { 'local\nkept.md': { percent: 20 } }, bookmarks: ['x'.repeat(CHUNK_CHARS * 2)] };
  preferences.schedule(state); await preferences.flush();
  preferences.schedule({ ...state, size: 12 }); preferences.schedule({ ...state, size: 26 }); await preferences.flush();
  const fresh = new PhonePreferences(kv, error => errors.push(error));
  assert.equal((await fresh.read({})).size, 26);
  kv.failure = key => /:preferences:[ab]:1$/.test(key);
  preferences.schedule({ ...state, size: 22 }); await preferences.flush(); kv.failure = null;
  assert.equal((await new AtomicPhoneValue(kv, 'preferences').read()).size, 26);
  assert.equal(errors.length, 1);
});

test('an idle preference flush and reverting an unsaved change do not block later saves', async () => {
  const kv = memoryPhone(); const preferences = new PhonePreferences(kv, error => { throw error; });
  await preferences.read({}); await preferences.flush();
  preferences.schedule({ position: 1 }); await preferences.flush();
  preferences.schedule({ position: 2 }); preferences.schedule({ position: 1 }); await preferences.flush();
  assert.deepEqual(await new AtomicPhoneValue(kv, 'preferences').read(), { position: 1 });
  preferences.schedule({ position: 3 }); await preferences.flush();
  assert.deepEqual(await new AtomicPhoneValue(kv, 'preferences').read(), { position: 3 });
});

test('a newer local position survives reopening before the phone write commits', async () => {
  const kv = memoryPhone(); const old = { updatedAt: 100, mode: 'speed', positions: { paper: { percent: 20 } } };
  await new AtomicPhoneValue(kv, 'preferences').write(old);
  const newer = { updatedAt: 200, mode: 'auto', positions: { paper: { percent: 40 } } };
  const preferences = new PhonePreferences(kv, error => { throw error; });
  assert.deepEqual(await preferences.read(newer), newer);
  preferences.schedule(newer); await preferences.flush();
  assert.deepEqual(await new PhonePreferences(kv).read(old), newer, 'newer phone data still wins over an older browser copy');
  assert.deepEqual(await new PhonePreferences(kv).read({}), newer, 'a fresh WebView retains phone persistence');
});

test('a library above 64 MiB opens metadata only and loads one requested body', async () => {
  const kv = memoryPhone(), store = new PhoneLibrary(kv, { lazy: true }); await store.read();
  const text = 'x'.repeat(4 * 1024 * 1024);
  for (let i = 0; i < 17; i++) await store.save(await document(text, `${i}.txt`));
  assert.equal(store.snapshot.documents.reduce((sum, doc) => sum + doc.bytes, 0), 68 * 1024 * 1024);
  assert(store.snapshot.documents.every(doc => !('content' in doc)));
  const reads = [], get = kv.get.bind(kv); kv.get = key => { reads.push(key); return get(key); };
  const fresh = new PhoneLibrary(kv, { lazy: true });
  const snapshot = await fresh.read(() => { throw Error('Already migrated: legacy data must not load'); });
  assert.equal(reads.filter(key => key.includes(':doc:')).length, 0);
  const selected = snapshot.documents[7];
  assert.equal((await fresh.loadDocument(selected)).content, text);
  assert(reads.filter(key => key.includes(':doc:')).every(key => key.startsWith(selected.revision + ':')));
  assert(snapshot.documents.every(doc => !('content' in doc)), 'opening must not pin bodies in the catalog');
});

test('lazy file reads detect corruption independently and can be cancelled between chunks', async () => {
  const kv = memoryPhone(), store = new PhoneLibrary(kv, { lazy: true }); await store.read();
  await store.save(await document('a'.repeat(CHUNK_CHARS * 3), 'large.txt'));
  await store.save(await document('still readable', 'other.txt'));
  const [large, other] = store.snapshot.documents;
  const controller = new AbortController(), get = kv.get.bind(kv); let chunks = 0;
  kv.get = async key => { if (key.startsWith(large.revision + ':') && ++chunks === 1) controller.abort(); return get(key); };
  await assert.rejects(store.loadDocument(large, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(chunks, 1);
  kv.get = get; kv.values.set(`${large.revision}:0`, 'corrupt');
  const reopened = new PhoneLibrary(kv, { lazy: true }); await reopened.read();
  await assert.rejects(reopened.loadDocument(large), /incomplete/);
  assert.equal((await reopened.loadDocument(other)).content, 'still readable');
});

test('lazy replacement checks revisions, keeps old saves on failure, and never compares absent bodies as equal', async () => {
  const kv = memoryPhone(), store = new PhoneLibrary(kv, { lazy: true }); await store.read();
  await store.save(await document('old')); const expected = store.snapshot.documents[0];
  kv.failure = key => key.includes(':doc:');
  await assert.rejects(store.put(await document('failed'), expected)); kv.failure = null;
  assert.equal((await store.loadDocument(expected)).content, 'old');
  await store.put(await document('new'), expected);
  await assert.rejects(store.put(await document('stale overwrite'), expected), /changed during sync/);
  await assert.rejects(store.remove(expected.id, expected), /changed during sync/);
  await assert.rejects(store.loadDocument(expected), /changed during sync/);
  assert.equal((await store.loadDocument(store.snapshot.documents[0])).content, 'new');
});
