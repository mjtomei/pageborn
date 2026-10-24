// Exercise the real native text renderer. Speech/agent outputs are synthetic;
// AskSession, GlassesDisplay, the SDK and simulator gestures are unchanged.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const out = path.resolve('test-results/ask-review-simulator'); await mkdir(out, { recursive: true });
const temp = await mkdtemp(path.join(os.tmpdir(), 'pageborne-review-'));
let command = { id: 0 }, observed = {}, child;
const log = createWriteStream(path.join(out, 'simulator.log'));
const html = `<!doctype html><meta charset="utf-8"><canvas id="preview" width="576" height="288"></canvas><script type="module">
import { AskSession } from '/src/ask.js';
import { GlassesDisplay, paintFrame } from '/src/glasses.js';
import { nativeLayout } from '/src/native-text.js';
import { parseDocument } from '/src/document.js';
const errors = [], diagnostics = { active: null, log(type, data) { if (/error|timeout|paused/.test(type)) errors.push({ type, data }); } };
const session = new AskSession(); let posts = 0, underlay = null, conversationTurns = null, notification = '', mode = 'page', modePicker = null;
const reading = nativeLayout(parseDocument('Text from the paper stays above the microphone panel. '.repeat(80)));
const bitmap = document.createElement('canvas'); bitmap.width = 576; bitmap.height = 258;
const fig = bitmap.getContext('2d'); fig.fillStyle = '#000'; fig.fillRect(0, 0, 576, 258); fig.strokeStyle = '#fff'; fig.lineWidth = 3;
fig.strokeRect(60, 30, 456, 198); fig.beginPath(); fig.moveTo(80, 200); fig.lineTo(160, 60); fig.lineTo(300, 110); fig.lineTo(460, 40); fig.stroke();
const display = new GlassesDisplay({ diagnostics, onStatus() {}, onAction(action) {
  if (action === 'next' || action === 'previous') session.move(action === 'next' ? 1 : -1);
  if (action === 'back') session.cancelReview();
  if (action === 'play') {
    if (session.review) session.send(session.review.text, async () => { posts++; return { answer: 'The confirmed question reached the agent.' }; });
  }
} });
session.onChange = () => { if (conversationTurns && session.active) session.syncConversation(conversationTurns); const frame = underlay ? { mode, modePicker, speed: 200, wordRate: 6000, remainingSeconds: 7200, y: 0, layout: reading, dialog: session.dialog(), askStatus: notification, ...(underlay === 'image' ? { bitmap } : {}) } : { mode: 'page', y: 0, message: session.frame() }; paintFrame(document.querySelector('canvas').getContext('2d'), frame); display.submit(frame); };
session.open({ passage: 'A synthetic paper' }); session.showAnswer('Earlier conversation stays in place while reviewing the next question. '.repeat(80)); session.move(1);
await display.connect(); let last = 0;
setInterval(async () => {
 try {
  const cmd = await (await fetch('/__review-control')).json();
  if (cmd.id > last) { last = cmd.id; underlay = cmd.underlay || null; mode = cmd.mode || 'page'; modePicker = cmd.modePicker || null; if (cmd.notification) { notification = cmd.notification; session.review = null; session.setStatus('answer'); } else if (cmd.conversation) { session.close(); conversationTurns = cmd.conversation; session.open({}, [], conversationTurns); session.showAnswer(conversationTurns.at(-1).answer); } else if (cmd.live) { session.review = null; session.setStatus('listening'); session.updateTranscription(cmd.text, cmd.words || []); } else { session.reviewQuestion(cmd.text, cmd.words || []); session.review.dimmed = !!cmd.dimmed; session.review.refining = !!cmd.dimmed; } session.onChange(); }
  await fetch('/__review-observed', { method: 'POST', body: JSON.stringify({ command: last, status: session.status, y: session.y, review: session.review, posts, ready: display.ready, active: diagnostics.active, accepted: display.lastAccepted, body: display.acceptedFrame?.message?.body, following: session.conversation?.following, surface: display.surface, colors: display.sentColors, reviewTop: display.reviewTop, acceptedDialog: display.acceptedFrame?.dialog || display.acceptedFrame?.message?.dialog, errors }) });
 } catch (e) { errors.push(e.message); }
}, 100);
</script>`;
const vite = await createServer({ cacheDir: '.state/vite-review-sim', optimizeDeps: { entries: ['index.html'], include: ['@huggingface/transformers', 'wasm-feature-detect'] }, clearScreen: false, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'review-test', configureServer(server) {
  server.middlewares.use((req, res, next) => {
    if (req.url === '/__review') { res.setHeader('Content-Type', 'text/html'); res.end(html); }
    else if (req.url === '/__review-control') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(command)); }
    else if (req.url === '/__review-observed') { let body = ''; req.on('data', part => body += part); req.on('end', () => { observed = JSON.parse(body); res.end('{}'); }); }
    else next();
  });
} }] });
const port = Number(process.env.SIMULATOR_PORT || 9918), api = `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (observed.errors?.length) throw new Error(JSON.stringify(observed.errors)); if (await test()) return; if (child?.exitCode != null) throw new Error('Simulator exited'); await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
async function review(text, dimmed = false) { command = { id: command.id + 1, text, dimmed }; await until(() => observed.command === command.id && observed.status === 'review' && observed.acceptedDialog?.text === observed.review.pages[0] && !observed.active, 'review'); }
async function input(action) { const r = await fetch(`${api}/api/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) }); assert(r.ok); await sleep(400); }
async function shot(name) { const r = await fetch(`${api}/api/screenshot/glasses`); assert(r.ok); await writeFile(path.join(out, `${name}.png`), Buffer.from(await r.arrayBuffer())); }
const result = { passed: false, simulator: '0.9.5' };
try {
  await vite.listen();
  const env = { ...process.env, GSETTINGS_BACKEND: 'memory', NO_AT_BRIDGE: '1', GTK_USE_PORTAL: '0', LIBGL_ALWAYS_SOFTWARE: '1', WEBKIT_DISABLE_COMPOSITING_MODE: '1' };
  for (const [key, name] of Object.entries({ XDG_RUNTIME_DIR: 'runtime', XDG_CONFIG_HOME: 'config', XDG_CACHE_HOME: 'cache', XDG_DATA_HOME: 'data' })) { env[key] = path.join(temp, name); await mkdir(env[key], { mode: 0o700 }); }
  const binary = path.resolve(`node_modules/@evenrealities/sim-${process.platform}-${process.arch}/bin/evenhub-simulator`);
  child = spawn('dbus-run-session', ['--', binary, `${vite.resolvedUrls.local[0]}__review`, '--automation-port', String(port), '-c', path.join(temp, 'simulator.toml')], { env, detached: true });
  child.stdout.pipe(log); child.stderr.pipe(log);
  await until(async () => { try { return (await fetch(`${api}/api/ping`)).ok; } catch { return false; } }, 'simulator startup', 45000);
  await until(() => observed.ready && observed.accepted && !observed.active, 'native display');
  const y = observed.y;
  for (const underlay of ['reader', 'image']) {
    command = { id: command.id + 1, live: true, underlay, text: 'Provisional words' };
    await until(() => observed.command === command.id && observed.status === 'listening' && observed.acceptedDialog?.text.includes('Provisional') && !observed.active, 'live overlay');
    assert(!observed.acceptedDialog.hint.includes('Swipe')); await shot('00-live-' + underlay); assert.equal(observed.surface, underlay === 'image' ? 'review-pdf' : 'review-text');
    assert.equal(observed.reviewTop, 181); assert.match(observed.acceptedDialog.hint, /Tap: accept · Double tap: cancel$/); assert(!observed.acceptedDialog.actionText);
    command = { id: command.id + 1, live: true, underlay, text: 'Provisional speech about this passage. '.repeat(8) + 'LATEST WORDS' };
    await until(() => observed.command === command.id && observed.reviewTop === 127 && observed.acceptedDialog?.text.endsWith('LATEST WORDS') && !observed.active, 'expanded live overlay');
    assert(observed.acceptedDialog.hint.includes('Swipe')); await shot('00-live-expanded-' + underlay);
    command = { id: command.id + 1, underlay, text: 'Final question in the same box.' };
    await until(() => observed.command === command.id && observed.status === 'review' && observed.acceptedDialog?.text.includes('Final question') && !observed.active, 'review overlay');
    assert.equal(observed.reviewTop, 208); await shot('00-review-' + underlay); await input('double_click');
    await until(() => !observed.acceptedDialog && !observed.active, 'overlay cancelled');
  }
  for (const underlay of ['reader', 'image']) {
    const text = 'The older uncertain wording should stay visible. Newest doubtful words are shown here.';
    const words = [...text.matchAll(/older|uncertain|doubtful/g)].map(m => ({ start: m.index, end: m.index + m[0].length, confidence: .3 }));
    command = { id: command.id + 1, underlay, text, words };
    await until(() => observed.command === command.id && observed.acceptedDialog?.uncertain?.length > 0 && !observed.active, 'native word confidence');
    await shot('00-native-confidence-' + underlay);
    await input('double_click'); await until(() => !observed.acceptedDialog && !observed.active, 'confidence cancelled');
  }
  await review('Why does the author reject this argument?'); await shot('01-send'); assert.equal(observed.posts, 0);
  await review('Why does the author reject this argument?', true); await until(() => observed.acceptedDialog?.dimmed && observed.accepted.status.trim().startsWith('Refining'), 'dimmed review'); await shot('01b-dimmed');
  await review('Why does the author reject this argument?'); await until(() => !observed.acceptedDialog?.dimmed, 'normal brightness');
  await input('down'); assert.equal(observed.review.page, 0); await shot('02-cancel');
  await input('double_click'); await until(() => observed.status === 'answer' && !observed.acceptedDialog && !observed.active, 'cancelled'); assert.equal(observed.y, y); assert.equal(observed.posts, 0);
  await review('Explain each part of this longer question about the paper and its reasoning. '.repeat(15));
  await input('down'); await until(() => observed.review?.page === 1 && observed.acceptedDialog?.text === observed.review.pages[1], 'next text page'); assert.doesNotMatch(observed.accepted.status, /\d+\/\d+|Swipe/); await shot('03-long-question'); assert.equal(observed.posts, 0);
  await input('click'); await until(() => observed.posts === 1 && observed.status === 'answer' && !observed.acceptedDialog && !observed.active, 'confirmed send');
  await shot('04-answer'); assert.deepEqual(observed.errors, []);
  const setConversation = async turns => {
    command = { id: command.id + 1, conversation: turns };
    await until(() => observed.command === command.id && observed.status === 'answer' && observed.following && observed.body?.endsWith(turns.at(-1).answer.split('\n').at(-1)) && !observed.active, 'conversation tail');
  };
  await setConversation([{ id: '1', question: 'Why does this matter?', answer: 'It changes the conclusion.' }, { id: '2', question: 'And the earlier argument?', answer: 'That still provides the premise.' }]);
  assert.equal(observed.body.split('\n').length, 9); const shortTail = observed.body;
  assert.match(shortTail, / +Why does this matter\?/); assert(!shortTail.includes('Assistant'));
  await shot('05-chat-tail');
  command = { id: command.id + 1, live: true, text: 'What about the next section?' };
  await until(() => observed.command === command.id && observed.status === 'listening' && observed.body === shortTail.split('\n').slice(-6).join('\n') && !observed.active, 'tail above recording');
  assert.equal(observed.reviewTop, 181); await shot('06-chat-recording');
  command = { id: command.id + 1, live: true, text: 'What about the next section and its connection to the preceding discussion? '.repeat(6) + 'LATEST WORDS' };
  await until(() => observed.command === command.id && observed.reviewTop === 127 && observed.acceptedDialog?.text.endsWith('LATEST WORDS') && observed.body === shortTail.split('\n').slice(-4).join('\n') && !observed.active, 'tail above expanded recording');
  await shot('06b-chat-recording-expanded');
  await review('What about the next section?'); await input('double_click');
  await until(() => observed.body === shortTail && !observed.acceptedDialog && !observed.active, 'tail restored');
  await setConversation([{ id: 'long', question: 'Explain the argument.', answer: 'Earlier discussion. '.repeat(100) + '\n\nMOST RECENT WORDS' }]);
  await input('up'); await until(() => !observed.following && !observed.active, 'scrolled history');
  const scrolled = observed.body; command = { id: command.id + 1, live: true, text: 'A follow-up about this earlier part.' };
  await until(() => observed.command === command.id && observed.status === 'listening' && observed.body === scrolled.split('\n').slice(0, 6).join('\n') && !observed.active, 'history above recording');
  await shot('07-chat-history-recording');
  command = { id: command.id + 1, live: true, text: 'A longer follow-up about this earlier part. '.repeat(8) + 'LATEST WORDS' };
  await until(() => observed.command === command.id && observed.reviewTop === 127 && observed.acceptedDialog?.text.endsWith('LATEST WORDS') && observed.body === scrolled.split('\n').slice(0, 4).join('\n') && !observed.active, 'history above expanded recording');
  await shot('07b-chat-history-expanded'); await review('A follow-up'); await input('double_click');
  await until(() => observed.body === scrolled && !observed.acceptedDialog && !observed.active, 'history restored');
  await setConversation([{ id: 'wrapped', question: 'Could you explain how this conclusion follows from the earlier argument? '.repeat(2), answer: 'The conclusion depends on the assumptions introduced in the previous section. '.repeat(2) + '\n\nEND' }]);
  assert.doesNotMatch(observed.accepted.status, /Swipe|\d+\/\d+/); await shot('08-wrapped-messages');
  command = { id: command.id + 1, underlay: 'reader', notification: 'Ask failed' };
  await until(() => observed.command === command.id && observed.accepted?.status.endsWith('! Hold: speak · Tap: Ask') && !observed.active, 'right-aligned notification');
  await shot('09-notification-right');
  command = { id: command.id + 1, underlay: 'reader', notification: 'No new replies' };
  await until(() => observed.command === command.id && observed.accepted?.status.endsWith('Tap: Ask') && !observed.active, 'idle ask hint');
  await shot('10-idle-ask-hint');
  for (const [status, symbol] of [['Thinking…', '○'], ['Reply in progress', '◐'], ['Unread reply', '●'], ['Ask failed', '!'], ['Connection lost', '↔'], ['Needs a response', '?'], ['Sharing paper…', '↑']]) {
    command = { id: command.id + 1, mode: 'speed', underlay: 'reader', notification: status };
    await until(() => observed.command === command.id && observed.accepted?.status.includes(symbol + ' Hold: speak · ') && /2×(?: tap)?: Ask$/.test(observed.accepted.status) && !observed.active, 'native status symbol');
    await shot('11-symbol-' + status.replace(/[^a-z]/gi, '-'));
  }
  assert.equal(observed.colors.status, 4); assert.equal(observed.colors.commands, 1);
  command = { id: command.id + 1, mode: 'auto', underlay: 'reader', notification: 'No new replies', modePicker: { index: 1 } };
  await until(() => observed.command === command.id && observed.surface === 'mode-text' && !observed.active, 'mode popup with two footer colors');
  await shot('12-mode-popup');
  assert.equal(Object.keys(observed.colors).length, 7, 'eight text containers including input capture');
  command = { id: command.id + 1, mode: 'auto', underlay: 'image', notification: 'No new replies', modePicker: { index: 1 } };
  await until(() => observed.command === command.id && observed.surface === 'mode-pdf' && !observed.active, 'PDF mode popup with two footer colors');
  await shot('13-pdf-mode-popup');
  Object.assign(result, { commandOnlyDimming: true, menuWithColoredFooter: true, nativeStatusSymbols: true, passed: true, rightAlignedNotification: true, idleAskHint: true, transcriptSizesOverlay: true, streamingTranscriptInOverlay: true, alignedCompactMessages: true, bottomFollowing: true, recordingMovesTail: true, recordingPreservesHistory: true, cancellationPreservesPosition: true, longTextPages: true, explicitSendOnly: true, nativeTextOverlay: true, liveOverReading: true, liveOverFigure: true, nativeGestureHintContainers: true });
} catch (error) { result.error = error.stack; throw error; }
finally {
  await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
  if (child?.pid && child.exitCode == null) { process.kill(-child.pid, 'SIGTERM'); await Promise.race([new Promise(r => child.once('exit', r)), sleep(3000)]); if (child.exitCode == null && child.signalCode == null) process.kill(-child.pid, 'SIGKILL'); }
  log.end(); await vite.close(); await rm(temp, { recursive: true, force: true });
}
console.log(JSON.stringify(result));
