import { bytesToBase64 } from './binary.js';
import { libraryTimestamp } from './library-order.js';

export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_PDF_BYTES = 16 * 1024 * 1024;
export const MAX_LIBRARY_BYTES = 64 * 1024 * 1024;
export const MAX_DOCUMENTS = 1000;
const encoder = new TextEncoder();
export function countWords(text) {
  let words = 0; const pattern = /\S+/g;
  while (pattern.exec(text)) words++;
  return words;
}

// Keep the old database and snapshot key so an upgrade retains downloaded files.
// positionKey preserves bookmarks/positions without depending on a connection.
export function localSnapshot(saved) {
  return { localVersion: 1, documents: (saved?.documents || []).map(doc => ({
    id: doc.id, title: doc.title, content: doc.content,
    bytes: doc.bytes ?? encoder.encode(doc.content).length,
    words: doc.words ?? countWords(doc.content),
    positionKey: doc.positionKey || `${saved?.server || 'local'}\n${doc.id}`,
    ...(libraryTimestamp(doc.addedAt) ? { addedAt: doc.addedAt } : {}),
    ...(libraryTimestamp(doc.modifiedAt) ? { modifiedAt: doc.modifiedAt } : {}),
    ...(doc.format === 'pdf' ? { format: 'pdf' } : {}),
  })) };
}

export async function readLocalFile(file, onProgress = () => {}) {
  if (!/\.(md|markdown|txt|pdf)$/i.test(file.name)) throw new Error('Choose a Markdown, PDF or plain-text file.');
  if (/[\x00-\x1f\x7f/\\]/.test(file.name) || encoder.encode(file.name).length > 220) throw new Error('Choose a file with a shorter, valid filename.');
  const pdf = /\.pdf$/i.test(file.name); const limit = pdf ? MAX_PDF_BYTES : MAX_FILE_BYTES;
  if (file.size > limit) throw new Error(`File exceeds ${pdf ? 16 : 4} MiB.`);
  // Retain a UTF-8 BOM in stored originals so sync does not silently rewrite
  // a desktop file or report an unchanged download as a new phone edit.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const parts = []; let loaded = 0;
  onProgress({ phase: 'reading', loaded, total: file.size });
  for (let offset = 0; offset < file.size; offset += 128 * 1024) {
    const bytes = await file.slice(offset, offset + 128 * 1024).arrayBuffer();
    loaded += bytes.byteLength;
    if (loaded > limit) throw new Error(`File exceeds ${pdf ? 16 : 4} MiB.`);
    try { parts.push(pdf ? new Uint8Array(bytes) : decoder.decode(bytes, { stream: true })); }
    catch { throw new Error('File is not UTF-8 text.'); }
    onProgress({ phase: 'reading', loaded, total: file.size });
  }
  if (pdf) {
    const bytes = new Uint8Array(loaded); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes('%PDF-')) throw new Error('File does not contain a PDF header.');
    onProgress({ phase: 'checking' });
    return { id: file.name, title: file.name.replace(/\.pdf$/i, ''), format: 'pdf', content: bytesToBase64(bytes), bytes: loaded, words: 0 };
  }
  try { parts.push(decoder.decode()); }
  catch { throw new Error('File is not UTF-8 text.'); }
  onProgress({ phase: 'checking' });
  const content = parts.join('');
  if (content.includes('\0')) throw new Error('File contains binary data.');
  const title = (!/\.txt$/i.test(file.name) && content.replace(/^\uFEFF/, '').match(/^#{1,6}\s+(.+?)\s*#*\s*$/m)?.[1]) || file.name.replace(/\.[^.]+$/, '');
  return { id: file.name, title, content, bytes: loaded, words: countWords(content) };
}

export function addDocument(saved, document) {
  const snapshot = localSnapshot(saved);
  if (snapshot.documents.length >= MAX_DOCUMENTS) throw new Error('Library limit reached (1,000 files). Delete a file first.');
  if (snapshot.documents.reduce((sum, doc) => sum + doc.bytes, 0) + document.bytes > MAX_LIBRARY_BYTES) {
    throw new Error(`Library exceeds ${MAX_LIBRARY_BYTES / 1024 / 1024} MiB. Delete some files first.`);
  }
  const used = new Set(snapshot.documents.map(doc => doc.id));
  const dot = document.id.lastIndexOf('.');
  let id = document.id;
  for (let n = 2; used.has(id); n++) id = `${document.id.slice(0, dot)} (${n})${document.id.slice(dot)}`;
  const added = { ...document, id, positionKey: `local\n${id}`,
    addedAt: libraryTimestamp(document.addedAt) || Date.now() };
  snapshot.documents.push(added);
  return { snapshot, document: added };
}

// Sync replaces a named file atomically, preserving its reading identity.
// A stale snapshot must not overwrite an edit made by another browser tab.
export function replaceDocument(saved, document, expected) {
  const snapshot = localSnapshot(saved), prior = snapshot.documents.find(doc => doc.id === document.id);
  assertDocumentUnchanged(prior, expected);
  const documents = snapshot.documents.filter(doc => doc.id !== document.id);
  const result = addDocument({ documents }, document);
  result.document.positionKey = prior?.positionKey || document.positionKey || `local\n${document.id}`;
  if (prior) {
    // Replacing content is not a new addition, including legacy undated files.
    result.document.addedAt = Math.min(libraryTimestamp(prior.addedAt) || Infinity,
      libraryTimestamp(document.addedAt) || Infinity);
    if (!Number.isFinite(result.document.addedAt)) delete result.document.addedAt;
    result.snapshot.documents = snapshot.documents.map(doc => doc.id === prior.id ? result.document : doc);
  }
  return result;
}
export function updateDocumentDates(saved, updates) {
  const snapshot = localSnapshot(saved);
  for (const update of updates) {
    const doc = snapshot.documents.find(doc => doc.id === update.id);
    if (!doc || doc.content !== update.expected.content || doc.format !== update.expected.format) continue;
    if (libraryTimestamp(update.addedAt)) doc.addedAt = Math.min(libraryTimestamp(doc.addedAt) || Infinity, update.addedAt);
    if (libraryTimestamp(update.modifiedAt)) doc.modifiedAt = update.modifiedAt;
  }
  return { snapshot };
}
export function assertDocumentUnchanged(prior, expected) {
  if (!!prior !== !!expected || prior && (prior.content !== expected.content || prior.format !== expected.format)) {
    throw new Error('The phone library changed during sync. Sync again to preserve those changes.');
  }
}

export class LocalLibrary {
  async open() {
    if (!this.opening) this.opening = new Promise((resolve, reject) => {
      const request = indexedDB.open('even-reader', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('data');
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); this.opening = null; };
        resolve(db);
      };
      request.onerror = () => { this.opening = null; reject(request.error); };
    });
    return this.opening;
  }
  async read() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const request = db.transaction('data').objectStore('data').get('snapshot');
      request.onsuccess = () => resolve(localSnapshot(request.result));
      request.onerror = () => reject(request.error);
    });
  }
  async update(change) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('data', 'readwrite');
      const store = transaction.objectStore('data');
      let result; let failure;
      const request = store.get('snapshot');
      request.onsuccess = () => {
        try { result = change(localSnapshot(request.result)); store.put(result.snapshot, 'snapshot'); }
        catch (error) { failure = error; transaction.abort(); }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = transaction.onabort = () => reject(failure || transaction.error || new Error('Could not save the library on this phone.'));
    });
  }
  async add(file) {
    return this.save(await readLocalFile(file));
  }
  async save(document) {
    // Read-modify-write in one transaction also serializes multiple open tabs.
    return this.update(snapshot => addDocument(snapshot, document));
  }
  async put(document, expected) { return this.update(snapshot => replaceDocument(snapshot, document, expected)); }
  async updateDates(updates) { return this.update(snapshot => updateDocumentDates(snapshot, updates)); }
  async remove(id, expected = undefined) {
    return this.update(snapshot => {
      if (expected !== undefined) assertDocumentUnchanged(snapshot.documents.find(doc => doc.id === id), expected);
      return { snapshot: { ...snapshot, documents: snapshot.documents.filter(doc => doc.id !== id) } };
    });
  }
  async replace(snapshot) { return this.update(() => ({ snapshot: localSnapshot(snapshot) })); }
}
