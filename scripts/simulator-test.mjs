import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { speedToSlider } from '../src/reader.js';
import { wordSpeedToSlider } from '../src/speed-reading.js';
import { runSpeedSimulator } from './speed-simulator.mjs';
import { createApp } from '../server/app.js';
import { startSimulatorRecording } from './simulator-recording.mjs';
import { runScrollReproduction } from './scroll-reproduction.mjs';
import { runTableStressSimulator } from './table-stress.mjs';
import { runPdfSimulator } from './pdf-simulator.mjs';

// The DOM driver is injected by this temporary test server only. It operates the
// real phone controls, including local File uploads and deletion. It is never packaged.
// The SDK and simulator renderer are not mocked.
const driver = `<script>
// Exercise compatibility with WebViews that lack copying array methods.
if (${Boolean(process.env.PDF_NO_TO_SORTED)}) delete Array.prototype.toSorted;
if (new URL(location.href).searchParams.has('cold')) {
  localStorage.clear(); indexedDB.deleteDatabase('even-reader');
}
let lastCommand = 0;
async function poll() {
  try {
    const command = await (await fetch('/test/control')).json();
    if (command.id > lastCommand) {
      lastCommand = command.id;
      const el = document.querySelector(command.selector);
      if (command.kind === 'reopen') {
        await fetch('/test/reopen', { method: 'POST' });
        location.href = '/?cold=1'; return;
      }
      if (command.kind === 'flush') document.dispatchEvent(new Event('visibilitychange'));
      if (command.kind === 'click') el.click();
      if (command.kind === 'files') {
        const transfer = new DataTransfer();
        for (const file of command.files) transfer.items.add(new File([file.base64 ? Uint8Array.from(atob(file.base64), c => c.charCodeAt(0)) : file.content], file.name, { type: file.base64 ? 'application/pdf' : 'text/markdown' }));
        el.files = transfer.files; el.dispatchEvent(new Event('change'));
      }
      if (command.kind === 'range') { el.value = command.value; el.dispatchEvent(new Event('input')); }
      if (command.kind === 'fill') { el.value = command.value; el.dispatchEvent(new Event('input')); }
      if (command.kind === 'headings') {
        const buttons = document.querySelectorAll('#outline button');
        for (let i = 0; i < command.count; i++) {
          buttons[(i * 7 + 1) % buttons.length].click();
          await new Promise(r => setTimeout(r, command.interval));
        }
        buttons[command.finalIndex].click();
      }
      // Range inputs change immediately; allow the app's 100 ms render tick
      // before reporting their accompanying passage and playback state.
      await new Promise(r => setTimeout(r, 150));
    }
    await fetch('/test/observed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      command: lastCommand,
      connection: document.querySelector('#connection')?.textContent,
      documents: document.querySelector('#doc-count')?.textContent,
      documentIds: Array.from(document.querySelectorAll('.document-entry')).map(el => el.dataset.documentId),
      title: document.querySelector('#title')?.textContent,
      bookmarks: document.querySelectorAll('#bookmarks .bookmark-row').length,
      searchQuery: document.querySelector('#search')?.value,
      searchResults: document.querySelectorAll('#search-results button').length,
      searchText: document.querySelector('#search-results button')?.textContent,
      currentRow: Number(document.querySelector('#passage button[aria-current=true]')?.dataset.row),
      pdfCanvases: document.querySelectorAll('#pdf-passage canvas').length,
      readerReady: !document.querySelector('#bookmark')?.disabled && (document.querySelector('#pdf-passage')?.hidden
        || JSON.parse(localStorage.getItem('even-reader:diagnostics:v1') || '{}').pdf?.stage === 'ready'),
      notice: document.querySelector('#notice')?.textContent,
      libraryBusy: document.querySelector('#import')?.disabled || Number(document.querySelector('#imports')?.dataset.pending) > 0 || !!document.querySelector('[data-confirm-delete]:disabled'),
      importDisabled: document.querySelector('#import')?.disabled,
      importsPending: Number(document.querySelector('#imports')?.dataset.pending),
      position: document.querySelector('#position-value')?.textContent,
      previewLabel: document.querySelector('#preview')?.getAttribute('aria-label'),
      slider: document.querySelector('#position')?.value,
      page: document.querySelector('#page-number')?.value,
      mode: ['page', 'auto', 'speed'].find(mode => document.querySelector('#mode-' + mode)?.getAttribute('aria-pressed') === 'true'),
      wordCursor: Object.values(JSON.parse(localStorage.getItem('even-reader:preferences:v1') || '{}').positions || {}).find(p => p.speedCursor)?.speedCursor.index,
      wordGroup: Number(document.querySelector('#word-group')?.value),
      pauseAtTitles: document.querySelector('#pause-at-titles')?.checked,
      play: document.querySelector('#play')?.textContent,
      passage: document.querySelector('#passage button[aria-current=true]')?.getAttribute('aria-label'),
      passageLines: Array.from(document.querySelectorAll('#passage button')).filter(el => Number(el.dataset.row) >= Number(document.querySelector('#passage button[aria-current=true]')?.dataset.row)).slice(0,13).map(el => el.getAttribute('aria-label') === 'Blank line' ? ' ' : el.getAttribute('aria-label')),
      speed: parseInt(document.querySelector('#speed-value')?.textContent),
      diagnostics: JSON.parse(localStorage.getItem('even-reader:diagnostics:v1') || 'null')
    }) });
  } catch (e) { console.error('[test-driver]', e.message); }
  setTimeout(poll, 100);
}
poll();
</script>`;

const resultDir = path.resolve(process.env.SIMULATOR_RESULTS || `test-results/official-simulator/${new Date().toISOString().replace(/[:.]/g, '-')}`);
const scrollRepro = process.argv.includes('--scroll-repro');
const tableStress = process.argv.includes('--table-stress');
const pdfTest = process.argv.includes('--pdf');
const speedTest = process.argv.includes('--speed');
await mkdir(resultDir, { recursive: true });
const dir = await mkdtemp(path.join(os.tmpdir(), 'even-reader-simulator-'));
const content = '# Simulator reading test\n\n' + Array.from({ length: 24 }, (_, i) =>
  `## Chapter ${i + 1}\n\n` + Array.from({ length: 50 }, (_, j) =>
    `Chapter ${i + 1} line ${j + 1}. Read this native text.\n\n`).join('')).join('');
const otherContent = '# Second saved document\n\nPicked entirely from the glasses.\n\n' + 'A second passage to read.\n\n'.repeat(20);
const distDir = path.resolve(process.env.READER_TEST_DIST || 'dist');
let command = { id: 0 }; let observed = {};
const app = express();
app.get('/', async (_req, res) => res.type('html').send((await readFile(path.join(distDir, 'index.html'), 'utf8')).replace('</body>', `${driver}</body>`)));
app.get('/test/control', (_req, res) => res.set('Cache-Control', 'no-store').json(command));
app.post('/test/reopen', (_req, res) => { command = { id: command.id, kind: 'idle' }; res.json({ ok: true }); });
app.post('/test/observed', express.json(), (req, res) => { observed = req.body; res.json({ ok: true }); });
app.use(createApp({ distDir }));
let server; let base;
const port = Number(process.env.SIMULATOR_PORT || 9900);
const api = `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let child; let log; let childError; let recording; let failure;
const result = { simulator: '0.9.5', scenario: speedTest ? 'speed-reading' : pdfTest ? 'pdf' : tableStress ? 'table-stress' : scrollRepro ? 'scroll-reproduction' : 'regression', passed: false, recording: null };
const until = async (test, label, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (childError) throw childError;
    if (child && (child.exitCode != null || child.signalCode != null)) throw new Error(`Simulator exited (${child.exitCode ?? child.signalCode}): ${label}`);
    if (await test()) return;
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}; last state: ${JSON.stringify(observed)}`);
};
const act = async action => {
  command = { ...action, id: command.id + 1 };
  if (action.kind === 'range' && action.selector === '#speed') command.value = (observed.mode === 'speed' ? wordSpeedToSlider : speedToSlider)(action.value);
  recording?.mark('phone-command', command);
  await until(() => observed.command === command.id, `phone ${action.kind}`);
  recording?.mark('phone-command-complete', { id: command.id, position: observed.position });
};
const input = async (action, settleMs = 200) => {
  recording?.mark('simulator-input', { action });
  const response = await fetch(`${api}/api/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
  assert.ok(response.ok, `simulator input ${action}`); if (settleMs) await sleep(settleMs);
};
const shot = async name => {
  recording?.mark('screenshot', { name });
  const response = await fetch(`${api}/api/screenshot/glasses`, { signal: AbortSignal.timeout(2000) });
  assert.ok(response.ok, `screenshot ${name}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(path.join(resultDir, `${name}.png`), buffer); return buffer;
};
const settled = () => until(() => !observed.diagnostics?.active, 'bridge idle');
const executable = path.resolve(`node_modules/@evenrealities/sim-${process.platform}-${process.arch}/bin/evenhub-simulator${process.platform === 'win32' ? '.exe' : ''}`);
const env = { ...process.env, GSETTINGS_BACKEND: 'memory', NO_AT_BRIDGE: '1', GTK_USE_PORTAL: '0',
  LIBGL_ALWAYS_SOFTWARE: '1', WEBKIT_DISABLE_COMPOSITING_MODE: '1', RUST_LOG: 'info' };
for (const [name, folder] of Object.entries({ XDG_RUNTIME_DIR: 'runtime', XDG_CONFIG_HOME: 'config', XDG_CACHE_HOME: 'cache', XDG_DATA_HOME: 'data' })) {
  env[name] = path.join(dir, folder); await mkdir(env[name], { mode: 0o700 });
}
try {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  base = `http://127.0.0.1:${server.address().port}`;
  const args = [executable, base, '--automation-port', String(port), '-c', path.join(dir, 'simulator.toml')];
  log = createWriteStream(path.join(resultDir, 'simulator.log'));
  child = process.platform === 'linux' ? spawn('dbus-run-session', ['--', ...args], { env, detached: true }) : spawn(args[0], args.slice(1), { env });
  child.on('error', error => { childError = error; });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  await until(async () => { try { return (await (await fetch(`${api}/api/ping`)).text()) === 'pong'; } catch { return false; } }, 'simulator API', 45000);
  if (process.argv.includes('--record')) {
    recording = await startSimulatorRecording({ api, dir: path.join(resultDir, 'recording'), fps: Number(process.env.SIMULATOR_FPS || (scrollRepro ? 30 : 12)) });
    console.log('Recording simulator display and command timeline.');
  }
  await until(() => observed.documents === '0' && !observed.libraryBusy && observed.connection === 'Native text connected', 'empty local startup');
  if (!tableStress && !pdfTest) {
    await act({ kind: 'files', selector: '#file-picker', files: [{ name: 'test.md', content }, { name: 'zz-other.md', content: otherContent }] });
    await until(() => observed.documents === '2' && !observed.libraryBusy, 'local file import');
    assert.equal(observed.title, 'Choose something good.', 'imports leave document selection to the reader');
    await until(() => observed.previewLabel?.startsWith('Choose document:'), 'library appears on glasses after import');
    await sleep(300); await settled(); // Let the display tick catch up with the phone's library state.
    await shot('00-document-library');
    if (observed.documentIds[0] !== 'test.md') await input('down');
    await until(() => observed.previewLabel === 'Choose document: Simulator reading test', 'highlight the initial document');
    await input('click');
    await until(() => observed.title === 'Simulator reading test', 'open first document from glasses library');
    await sleep(500); await settled();
  }
  if (speedTest) {
    result.speedReading = await runSpeedSimulator({ act, input, until, observed: () => observed, settled, shot });
  } else if (pdfTest) {
    result.pdf = await runPdfSimulator({ act, input, until, observed: () => observed, settled, shot });
  } else if (tableStress) {
    result.tables = await runTableStressSimulator({ act, input, until, observed: () => observed, settled, shot });
  } else if (scrollRepro) {
    result.reproduction = await runScrollReproduction({ act, input, shot, until, observed: () => observed, recording, resultDir });
  } else {
    await act({ kind: 'click', selector: '#mode-auto' });
    await sleep(500); await settled();
    await shot('01-auto-paused');
    const initialLines = observed.passageLines;
    await input('up'); await until(() => observed.speed === 36, 'swipe increases speed');
    await input('down'); await until(() => observed.speed === 30, 'swipe decreases speed');
    assert.deepEqual(observed.passageLines, initialLines, 'speed swipes do not jump the text');
    await act({ kind: 'range', selector: '#speed', value: 200 });
    assert.equal(observed.speed, 200);
    await input('up'); assert.equal(observed.speed, 200, 'swipes respect the maximum');
    await input('click'); await until(() => observed.play === 'Pause', 'tap starts autoscroll');
    let previousLines = observed.passageLines; let rows = 0;
    const deadline = Date.now() + 60000;
    while (rows < 45 && Date.now() < deadline) {
      await sleep(100);
      if (observed.passageLines.join('\n') !== previousLines.join('\n')) {
        assert.deepEqual(observed.passageLines.slice(0, 8), previousLines.slice(1, 9), 'every automatic advance moves exactly one row');
        previousLines = observed.passageLines; rows++;
      }
    }
    assert.equal(rows, 45, 'autoscroll passes the former native section boundary');
    await input('click'); await until(() => observed.play === 'Start autoscroll', 'tap pauses');
    await shot('02-auto-after-45-lines');
    const pausedLines = observed.passageLines;
    await sleep(800); assert.deepEqual(observed.passageLines, pausedLines);
    await act({ kind: 'range', selector: '#position', value: 500 });
    await until(() => observed.slider === '500', 'phone jump');
    const jumpedLines = observed.passageLines;
    await input('down'); await until(() => observed.speed === 167, 'speed after jump');
    assert.deepEqual(observed.passageLines, jumpedLines, 'swipe after jump only changes speed');
    await input('click');
    await until(() => observed.passageLines[0] !== jumpedLines[0], 'advance after percentage jump');
    assert.deepEqual(observed.passageLines.slice(0, 8), jumpedLines.slice(1, 9));
    await input('click');
    await shot('02b-auto-after-jump');
    result.autoscroll = { sequentialRows: rows, swipesChangeSpeed: true, resumesAfterJump: true };
    console.log('PASS: 45 one-line advances, swipe speed changes, tap pause/resume, and percentage jump.');

    await act({ kind: 'headings', count: 60, interval: 25, finalIndex: 12 });
    await until(() => observed.passage.startsWith('Chapter 12'), 'last heading selected');
    await sleep(500); await settled(); await shot('03-after-heading-jumps');
    assert.equal(observed.connection, 'Native text connected');
    console.log('PASS: 60 rapid contents jumps; final selection Chapter 12.');

    await act({ kind: 'range', selector: '#speed', value: 200 });
    const lastGesture = () => observed.diagnostics.events.filter(event => event.type === 'gesture').at(-1)?.action;
    const openMenu = async () => { await input('context_menu'); await until(() => lastGesture() === 'suspend', 'menu opened'); };
    await openMenu(); await shot('04-menu');
    await input('click');
    await until(() => observed.mode === 'speed', 'Change mode to speed reading');
    await until(() => lastGesture() === 'resume', 'speed mode menu dismissed');
    await openMenu(); await input('click');
    await until(() => observed.mode === 'page', 'Change mode from the real menu');
    await until(() => lastGesture() === 'resume', 'mode menu dismissed');
    await openMenu(); await input('down'); await input('down'); await shot('05-start-selected'); await input('click');
    await until(() => observed.position === '0%', 'Start of doc from the real menu');
    await until(() => lastGesture() === 'resume', 'start menu dismissed');
    const chooseDocuments = async () => {
      await openMenu(); await input('down'); await input('down'); await input('down'); await input('click');
      await until(() => lastGesture() === 'resume', 'document menu dismissed');
      await sleep(300); await settled();
    };
    await act({ kind: 'range', selector: '#position', value: 500 });
    await chooseDocuments(); await shot('05b-document-picker');
    const testFirst = observed.documentIds[0] === 'test.md';
    await input(testFirst ? 'down' : 'up'); await input('click');
    await until(() => observed.title === 'Second saved document', 'document selected from glasses');
    await settled(); await shot('05c-second-document');
    await chooseDocuments(); await input(testFirst ? 'up' : 'down'); await input('click');
    await until(() => observed.title === 'Simulator reading test' && observed.position === '50%', 'saved document position restored');
    await chooseDocuments(); await input(testFirst ? 'up' : 'down'); await input('click');
    await sleep(300); await settled(); await shot('05d-picker-cancelled');
    assert.equal(observed.position, '50%', 'Back leaves reading position unchanged');
    result.documentPicker = { selectedFromGlasses: true, restoredPosition: true, cancelled: true };
    await input('double_click');
    await until(() => observed.title === 'Choose something good.' && observed.previewLabel === 'Choose document: Simulator reading test', 'Back returns to the library');
    assert.equal(observed.connection, 'Native text connected', 'Back does not close the app');
    await settled(); await shot('05e-back-to-library');
    await input('click');
    await until(() => observed.title === 'Simulator reading test' && observed.position === '50%', 'reopen at saved position');
    result.backNavigation = { libraryOnImport: true, returnsToLibrary: true, restoresPosition: true };
    const choosePosition = async () => {
      await openMenu(); await input('down'); await input('click');
      await until(() => observed.previewLabel?.startsWith('Choose reading position:'), 'position selector opened');
      await until(() => lastGesture() === 'resume', 'position menu dismissed');
    };
    await choosePosition(); await shot('05e-position-slider');
    await input('down'); await until(() => observed.previewLabel === 'Choose reading position: 55%', 'slider moved forward');
    assert.equal(observed.position, '50%', 'candidate is not committed before tapping');
    assert.equal(observed.speed, 200, 'position swipes leave autoscroll rate unchanged');
    await input('up'); await input('up');
    await until(() => observed.previewLabel === 'Choose reading position: 45%', 'slider moved backward');
    await settled(); await shot('05f-position-adjusted');
    await input('click'); await until(() => observed.position === '45%' && observed.play === 'Next page', 'tap commits the position');
    await choosePosition(); await input('down');
    await openMenu(); await input('down'); await input('click');
    await until(() => !observed.previewLabel?.startsWith('Choose reading position:'), 'menu action cancels position selection');
    await until(() => lastGesture() === 'resume', 'cancel menu dismissed');
    assert.equal(observed.position, '45%', 'cancel preserves the reading position');
    result.positionPicker = { openedFromMenu: true, steppedBothWays: true, committed: true, cancelled: true };
    await openMenu(); await input('click');
    await until(() => observed.mode === 'auto' && lastGesture() === 'resume', 'Change mode back to Autoscroll');
    await input('click');
    await until(() => observed.play === 'Pause', 'Autoscroll started through glasses tap');
    const positionBeforeAuto = observed.passage;
    await until(() => observed.passage !== positionBeforeAuto, 'automatic line advancement', 20000);
    await shot('06-autoscroll');
    console.log('PASS: glasses menu switches documents, restores positions, adjusts/commits/cancels the position selector, changes mode and returns to the start.');

    const positionBeforeImport = observed.passage;
    const largeImportContent = '# Large background file\n\n' + 'A long imported passage. '.repeat(60000);
    await act({ kind: 'files', selector: '#file-picker', files: [{ name: 'large-background.md', content: largeImportContent }] });
    assert.equal(observed.importDisabled, false, 'Add files remains available during import');
    await until(() => observed.documents === '3' && !observed.importsPending, 'large background import');
    assert.equal(observed.title, 'Simulator reading test');
    assert.equal(observed.play, 'Pause', 'background import does not pause autoscroll');
    await until(() => observed.passage !== positionBeforeImport, 'reading continues during background import');
    await act({ kind: 'click', selector: '[aria-label="Delete large-background.md"]' });
    await act({ kind: 'click', selector: '[data-confirm-delete="large-background.md"]' });
    await until(() => observed.documents === '2' && !observed.libraryBusy, 'remove background import fixture');
    result.backgroundImports = { bytes: Buffer.byteLength(largeImportContent), preservedDocument: true, preservedPlayback: true, addRemainsEnabled: true };
    console.log('PASS: large worker import preserves the reading session and leaves Add files available.');

    const soakSeconds = Number(process.env.SIMULATOR_SOAK_SECONDS || 180);
    assert.ok(Number.isFinite(soakSeconds) && soakSeconds >= 0, 'SIMULATOR_SOAK_SECONDS must be a nonnegative number');
    recording?.mark('soak-start', { soakSeconds });
    const soakEnd = Date.now() + soakSeconds * 1000; let cycles = 0;
    while (Date.now() < soakEnd) {
      await sleep(3500);
      await act({ kind: 'headings', count: 8, interval: 35, finalIndex: 1 + cycles % 20 });
      await act({ kind: 'click', selector: '#play' });
      await input('down');
      await act({ kind: 'click', selector: '#play' });
      assert.equal(observed.connection, 'Native text connected');
      const counts = observed.diagnostics.counts;
      for (const type of ['js-error', 'unhandled-rejection', 'bridge-error', 'bridge-timeout', 'display-paused']) assert.equal(counts[type] || 0, 0, type);
      cycles++;
      if (cycles % 6 === 0) console.log(`Soak: ${cycles} cycles completed.`);
    }
    await act({ kind: 'files', selector: '#file-picker', files: [{ name: 'tables.md', content: await readFile(new URL('../test/fixtures/tables.md', import.meta.url), 'utf8') }] });
    await until(() => observed.documents === '3' && !observed.libraryBusy, 'table import');
    assert.equal(observed.title, 'Simulator reading test', 'background import preserves the current document');
    await act({ kind: 'click', selector: '[data-document-id="tables.md"] .document-card' });
    await act({ kind: 'click', selector: '#mode-page' });
    await act({ kind: 'click', selector: '#passage .table-row-start' });
    assert.equal(observed.passage, '[1/3] Feature: Pages');
    assert.equal(observed.passageLines[1], '  Status: Ready');
    await settled(); await shot('07-table-records');
    const tableStart = [...observed.passageLines];
    await input('down');
    await until(() => observed.passage === tableStart[9], 'table page swipe advances without overlap');
    await settled(); await shot('07b-table-next-page');
    await input('up'); await until(() => observed.passage === tableStart[0], 'table previous page');
    await act({ kind: 'click', selector: '#mode-auto' });
    await act({ kind: 'range', selector: '#speed', value: 60 });
    await act({ kind: 'click', selector: '#play' });
    let tableRows = 0; let tableLines = [...observed.passageLines];
    await until(() => {
      if (observed.passageLines[0] !== tableLines[0]) {
        assert.deepEqual(observed.passageLines.slice(0, 8), tableLines.slice(1, 9), 'autoscroll retains every table line');
        tableLines = [...observed.passageLines]; tableRows++;
      }
      return tableRows >= 4;
    }, 'table autoscroll');
    await act({ kind: 'click', selector: '#play' });
    await settled(); await shot('07c-table-autoscroll');
    result.tables = { labeledRecords: true, paging: true, sequentialAutoRows: tableRows };
    console.log('PASS: labeled table records, full-page swipes and one-row autoscroll.');
    await act({ kind: 'click', selector: '#passage .table-row-start' });
    await act({ kind: 'click', selector: '#tab-bookmarks' });
    await act({ kind: 'click', selector: '#bookmark' });
    await act({ kind: 'flush' }); await sleep(700); await settled();
    const savedPassage = observed.passage; const savedPosition = observed.position;
    // Return to the library, then exercise its system exit path before a cold launch.
    await input('double_click');
    await until(() => observed.title === 'Choose something good.' && observed.previewLabel === 'Choose document: Table reading test', 'Back to library before restart');
    await act({ kind: 'flush' }); await sleep(700); await settled();
    await input('double_click'); await settled();
    result.beforeWebViewReset = observed.diagnostics.counts;
    await act({ kind: 'reopen' });
    await until(() => !observed.libraryBusy && observed.documents === '3' && observed.title === 'Choose something good.'
      && observed.connection === 'Native text connected' && observed.previewLabel?.startsWith('Choose document:'), 'restore library with no document selected');
    await sleep(300); await settled(); await shot('07d-library-after-webview-reset');
    const tableIndex = observed.documentIds.indexOf('tables.md');
    for (let i = 0; i < tableIndex; i++) await input('down');
    await input('click');
    await until(() => observed.title === 'Table reading test' && observed.passage != null, 'open saved document after browser reset');
    assert.equal(observed.passage, savedPassage); assert.equal(observed.position, savedPosition);
    assert.equal(observed.bookmarks, 1); assert.equal(observed.play, 'Start autoscroll');
    await settled(); await shot('07d-after-webview-reset');
    result.phonePersistence = { restoredAfterBrowserReset: true, documents: 3, readingPosition: true, bookmarks: true };
    console.log('PASS: real SDK storage restores the library, reading position and bookmark after browser storage is cleared.');
    await act({ kind: 'click', selector: '[aria-label="Delete tables.md"]' });
    await act({ kind: 'click', selector: '[data-confirm-delete="tables.md"]' });
    await until(() => observed.documents === '2' && observed.title !== 'Table reading test' && !observed.libraryBusy, 'remove table fixture');
    await act({ kind: 'click', selector: '[data-document-id="test.md"] .document-card' });
    await act({ kind: 'click', selector: '[aria-label="Delete test.md"]' });
    await act({ kind: 'click', selector: '[data-confirm-delete="test.md"]' });
    await until(() => observed.documents === '1' && observed.title === 'Choose something good.' && observed.previewLabel === 'Choose document: Second saved document' && !observed.libraryBusy, 'deleting the active document returns to the library');
    await shot('07-after-delete');
    await act({ kind: 'click', selector: '[aria-label="Delete zz-other.md"]' });
    await act({ kind: 'click', selector: '[data-confirm-delete="zz-other.md"]' });
    await until(() => observed.documents === '0' && !observed.libraryBusy && observed.title === 'Choose something good.', 'delete last document');
    await sleep(300); await settled(); await shot('08-empty-library');
    result.localLibrary = { imported: true, deletedActive: true, deletedLast: true };
    for (const counts of [result.beforeWebViewReset, observed.diagnostics.counts]) {
      for (const type of ['js-error', 'unhandled-rejection', 'bridge-error', 'bridge-timeout', 'display-paused']) assert.equal(counts[type] || 0, 0, type);
    }
    await writeFile(path.join(resultDir, 'state.json'), JSON.stringify(observed, null, 2));
    console.log('PASS: local files import through the phone picker; active and last document deletion updates the glasses.');
    Object.assign(result, { soakSeconds, cycles });
    recording?.mark('tests-passed');
  }
} catch (error) {
  failure = error;
  recording?.mark('test-failure', { message: error.message });
} finally {
  // Collect evidence and finalize video before shutting down, including failed runs.
  if (child?.pid) {
    try {
      const response = await fetch(`${api}/api/console`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) await writeFile(path.join(resultDir, 'console.json'), JSON.stringify(await response.json(), null, 2));
    } catch { /* A crashed simulator may no longer answer; local observations remain. */ }
  }
  if (recording) {
    try { result.recording = await recording.stop(); }
    catch (error) { result.recording = { error: error.message }; failure ??= error; }
  }
  result.passed = !failure; result.observed = observed;
  if (failure) result.error = failure.stack;
  await writeFile(path.join(resultDir, 'result.json'), JSON.stringify(result, null, 2));
  if (child?.pid && child.exitCode == null && child.signalCode == null) {
    if (process.platform === 'linux') process.kill(-child.pid, 'SIGTERM'); else child.kill();
    await Promise.race([new Promise(r => child.once('exit', r)), sleep(3000)]);
    if (child.exitCode == null && child.signalCode == null) {
      if (process.platform === 'linux') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL');
    }
  }
  if (log) await new Promise(r => log.end(r));
  if (server?.listening) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(error => {
    // A desktop file-provider mount may outlive the simulator process. Keep
    // its cleanup failure from hiding the actual test result and artifacts.
    if (error.code !== 'EBUSY') throw error;
    console.warn(`Temporary desktop mount is still busy: ${dir}`);
  });
}
if (failure) { console.error(`FAIL: ${failure.message}\nArtifacts: ${resultDir}`); process.exitCode = 1; }
else if (scrollRepro) console.log(`Scroll scenarios recorded. Visual reproduction is awaiting review; this is not a bug-fix result. Artifacts: ${resultDir}`);
else if (tableStress) console.log(`PASS: large-table simulator scenarios. Artifacts: ${resultDir}`);
else if (pdfTest) console.log(`PASS: PDF simulator scenarios. Artifacts: ${resultDir}`);
else if (speedTest) console.log(`PASS: speed reading simulator scenarios. Artifacts: ${resultDir}`);
else console.log(`PASS: official simulator, ${result.soakSeconds}s soak, ${result.cycles} cycles. Artifacts: ${resultDir}`);
