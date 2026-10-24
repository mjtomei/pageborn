import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, mkdir, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { paperAttachments, paperFile, syncPaperFiles, fileQuestion, PAPER_CHUNK_BYTES } from '../src/ask-documents.js';
import { parseDocument } from '../src/document.js';
import { nativeLayout } from '../src/native-text.js';
import { paperFilesStatus, paperFileChunk, commitPaperFiles } from '../integrations/even-terminal/pageborne-files.js';
import { paperWorkspace, workspaceCapabilities } from '../integrations/even-terminal/pageborne-workspaces.js';
import { EvenTerminal } from '../src/ask-terminal.js';
const hash = value => createHash('sha256').update(value).digest('hex');
const meta = files => files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }));

test('Markdown originals and reflow are complete; changing reading place changes only the pointer', async () => {
  const document = { id: 'test.md', title: 'Test', content: '# Title\n\n' + 'Many words in one paragraph. '.repeat(300) + '\n\n## Ending\n\nUnique ending sentence.' };
  const layout = nativeLayout(parseDocument(document.content));
  const start = await paperAttachments({ document, layout, y: 0 });
  const end = await paperAttachments({ document, layout, y: layout.maxY });
  assert.equal(new TextDecoder().decode(start.files[0].data), document.content);
  assert.deepEqual(meta(start.files), meta(end.files)); assert.notEqual(start.position.line, end.position.line);
  const text = new TextDecoder().decode(end.files[1].data).split('\n');
  assert(text[end.position.line - 1].includes(layout.rows.findLast(row => row.y <= layout.maxY).text.trim()));
  assert(!('quote' in end.position));
  assert(text.join('\n').includes('Unique ending sentence.'));
  const original = await paperFile('original.md', document.content); assert.equal(original.sha256, hash(document.content));
});

test('PDF export includes separate footnotes, figures, partial status, and source-page pointers without modifying the layout', async () => {
  const text = { y: 0, page: 2, kind: 'text', x: 1, sourceY: 20, width: 80, height: 40, reflow: { text: 'First words. Later words.', rows: [{ y: 0, start: 0, text: 'First words.' }, { y: 27, start: 13, text: 'Later words.' }] } };
  const figure = { y: 150, page: 2, kind: 'figure', x: 30, sourceY: 80, width: 40, height: 40, text: 'Figure caption' };
  const note = { y: 0, page: 2, annotation: { kind: 'footnote', number: '1' }, reflow: { text: 'A complete footnote.', rows: [{ y: 0, start: 0, text: 'A complete footnote.' }] } };
  const bodyLayout = { format: 'pdf', blocks: [text, figure], headings: Array(8).fill('Page'), preparation: { complete: false, readyPages: 2, totalPages: 8 } };
  const notes = { format: 'pdf', blocks: [note] };
  const document = { id: 'test.pdf', title: 'Test PDF', format: 'pdf', content: Buffer.from('%PDF-complete-original').toString('base64') };
  const snapshot = { document, bodyLayout, notes, layout: bodyLayout, y: 150 }; const before = JSON.stringify(snapshot);
  const image = await paperAttachments(snapshot); assert.equal(image.position.pdfPage, 2); assert.equal(image.position.kind, 'figure');
  assert.equal(new TextDecoder().decode(image.files[0].data), '%PDF-complete-original');
  const output = new TextDecoder().decode(image.files[1].data);
  assert.match(output, /Partial reflow: 2 of 8/); assert.match(output, /Figure caption/); assert.match(output, /## Footnotes[\s\S]*A complete footnote/);
  const footnote = await paperAttachments({ ...snapshot, layout: notes, y: 0 });
  assert.equal(footnote.position.kind, 'footnote'); assert.equal(footnote.position.pdfPage, 2);
  assert.equal(output.split('\n')[footnote.position.line - 1], 'A complete footnote.');
  assert.equal(JSON.stringify(snapshot), before);
  const full = await paperAttachments({ ...snapshot, bodyLayout: { ...bodyLayout, preparation: { complete: true, readyPages: 8, totalPages: 8 } } });
  assert.equal(full.files[0].sha256, image.files[0].sha256); assert.notEqual(full.files[1].sha256, image.files[1].sha256);
  const cached = await paperAttachments({ ...snapshot, bodyLayout: { ...bodyLayout, preparation: undefined } });
  assert.deepEqual(meta(cached.files), meta(full.files));
});

test('uploads resume in chunks, repeated chunks are safe, verified files are reused, and revised exports leave old snapshots readable', async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'pageborne-files-')); const options = { baseDir };
  try {
    const files = await Promise.all([paperFile('original.pdf', new Uint8Array(PAPER_CHUNK_BYTES * 2 + 19).map((_, i) => i % 251)), paperFile('reflow.md', 'First text'), paperFile('index.json', '{"complete":false}')]);
    const paperId = 'a-paper'; const body = { paperId, files: meta(files) };
    const chunk = { paperId, file: body.files[0], offset: 0, data: Buffer.from(files[0].data.subarray(0, PAPER_CHUNK_BYTES)).toString('base64') };
    await paperFileChunk(chunk, options); await paperFileChunk(chunk, options);
    assert.equal((await paperFilesStatus(body, options)).missing.find(f => f.name === 'original.pdf').offset, PAPER_CHUNK_BYTES);
    await assert.rejects(commitPaperFiles(body, options), /incomplete/);
    const calls = []; const actions = { status: paperFilesStatus, chunk: paperFileChunk, commit: commitPaperFiles };
    const client = { async api(route, { body }) { calls.push({ route, name: body.file?.name, offset: body.offset }); return actions[route.split('/').at(-1)](body, options); } };
    const first = await syncPaperFiles(client, paperId, { files, position: { line: 5 } }, undefined, () => {});
    assert.equal(first.position.file, first.files.find(f => f.name === 'reflow.md').path);
    assert.deepEqual(new Uint8Array(await readFile(first.files.find(f => f.name === 'original.pdf').path)), files[0].data);
    assert(!calls.some(c => c.name === 'original.pdf' && c.offset === 0));
    calls.length = 0;
    assert.deepEqual(await syncPaperFiles(client, paperId, { files, position: { line: 5 } }, undefined, () => {}), first);
    assert(!calls.some(c => c.route.endsWith('/chunk')));
    const revisedFiles = [files[0], await paperFile('reflow.md', 'Completed text'), await paperFile('index.json', '{"complete":true}')];
    const revised = await syncPaperFiles(client, paperId, { files: revisedFiles, position: { line: 9 } }, undefined, () => {});
    assert.notEqual(revised.revision, first.revision); assert(!calls.some(c => c.name === 'original.pdf'));
    assert.equal(await readFile(first.position.file, 'utf8'), 'First text'); assert.equal(await readFile(revised.position.file, 'utf8'), 'Completed text');
    const input = { question: 'Explain this sentence.', context: { title: 'Paper', passage: 'HUGE_CONTEXT_MUST_NOT_BE_SENT'.repeat(1000) } };
    const initial = fileQuestion('marker', input, { ...first, position: { ...first.position, quote: 'OLD_CACHED_QUOTE', passage: 'EXTRA_CONTEXT' } }, true), followup = fileQuestion('next', input, { ...first, position: { ...first.position, line: 123 } }, false);
    assert(initial.includes('Paper files')); assert(!followup.includes('Paper files')); assert(followup.includes('123'));
    assert(!initial.includes('HUGE_CONTEXT')); assert(!initial.includes('OLD_CACHED_QUOTE')); assert(!initial.includes('EXTRA_CONTEXT')); assert(followup.length < 2500);
  } finally { await rm(baseDir, { recursive: true, force: true }); }
});

test('file transfer rejects traversal, oversized payloads, bad hashes, symlinks and hardlinks without overwriting other files', async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'pageborne-files-safety-')); const options = { baseDir };
  try {
    const file = await paperFile('original.md', 'text'); const desc = meta([file])[0];
    const request = { paperId: 'paper', file: desc, offset: 0, data: Buffer.from('text').toString('base64') };
    await assert.rejects(paperFileChunk({ ...request, file: { ...desc, name: '../../outside' } }, options));
    await assert.rejects(paperFileChunk({ ...request, file: { ...desc, bytes: 17 * 1024 * 1024 } }, options));
    await assert.rejects(paperFileChunk({ ...request, data: 'dGV4d===' }, options));
    await assert.rejects(paperFileChunk({ ...request, data: Buffer.from('oops').toString('base64') }, options), /checksum/);
    const folder = path.join(baseDir, `paper-${hash('paper').slice(0, 24)}`, 'files');
    const partial = path.join(folder, `${desc.sha256}-${desc.name}.part`); const outside = path.join(baseDir, 'outside'); await writeFile(outside, 'Keep this');
    await symlink(outside, partial); await assert.rejects(paperFileChunk(request, options)); await rm(partial);
    await link(outside, partial); await assert.rejects(paperFileChunk(request, options)); await rm(partial);
    assert.equal(await readFile(outside, 'utf8'), 'Keep this');
    await rm(folder, { recursive: true }); await mkdir(path.join(baseDir, 'elsewhere')); await symlink(path.join(baseDir, 'elsewhere'), folder);
    await assert.rejects(paperFileChunk(request, options), /Unsafe/);
  } finally { await rm(baseDir, { recursive: true, force: true }); }
});

test('created session directories hold the paper files, survive base preference changes, and refresh paths for existing conversations', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'pageborne-session-files-')); t.after(() => rm(home, { recursive: true, force: true }));
  const files = await Promise.all([paperFile('original.md', 'Original text'), paperFile('reflow.md', 'Reading text'), paperFile('index.json', '{}')]);
  const input = { paperId: 'a-paper', question: 'Explain?', context: { title: 'Paper', passage: 'Fallback context' }, paper: async () => ({ files, position: { line: 1 } }) };
  const requests = [], messages = new Map(); let session = 0, capabilities = workspaceCapabilities();
  const config = { mode: 'terminal', agent: 'codex', endpoint: 'https://fixture.test', token: 'fixture', paperDirectories: true, baseDir: path.join(home, 'custom-base') };
  const actions = { status: paperFilesStatus, chunk: paperFileChunk, commit: commitPaperFiles };
  const fetcher = async (url, options) => {
    const route = new URL(url).pathname; const body = options.body && JSON.parse(options.body); requests.push({ route, body });
    if (route.endsWith('/info')) return Response.json({ pageborne: capabilities });
    if (route.endsWith('/workspace')) return Response.json(await paperWorkspace(body, { home }));
    if (route.includes('/files/')) return Response.json(await actions[route.split('/').at(-1)](body, { baseDir: path.join(home, 'server-base') }));
    if (route.endsWith('/history')) return Response.json({ history: [] });
    if (route.endsWith('/messages')) return Response.json({ state: 'idle', messages: messages.get(new URL(url).searchParams.get('sessionId')) || [] });
    if (route.endsWith('/prompt')) {
      const id = body.sessionId || `session-${++session}`; const previous = messages.get(id) || []; const n = previous.at(-1)?.id || 0;
      messages.set(id, [...previous, { id: n + 1, type: 'user_prompt', text: body.text }, { id: n + 2, type: 'result', success: true, text: 'Answer' }]);
      return Response.json({ sessionId: id });
    }
    throw new Error(`Unexpected route ${route}`);
  };
  let binding; const save = value => { binding = structuredClone(value); };
  const client = new EvenTerminal(config, { fetcher }); await client.ask(input, {}, save);
  const first = structuredClone(binding); const uploaded = requests.filter(r => r.route.endsWith('/chunk')).length;
  assert.equal(path.dirname(path.dirname(first.cwd)), config.baseDir);
  assert.equal(path.dirname(first.documentFiles.index), path.join(first.cwd, 'files'));
  for (const file of first.documentFiles.files) {
    assert.equal(path.dirname(file.path), path.join(first.cwd, 'files'));
    assert.deepEqual(new Uint8Array(await readFile(file.path)), files.find(f => f.name === file.name).data);
  }
  for (const request of requests.filter(r => r.route.includes('/files/'))) assert.deepEqual(request.body.workspace, { cwd: first.cwd, workspaceId: first.workspaceId });
  // Reload with a different default: an existing conversation keeps its files.
  const reloaded = new EvenTerminal({ ...config, baseDir: path.join(home, 'new-base') }, { fetcher });
  await reloaded.ask(input, binding, save);
  assert.equal(binding.cwd, first.cwd); assert.equal(binding.sessionId, first.sessionId);
  assert.equal(requests.filter(r => r.route.endsWith('/chunk')).length, uploaded);
  assert(!requests.findLast(r => r.route.endsWith('/prompt')).body.text.includes('Paper files (read them'));
  // Upgrading from the old shared folder reintroduces the original file paths,
  // even though the content hashes/revision have not changed.
  await reloaded.ask(input, { ...binding, documentFiles: { ...binding.documentFiles, index: '/old-shared-folder/manifest.json' } }, save);
  assert(requests.findLast(r => r.route.endsWith('/prompt')).body.text.includes('Paper files (read them'));
  await reloaded.ask(input, {}, save);
  assert.notEqual(binding.cwd, first.cwd); assert.equal(path.dirname(path.dirname(binding.cwd)), path.join(home, 'new-base'));
  assert.equal(await readFile(first.documentFiles.position.file, 'utf8'), 'Reading text');
  // Older patched servers understand only shared paper files; don't send the
  // new destination until it has been advertised. Explicit cwd is unchanged.
  capabilities = { workspaces: 1, documents: 1 };
  const before = requests.length;
  await new EvenTerminal(config, { fetcher }).ask(input, first, save);
  assert(requests.slice(before).filter(r => r.route.includes('/files/')).every(r => !r.body.workspace));
  assert.equal(path.dirname(path.dirname(path.dirname(binding.documentFiles.index))), path.join(home, 'server-base'));
  capabilities = workspaceCapabilities();
  await new EvenTerminal({ ...config, paperDirectories: false, cwd: home }, { fetcher }).ask(input, {}, save);
  assert.equal(binding.cwd, home); assert(!binding.managedWorkspace);
  assert.equal(path.dirname(path.dirname(path.dirname(binding.documentFiles.index))), path.join(home, 'server-base'));
});

test('workspace uploads reject another paper/session, arbitrary paths, missing identities and symlinked folders', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'pageborne-workspace-files-safety-')); t.after(() => rm(home, { recursive: true, force: true }));
  const files = await Promise.all([paperFile('original.md', 'Text'), paperFile('reflow.md', 'Text'), paperFile('index.json', '{}')]);
  const workspaceId = 'session-one', paperId = 'paper'; const { cwd } = await paperWorkspace({ paperId, workspaceId }, { home });
  const body = { paperId, files: meta(files), workspace: { cwd, workspaceId } };
  await paperFilesStatus(body);
  await assert.rejects(paperFilesStatus({ ...body, paperId: 'another-paper' }), /Invalid paper workspace/);
  await assert.rejects(paperFilesStatus({ ...body, workspace: { cwd, workspaceId: 'another-session' } }), /Invalid paper workspace/);
  await assert.rejects(paperFilesStatus({ ...body, workspace: { cwd: home, workspaceId } }), /Invalid paper workspace/);
  await rm(path.join(cwd, 'paper.json'));
  await assert.rejects(paperFilesStatus(body), /Missing paper workspace/);
  await writeFile(path.join(cwd, 'paper.json'), JSON.stringify({ paperId: 'another-paper', workspaceId }));
  await assert.rejects(paperFilesStatus(body), /identity mismatch/);
  await rm(cwd, { recursive: true }); await mkdir(path.join(home, 'elsewhere')); await symlink(path.join(home, 'elsewhere'), cwd);
  await assert.rejects(paperFilesStatus(body), /Unsafe paper workspace/);
});
