import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument, layoutDocument, anchorAt, restoreAnchor, searchDocument, positionForMatch, wrapText, BODY_HEIGHT } from '../src/document.js';
import { Reader, actionForEvent, LatestFrameQueue, speedFromSlider, speedToSlider, stepAutoSpeed } from '../src/reader.js';
import { nativeLayout, pageTurnY } from '../src/native-text.js';

const layout = text => layoutDocument(parseDocument(text), value => Array.from(value).length * 11);

function paceLayout(counts) {
  const blocks = counts.map((words, index) => ({ index, kind: 'paragraph', text: Array(words).fill('word').join(' ') }));
  return { blocks, rows: blocks.map(block => ({ block: block.index, text: block.text, offset: 0, y: block.index * 100 })) };
}

test('Pages learns words per second from differently sized text panes after five samples', () => {
  const reader = new Reader(), pages = Array.from({ length: 11 }, (_, i) => i * 100);
  const read = seconds => { for (let i = 0; i < seconds; i++) reader.tick(1); reader.pageStep(1); };
  reader.setDocument(1000, 0, pages);
  reader.setSpeedDocument(paceLayout(pages.map((_, i) => (i + 1) * 10)));
  for (let i = 0; i < 4; i++) { read(20); assert.equal(reader.pageRemainingSeconds, undefined); }
  read(20);
  assert.equal(reader.pagesRead, 5); assert.equal(reader.pageReadWords, 150);
  assert.equal(reader.pageRemainingSeconds, 510 * 100 / 150, '510 words remain, including the current pane');
  reader.tick(1); assert.equal(reader.pageRemainingSeconds, 340, 'estimate updates per turn without countdown traffic');
  read(9); assert.equal(reader.pageRemainingSeconds, 450 * 110 / 210, 'pace is total words over total time, not a mean of pane rates');
  reader.jump(1000); assert.equal(reader.pageRemainingSeconds, 110 * 110 / 210, 'the last visible text still needs reading');
  reader.tick(1); reader.pageStep(1); assert.equal(reader.pagesRead, 6, 'repeated next at the end does not count');
  reader.setDocument(1000, 1000, pages);
  assert.equal(reader.pageRemainingSeconds, undefined, 'reopening the same document starts a fresh session');
  assert.equal(reader.pagesRead, 0); assert.equal(reader.pageReadSeconds, 0); assert.equal(reader.pageReadWords, 0);
});

test('Pages timing excludes jumps, backward navigation, blocked views and other reading modes', () => {
  const reader = new Reader(), pages = Array.from({ length: 20 }, (_, i) => i * 100);
  reader.setDocument(1900, 300, pages);
  reader.setSpeedDocument(paceLayout(pages.map(() => 10)));
  for (let i = 0; i < 5; i++) {
    reader.tick(1); reader.tick(1, true); reader.tick(30, true); reader.tick(NaN); reader.tick(-1);
    reader.tick(1); reader.pageStep(1);
  }
  assert.equal(reader.pagesRead, 5); assert.equal(reader.pageReadSeconds, 10);
  reader.tick(1); reader.pageStep(-1); assert.equal(reader.pageReadSeconds, 10);
  reader.tick(1); reader.jump(1234); assert.equal(reader.pagesRead, 5); assert.equal(reader.pageDwellSeconds, 0);
  assert.equal(reader.pageRemainingSeconds, 16, 'a seek changes remaining screens without changing the average');
  reader.tick(1); reader.setMode('auto'); reader.tick(1); reader.pageStep(1);
  assert.equal(reader.pageRemainingSeconds, undefined); assert.equal(reader.pagesRead, 5);
  reader.setMode('speed'); reader.tick(1); assert.equal(reader.pageRemainingSeconds, undefined);
  reader.setMode('page'); assert.equal(reader.pageDwellSeconds, 0); assert.equal(reader.pagesRead, 5);
  reader.pageStep(1); assert.equal(reader.pagesRead, 5, 'an undisplayed/zero-dwell page is not a sample');
});

test('a delayed phone timer still counts time reading an accepted manual page', () => {
  const reader = new Reader(), pages = Array.from({ length: 21 }, (_, i) => i * 100);
  reader.setDocument(2000, 0, pages); reader.setSpeedDocument(paceLayout(pages.map(() => 10)));
  for (let i = 0; i < 5; i++) { reader.tick(20); reader.pageStep(1); }
  assert.equal(reader.pagesRead, 5); assert.equal(reader.pageReadSeconds, 100);
  reader.tick(300, true); assert.equal(reader.pageDwellSeconds, 0, 'a hidden/suspended/blocked page is not timed');
});

test('word pace counts titles normally and does not double-count overlapping text rows', () => {
  const document = nativeLayout(parseDocument('# Three word title\n\n' + Array(500).fill('reading').join(' ')), 2);
  const reader = new Reader();
  reader.setDocument(document.maxY, 0, document.pages, (y, direction) => pageTurnY(document, y, direction));
  reader.setSpeedDocument(document);
  assert.equal(reader.pageWordsFrom(0), 503, 'titles have no automatic playback multiplier');
  while (reader.y < reader.maxY) {
    reader.tick(10); reader.pageStep(1);
    assert.equal(reader.pageReadWords + reader.pageWordsFrom(reader.y), 503);
  }
  assert(reader.pageRemainingSeconds > 0, 'final visible text is still included');
  const remaining = reader.pageWordsFrom(reader.y);
  reader.jump(reader.y - 1);
  assert(reader.pageWordsFrom(reader.y) >= remaining, 'partial-row jumps include the first visible row');
});

test('Markdown headings, lists, code, tables, Unicode and links remain readable without executing HTML', () => {
  const parsed = parseDocument('# Heading\n\nHello **bold** [link](https://example.org) &amp; café.\n\n- One\n- Two\n\n```js\nconst a = 1;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>');
  assert.deepEqual(parsed.headings.map(h => h.text), ['Heading']);
  const text = parsed.blocks.map(b => b.text).join('\n');
  for (const part of ['Hello bold link & café.', '• One', '• Two', 'const a = 1;', '[1/1] A: 1\nB: 2']) assert.ok(text.includes(part), part);
  assert.ok(!text.includes('alert'));
  assert.deepEqual(parseDocument('one\n\nthree', true).blocks.map(b => b.text), ['one', ' ', 'three']);
});
test('long words wrap without dropping characters or splitting surrogate pairs', () => {
  const text = '👓'.repeat(300);
  const lines = wrapText(text, 20, value => Array.from(value).length * 10);
  assert.equal(lines.map(l => l.text).join(''), text);
  assert.ok(lines.every(l => Array.from(l.text).length <= 2));
});
test('search targets the matching row inside a very long paragraph; anchors survive insertions', () => {
  const source = `# Start\n\n${'Word '.repeat(300)}TARGET ${'after '.repeat(80)}\n\n## End\nDone`;
  const first = layout(source);
  const hit = searchDocument(first, 'TARGET')[0];
  const y = positionForMatch(first, hit);
  assert.ok(y > 500);
  const anchor = anchorAt(first, y);
  assert.ok(anchor.text.includes('TARGET'));
  const second = layout(`# New material\n\n${'Added paragraph.\n\n'.repeat(30)}${source}`);
  const restored = restoreAnchor(second, anchor);
  assert.ok(restored > y);
  assert.equal(anchorAt(second, restored).text, anchor.text);
});
test('returning to repeated text restores the exact row inside a long paragraph', () => {
  const document = layout('# Repeat\n\n' + 'A long paragraph with room for thought. '.repeat(500));
  const y = document.rows[Math.floor(document.rows.length / 2)].y + 7;
  const anchor = anchorAt(document, y);
  assert.ok(document.rows.filter(row => row.text === anchor.text && row.sourceLine === anchor.sourceLine).length > 1);
  assert.equal(restoreAnchor(document, anchor), y);
});
test('autoscroll advances one line, waits for the display and never catches up after suspension', () => {
  const reader = new Reader(); reader.setDocument(2700);
  reader.setMode('auto'); reader.setSpeed(60); reader.togglePlay();
  reader.tick(.5); assert.equal(reader.y, 0);
  reader.tick(.5); assert.equal(reader.y, 27);
  for (let i = 0; i < 30; i++) reader.tick(1, true);
  assert.equal(reader.y, 27, 'blocked display cannot skip ahead');
  reader.tick(30); assert.equal(reader.y, 27, 'suspended timer cannot catch up');
  reader.tick(.5); assert.equal(reader.y, 27);
  reader.tick(.5); assert.equal(reader.y, 54);
  reader.pause(); reader.tick(1); assert.equal(reader.y, 54);
  reader.togglePlay(); reader.jump(137); reader.tick(1);
  assert.equal(reader.y, 137); assert.equal(reader.playing, false);
  reader.togglePlay(); reader.tick(1); assert.equal(reader.y, 162, 'resume after jump aligns to the next row');
  reader.jump(2699); reader.togglePlay(); reader.tick(1);
  assert.equal(reader.y, 2700); assert.equal(reader.playing, false);
  reader.togglePlay(); assert.equal(reader.playing, false);
});
test('autoscroll swipes change speed without moving position or starting paused playback', () => {
  const reader = new Reader(); reader.setDocument(2700, 540); reader.setMode('auto');
  reader.scroll(-1); assert.equal(reader.speed, 36);
  reader.scroll(1); assert.equal(reader.speed, 30);
  assert.equal(reader.y, 540); assert.equal(reader.playing, false);
  reader.setSpeed(0); assert.equal(reader.speed, 6);
  reader.scroll(1); assert.equal(reader.speed, 6);
  reader.setSpeed(1000); assert.equal(reader.speed, 200);
  reader.scroll(-1); assert.equal(reader.speed, 200);
  reader.togglePlay(); reader.tick(.29); assert.equal(reader.y, 540);
  reader.tick(.01); assert.equal(reader.y, 567, '200 lines/min advances every 300 ms');
  reader.setMode('page'); assert.equal(reader.playing, false);
  reader.togglePlay(); assert.equal(reader.playing, false, 'page mode stays manual');
  reader.scroll(-1); assert.ok(reader.y < 567);
});
test('real document pages align to rows and cover the entire document without skipped lines', () => {
  const document = layout('# Title\n\n' + Array.from({ length: 100 }, (_, i) => `Paragraph ${i}. ${'read this '.repeat(10)}\n\n`).join(''));
  assert.equal(document.pages.at(-1), document.maxY);
  for (let i = 0; i < document.pages.length; i++) {
    assert.ok(document.rows.some(row => row.y === document.pages[i]));
    if (i) assert.ok(document.pages[i] > document.pages[i - 1]);
  }
  for (const row of document.rows) assert.ok(document.pages.some(y => row.y >= y && row.y + row.height <= y + BODY_HEIGHT));
  const reader = new Reader(); reader.setDocument(document.maxY, 0, document.pages);
  reader.scroll(1); assert.equal(reader.y, document.pages[1]);
  reader.scroll(-1); assert.equal(reader.y, 0);
});
test('gesture routing handles omitted zero without treating unrelated events as clicks', () => {
  assert.equal(actionForEvent({ textEvent: {} }), 'play');
  assert.equal(actionForEvent({ sysEvent: {} }), 'play');
  assert.equal(actionForEvent({ audioEvent: {} }), null);
  assert.equal(actionForEvent({ textEvent: { eventType: 2 }, sysEvent: {} }), 'next');
  assert.equal(actionForEvent({ sysEvent: { eventType: 3 } }), 'back');
  assert.equal(actionForEvent({ textEvent: { eventType: 3 } }), 'back');
  assert.equal(actionForEvent({ sysEvent: { eventType: 7 } }), 'exit');
  assert.equal(actionForEvent({ sysEvent: { eventType: 4 } }), 'suspend');
  assert.equal(actionForEvent({ sysEvent: { eventType: 5 } }), 'resume');
  assert.equal(actionForEvent({ sysEvent: { eventType: 9 } }), 'ask-hold');
  assert.equal(actionForEvent({ sysEvent: { eventType: 10 } }), 'ask-release');
  assert.equal(actionForEvent({ menuItemClickEvent: { itemID: 10 } }), 'ask');
  assert.equal(actionForEvent({ menuItemClickEvent: { itemID: 2 } }), null);
  assert.equal(actionForEvent({ menuItemClickEvent: { itemID: 3 } }), 'mode');
  assert.equal(actionForEvent({ menuItemClickEvent: { itemID: 5 } }), 'start');
  assert.equal(actionForEvent({ menuItemClickEvent: { itemID: 7 } }), 'documents');
  assert.equal(actionForEvent({ menuItemClickEvent: { itemID: 8 } }), 'position');
  assert.equal(actionForEvent({ menuItemClickEvent: { itemID: 9 } }), 'footnotes');
});
test('slow display coalesces obsolete frames, never sends concurrently, and stops after failure', async () => {
  const sent = []; let release;
  const queue = new LatestFrameQueue(async frame => { sent.push(frame); await new Promise(r => { release = r; }); });
  queue.submit(1); queue.submit(2); queue.submit(3);
  let idle = false; const settled = queue.whenIdle().then(() => { idle = true; });
  assert.deepEqual(sent, [1]);
  release(); await new Promise(r => setImmediate(r));
  assert.deepEqual(sent, [1, 3]);
  assert.equal(idle, false, 'microphone waits for the pending popup, not just the old frame');
  release(); await settled; assert.equal(queue.running, false); assert.equal(idle, true);
  await queue.whenIdle();
  let error;
  const failed = new LatestFrameQueue(async () => { throw new Error('BLE disconnected'); }, e => { error = e; });
  failed.submit(1); await failed.whenIdle();
  assert.equal(error.message, 'BLE disconnected'); assert.equal(failed.stopped, true);
});

test('logarithmic speed travel preserves every manually entered rate and gives finer slow-speed control', () => {
  assert.equal(speedFromSlider(0), 6); assert.equal(speedFromSlider(1000), 200);
  assert.equal(speedFromSlider(500), Math.round(Math.sqrt(6 * 200)));
  let previous = 0;
  for (let position = 0; position <= 1000; position++) {
    const rate = speedFromSlider(position);
    assert.ok(rate >= previous && rate <= 200);
    previous = rate;
  }
  for (let rate = 6; rate <= 200; rate++) assert.equal(speedFromSlider(speedToSlider(rate)), rate);
  for (const [rate, faster, slower] of [[6, 7, 6], [30, 36, 25], [100, 120, 83], [200, 200, 167]]) {
    assert.equal(stepAutoSpeed(rate, 1), faster); assert.equal(stepAutoSpeed(rate, -1), slower);
  }
  assert.equal(speedFromSlider(-100), 6); assert.equal(speedFromSlider(1500), 200);
  assert.equal(speedFromSlider(NaN), 30);
});
