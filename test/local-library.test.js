import test from 'node:test';
import assert from 'node:assert/strict';
import { readLocalFile, addDocument, localSnapshot, MAX_FILE_BYTES, MAX_LIBRARY_BYTES, MAX_DOCUMENTS } from '../src/library.js';

test('local files accept UTF-8 Markdown and text, but reject invalid or oversized files', async () => {
  const doc = await readLocalFile(new File(['# Café\n\n你好'], 'notes.md'));
  assert.equal(doc.title, 'Café'); assert.equal(doc.content, '# Café\n\n你好');
  assert.equal((await readLocalFile(new File(['# Literal text'], 'notes.txt'))).title, 'notes');
  assert.equal((await readLocalFile(new File([], 'empty.md'))).content, '');
  for (const file of [new File(['text'], 'a.pdf'), new File([new Uint8Array([255])], 'a.md'),
    new File(['\0'], 'a.md'), new File(['text'], 'folder/a.md'), new File([new Uint8Array(MAX_FILE_BYTES + 1)], 'a.md')]) {
    await assert.rejects(readLocalFile(file));
  }
});
test('colliding filenames get numbered copies without changing existing files', async () => {
  const doc = await readLocalFile(new File(['# First'], 'notes.md'));
  const first = addDocument(null, doc);
  const second = addDocument(first.snapshot, { ...doc, content: '# Second' });
  assert.equal(first.snapshot.documents.length, 1, 'input snapshot is not mutated');
  assert.equal(second.document.id, 'notes (2).md');
  assert.equal(second.snapshot.documents[0].content, '# First');
  assert.equal(addDocument(second.snapshot, doc).document.id, 'notes (3).md');
});
test('local capacity checks leave the saved snapshot intact', () => {
  const doc = { id: 'a.md', title: 'A', content: 'a', bytes: 1 };
  const full = { documents: Array.from({ length: MAX_DOCUMENTS }, (_, i) => ({ ...doc, id: `${i}.md` })) };
  assert.throws(() => addDocument(full, doc), /1,000/);
  const large = { documents: [{ ...doc, bytes: MAX_LIBRARY_BYTES }] };
  assert.throws(() => addDocument(large, doc), /1024 MiB/);
  assert.equal(large.documents.length, 1);
});
test('downloaded documents retain content and the old reading-position key without a connection', () => {
  const saved = { server: 'https://old-library.example', revision: 'old', documents: [
    { id: 'notes/a.md', title: 'A', content: '# A', hash: 'old-hash', bytes: 3 },
  ] };
  const local = localSnapshot(saved);
  assert.equal(local.documents[0].positionKey, 'https://old-library.example\nnotes/a.md');
  assert.equal(local.documents[0].content, '# A');
  assert.equal(local.server, undefined); assert.equal(local.revision, undefined);
  assert.deepEqual(localSnapshot(local), local, 'conversion is idempotent');
  assert.equal(saved.server, 'https://old-library.example', 'migration does not mutate old data');
});
