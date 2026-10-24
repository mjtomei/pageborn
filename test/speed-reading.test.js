import test from 'node:test';
import assert from 'node:assert/strict';
import { getTextWidth } from '@evenrealities/pretext';
import { Reader } from '../src/reader.js';
import { parseDocument, rowAt } from '../src/document.js';
import { nativeLayout, byteLength, TEXT_BYTES, measureNativeText } from '../src/native-text.js';
import { speedEntries, SpeedReading, wordsPerMinute, wordsPerGroup, wordSpeedFromSlider, wordSpeedToSlider, stepWordSpeed } from '../src/speed-reading.js';
import { bodyText, statusText } from '../src/glasses.js';

function readerFor(text) {
  const layout = nativeLayout(parseDocument(text)); const reader = new Reader();
  reader.setDocument(layout.maxY); reader.setSpeedDocument(layout); reader.setMode('speed');
  return { reader, layout };
}

test('visible words accrue dwell during footer work without advancing into a busy display', () => {
  const { reader } = readerFor('one two three four five six seven eight nine');
  reader.setWordGroup(3); reader.setWordSpeed(1000); reader.togglePlay();
  reader.tick(.1, false, false);
  assert.equal(reader.elapsed, .1); assert.equal(reader.speedReading.current.start, 0);
  reader.tick(.1, false, false);
  assert.equal(reader.speedReading.current.start, 0, 'hold at the deadline until the lane is free');
  reader.tick(0, false, true);
  assert.equal(reader.speedReading.current.start, 3); assert.equal(reader.elapsed, 0);
  reader.tick(.4, true, false);
  assert.equal(reader.elapsed, 0, 'unacknowledged words do not accrue dwell');
  reader.tick(.17);
  assert.equal(reader.speedReading.current.start, 3, 'the next group gets a fresh full dwell');
  reader.tick(.02);
  assert.equal(reader.speedReading.current.start, 6);
  reader.pause(); reader.tick(.5, false, false);
  assert.equal(reader.elapsed, 0, 'pausing discards any accumulated dwell');
});

test('speed reading keeps source words across wrapped rows, punctuation and Unicode', () => {
  const text = 'one '.repeat(20) + 'punctuation—stays! café 🦉漢字 ' + 'x'.repeat(500);
  const entries = speedEntries(nativeLayout(parseDocument(text)));
  assert.equal(entries.map(e => e.text).join(''), text.replace(/\s/g, ''));
  assert.ok(Math.abs(entries.reduce((sum, e) => sum + e.words, 0) - 24) < .0001);
  const speed = new SpeedReading(); speed.load(nativeLayout(parseDocument(text))); speed.count = 10;
  const shown = [];
  do {
    const group = speed.current;
    assert.ok(group.end > group.start); assert.ok(group.words <= 10.0001);
    assert.ok(byteLength(group.content) <= TEXT_BYTES);
    const lines = group.content.split('\n').filter(s => s.trim());
    assert.ok(lines.length <= 3);
    for (const line of lines) {
      assert.ok(getTextWidth(line) <= 552);
      const left = getTextWidth(line) - getTextWidth(line.trimStart());
      assert.ok(Math.abs(left - (552 - getTextWidth(line.trimStart())) / 2) < 6, 'native line is centered');
    }
    shown.push(...speed.entries.slice(group.start, group.end).map(e => e.text));
  } while (speed.step(1));
  assert.equal(shown.join(''), text.replace(/\s/g, ''));
});

test('detached sentence punctuation stays with its word without adding word count or dwell', () => {
  const { reader } = readerFor('Hello , world ! Really ? Yes … done . ” next ; final : end 。');
  reader.setWordGroup(1); reader.setWordSpeed(120);
  const speed = reader.speedReading;
  assert.equal(speed.remainingSeconds, 4);
  const shown = [];
  do { shown.push(speed.current.text); assert.equal(speed.current.words, 1); } while (speed.step(1));
  assert.deepEqual(shown, ['Hello,', 'world!', 'Really?', 'Yes…', 'done.”', 'next;', 'final:', 'end。']);
  // Eight lexical words, each with exactly one half-second dwell at 120 WPM.
  speed.seek(0); assert.equal(speed.remainingSeconds, 4);
  reader.togglePlay(); reader.tick(.49); assert.equal(speed.current.text, 'Hello,');
  reader.tick(.01); assert.equal(speed.current.text, 'world!');
});

test('punctuation stays attached at group boundaries, on backward steps and restored old cursors', () => {
  const { reader, layout } = readerFor('one two three . four five six ! seven');
  const speed = reader.speedReading;
  assert.equal(speed.current.text, 'one two three.');
  assert.equal(speed.current.words, 3);
  reader.pageStep(1); assert.equal(speed.current.text, 'four five six!');
  reader.pageStep(-1); assert.equal(speed.current.text, 'one two three.');
  // Source slots remain unchanged, including the old standalone period.
  assert.deepEqual(speed.entries.map(entry => entry.text), ['one', 'two', 'three', '.', 'four', 'five', 'six', '!', 'seven']);
  reader.setWordGroup(1);
  assert.equal(speed.load(layout, 0, { index: 3, total: 9, text: '.' }), true);
  assert.equal(speed.current.text, 'three.');
  assert.equal(speed.load(layout, 0, { index: 4, total: 9, text: 'four' }), true);
  assert.equal(speed.current.text, 'four');
  reader.pageStep(-1); assert.equal(speed.current.text, 'three.');
});

test('PDF punctuation across rows and separate text blocks retains source keys and attaches to preceding words', () => {
  const block = (text, y) => ({ y, page: 1, x: 0, sourceY: y, width: 100, height: 20,
    reflow: { rows: [{ text, y: 0, start: 0, end: text.length }] } });
  const layout = { format: 'pdf', blocks: [block('Last word', 0), block('. ”', 25), block('Next sentence .', 50)] };
  const speed = new SpeedReading(); speed.count = 1; speed.load(layout);
  speed.step(1); assert.equal(speed.current.text, 'word.”');
  const oldPeriod = speed.entries[2];
  assert.equal(speed.load(layout, 0, { key: oldPeriod.key, text: '.' }), true);
  assert.equal(speed.current.text, 'word.”');
  speed.step(1); assert.equal(speed.current.text, 'Next');
  speed.step(-1); assert.equal(speed.current.text, 'word.”');
  assert.equal(speed.entries.filter(entry => entry.key).length, 7);
});

test('attached punctuation fits the native display even at long-word and full-group boundaries', () => {
  for (const source of ['w'.repeat(44) + ' . ”', 'w'.repeat(44) + '.', '" ' + 'w'.repeat(44) + ' "',
    'w'.repeat(45) + '" next', Array.from({ length: 4 }, () => 'w'.repeat(43) + ' !').join(' ')]) {
    const speed = new SpeedReading(); speed.load(nativeLayout(parseDocument(source))); speed.count = 10;
    const shown = [];
    do {
      const group = speed.current;
      assert.ok(group.end > group.start);
      const lines = group.content.split('\n').map(line => line.trim()).filter(Boolean);
      assert.ok(lines.length <= 3);
      for (const line of lines) { assert.ok(measureNativeText(line) <= 544); assert.match(line, /[a-z]/); }
      shown.push(group.text);
    } while (speed.step(1));
    assert.equal(shown.join('').replace(/\s/g, ''), source.replace(/\s/g, ''));
  }
});

test('opening quotes attach forward, closing quotes attach backward, arithmetic stays intact', () => {
  const speed = new SpeedReading(); speed.count = 1;
  speed.load(nativeLayout(parseDocument('2 + 3 = 5 . Next “ quote . ” Then " another . "')));
  const shown = [];
  do { shown.push(speed.current.text); } while (speed.step(1));
  assert.deepEqual(shown, ['2', '+', '3', '=', '5.', 'Next', '“quote.”', 'Then', '"another."']);
});

test('straight quotes with or without spaces and terminal punctuation never get a word of their own', () => {
  for (const [source, expected] of [
    ['He said " hello world " then left.', ['He', 'said', '"hello', 'world"', 'then', 'left.']],
    ['He said "hello world " then " goodbye " .', ['He', 'said', '"hello', 'world"', 'then', '"goodbye".']],
    ['He left. " Next words " followed.', ['He', 'left.', '"Next', 'words"', 'followed.']],
    ["They said ' don't panic ' .", ['They', 'said', "'don't", "panic'."]],
    ['“ first ” « second » ( third ) [ fourth ] ¿ fifth ?', ['“first”', '«second»', '(third)', '[fourth]', '¿fifth?']],
    ['He said ( " hello " ) then left.', ['He', 'said', '("hello")', 'then', 'left.']],
    ['He said (" hello ") then left.', ['He', 'said', '("hello")', 'then', 'left.']],
  ]) {
    const { reader } = readerFor(source); reader.setWordGroup(1); reader.setWordSpeed(120);
    const speed = reader.speedReading, shown = [];
    assert.equal(speed.remainingSeconds, expected.length / 2, source);
    do { shown.push(speed.current.text); assert.equal(speed.current.words, 1); } while (speed.step(1));
    assert.deepEqual(shown, expected, source);
    assert.equal(shown.join('').replace(/\s/g, ''), source.replace(/\s/g, ''));
  }
});

test('quoted groups preserve navigation and legacy saved quote indexes', () => {
  const source = 'before " first second " after', layout = nativeLayout(parseDocument(source));
  const speed = new SpeedReading(); speed.count = 1; speed.load(layout);
  const original = ['before', '"', 'first', 'second', '"', 'after'];
  assert.deepEqual(speed.entries.map(e => e.text), original);
  for (const [index, text] of [[1, '"first'], [2, '"first'], [4, 'second"']]) {
    assert.equal(speed.load(layout, 0, { index, total: 6, text: original[index] }), true);
    assert.equal(speed.current.text, text);
  }
  speed.seek(5); speed.step(-1); assert.equal(speed.current.text, 'second"');
  speed.step(-1); assert.equal(speed.current.text, '"first');
  speed.step(1); assert.equal(speed.current.text, 'second"');
  speed.count = 2; speed.seek(0); assert.equal(speed.current.text, 'before "first');
  speed.step(1); assert.equal(speed.current.text, 'second" after');
});

test('PDF quote blocks attach to words across rows and retain old source keys', () => {
  const block = (text, y) => ({ y, page: 1, x: 0, sourceY: y, width: 100, height: 20,
    reflow: { rows: [{ text, y: 0, start: 0, end: text.length }] } });
  const layout = { format: 'pdf', blocks: [block('He said', 0), block('"', 25), block('hello world', 50), block('"', 75), block('then left', 100)] };
  const speed = new SpeedReading(); speed.count = 1; speed.load(layout);
  const opening = { ...speed.entries[2] }, closing = { ...speed.entries[5] };
  const shown = []; do { shown.push(speed.current.text); } while (speed.step(1));
  assert.deepEqual(shown, ['He', 'said', '"hello', 'world"', 'then', 'left']);
  assert.equal(speed.load(layout, 0, opening), true); assert.equal(speed.current.text, '"hello');
  assert.equal(speed.load(layout, 0, closing), true); assert.equal(speed.current.text, 'world"');
});

test('configured word count controls dwell time; slow bridge and background gaps never skip words', () => {
  const { reader } = readerFor('one two three four five six seven eight nine ten');
  reader.setWordSpeed(120); reader.setWordGroup(3); reader.togglePlay();
  reader.tick(1); assert.equal(reader.speedReading.current.text, 'one two three');
  reader.tick(1, true); reader.tick(30); assert.equal(reader.speedReading.cursor, 0);
  reader.tick(.5); assert.equal(reader.speedReading.current.text, 'four five six');
  reader.tick(1.5, true); assert.equal(reader.speedReading.cursor, 3);
  reader.tick(1.5); assert.equal(reader.speedReading.current.text, 'seven eight nine');
  reader.tick(1.5); assert.equal(reader.speedReading.current.text, 'ten');
  assert.equal(reader.playing, true, 'the final group gets its full dwell');
  reader.tick(.5); assert.equal(reader.playing, false); assert.equal(reader.speedReading.percent, 100);
  reader.togglePlay(); assert.equal(reader.speedReading.cursor, 0); assert.equal(reader.playing, true);
});

test('a document shorter than one page still plays every word and restores exact saved word', () => {
  const { reader, layout } = readerFor('one two three four five six seven');
  assert.equal(reader.maxY, 0);
  reader.setWordGroup(1); reader.seekWords(50);
  assert.equal(reader.speedReading.current.text, 'four');
  const saved = reader.speedReading.saved;
  reader.setMode('page'); reader.setMode('auto'); reader.setMode('speed');
  assert.equal(reader.speedReading.current.text, 'four', 'switching modes preserves the word within a source row');
  reader.setDocument(layout.maxY); reader.setSpeedDocument(layout, saved);
  assert.equal(reader.speedReading.current.text, 'four');
  reader.togglePlay(); reader.tick(1); assert.equal(reader.speedReading.current.text, 'five');
  reader.pause(); reader.tick(1); assert.equal(reader.speedReading.current.text, 'five');
});

test('rate and grouping changes preserve the current word and use separate autoscroll settings', () => {
  const { reader } = readerFor('one two three four five six seven eight nine ten');
  reader.setWordGroup(2); reader.pageStep(1); assert.equal(reader.speedReading.cursor, 2);
  reader.setWordGroup(4); assert.equal(reader.speedReading.current.text, 'three four five six');
  reader.scroll(-1); assert.equal(reader.speedReading.rate, 300); assert.equal(reader.speed, 30);
  reader.setMode('auto'); assert.equal(reader.playing, false); assert.equal(reader.speed, 30);
  reader.setMode('speed'); assert.equal(reader.speedReading.count, 4);
  reader.pageStep(1); reader.pageStep(-1); assert.equal(reader.speedReading.cursor, 2);
});

test('autoscroll updates the shared word location before a document is saved or replaced', () => {
  const { reader, layout } = readerFor(Array.from({ length: 240 }, (_, i) => `word${i}`).join(' '));
  reader.setMode('auto'); reader.setSpeed(60); reader.togglePlay();
  reader.tick(1); reader.tick(1); reader.pause();
  assert.equal(reader.speedReading.current.y, reader.y);
  const cursor = reader.speedReading.saved; const y = reader.y;
  reader.setDocument(layout.maxY, y); reader.setSpeedDocument(layout, cursor);
  reader.setMode('speed');
  assert.equal(reader.y, y);
  assert.deepEqual(reader.speedReading.saved, cursor);
});

test('all modes retain the exact final-screen word across switches and document reloads', () => {
  const { reader, layout } = readerFor(Array.from({ length: 240 }, (_, i) => `word${i}`).join(' '));
  reader.setWordGroup(1); reader.seekWords(97);
  const cursor = reader.speedReading.saved; const sourceY = reader.y;
  assert.ok(sourceY > layout.maxY, 'last words are below the last full viewport top');
  for (const mode of ['page', 'auto']) {
    reader.setMode(mode);
    assert.equal(reader.y, layout.maxY);
    assert.equal(reader.positionY, sourceY, 'source location is separate from viewport clamping');
    reader.setDocument(layout.maxY, reader.y); reader.setSpeedDocument(layout, cursor);
    assert.equal(reader.positionY, sourceY);
    reader.setMode('speed');
    assert.deepEqual(reader.speedReading.saved, cursor);
  }
  reader.setMode('page'); reader.pageStep(-1);
  const earlier = reader.y;
  reader.setMode('speed');
  assert.equal(reader.y, layout.rows[rowAt(layout, earlier)].y, 'a page turn becomes the new shared source line');
  assert.notEqual(reader.speedReading.saved.index, cursor.index);
});

const pdf = { format: 'pdf', maxY: 450, blocks: [
  { y: 0, reflow: { rows: [{ text: 'one hyphen-', start: 0, end: 11, y: 0 }, { text: 'ated two', start: 11, end: 19, y: 25 }] } },
  { y: 100, drawHeight: 300, height: 900, page: 1 },
  { y: 412, reflow: { rows: [{ text: 'Footnote 1 — PDF page 1', label: true, y: 0 }, { text: 'three four', start: 0, end: 10, y: 30 }] } },
] };
test('PDF reflow rejoins wrapped words, retains source labels and pauses on every figure screen', () => {
  const reader = new Reader(); reader.setDocument(pdf.maxY); reader.setSpeedDocument(pdf); reader.setMode('speed');
  reader.setWordSpeed(120); reader.setWordGroup(3);
  assert.equal(reader.speedReading.current.text, 'one hyphen-ated two');
  reader.togglePlay(); reader.tick(1.5);
  assert.equal(reader.playing, false); assert.equal(reader.speedReading.current.image, true); assert.equal(reader.y, 100);
  reader.tick(1); assert.equal(reader.y, 100);
  reader.togglePlay(); assert.equal(reader.y, 358); assert.equal(reader.playing, false);
  reader.togglePlay(); assert.equal(reader.playing, true); assert.equal(reader.speedReading.current.text, 'Footnote 1 —');
  assert.equal(speedEntries(pdf).filter(e => !e.image).map(e => e.text).join(' '), 'one hyphen-ated two Footnote 1 — PDF page 1 three four');
});

test('glasses frames use centered native words and explicit figure/end statuses', () => {
  const { reader, layout } = readerFor('one two three');
  const frame = { layout, mode: 'speed', wordFrame: reader.speedReading.current, wordRate: 250, percent: 0 };
  assert.match(bodyText(frame), /^\n{4} +one two three$/);
  assert.match(statusText(frame), /^0% Ⅱ 250 wpm +pg\. 1 +Hold: speak · 2× tap: Ask$/);
  assert.match(statusText({ ...frame, wordFrame: { image: true, page: 7 } }), /^0% Image · Tap: next +pg\. 1 +Hold: speak · 2× tap: Ask$/);
  assert.match(statusText({ ...frame, finished: true, percent: 100 }), /^Finished · Tap: restart +pg\. 1 +Hold: speak · 2× tap: Ask$/);
});

test('word rate and group settings clamp invalid values and preserve logarithmic steps', () => {
  assert.equal(wordsPerMinute(undefined), 250); assert.equal(wordsPerMinute(9000), 6000); assert.equal(wordsPerMinute(-1), 60);
  assert.equal(wordsPerGroup(undefined), 3); assert.equal(wordsPerGroup(99), 10); assert.equal(wordsPerGroup(-1), 1);
  assert.equal(stepWordSpeed(250, 1), 300);
  assert.equal(stepWordSpeed(5000, 1), 6000); assert.equal(stepWordSpeed(6000, 1), 6000);
  assert.equal(wordSpeedFromSlider(0), 60); assert.equal(wordSpeedFromSlider(1000), 6000);
  for (const rate of [60, 120, 250, 500, 1000, 2400, 5000, 6000]) assert.ok(Math.abs(wordSpeedFromSlider(wordSpeedToSlider(rate)) - rate) <= Math.max(1, rate * .003));
});

test('previous group respects screen capacity and returns immediately preceding long words', () => {
  const { reader } = readerFor(Array.from({ length: 12 }, (_, i) => `${i}${'w'.repeat(42)}`).join(' '));
  reader.setWordGroup(10);
  reader.pageStep(1); const previous = reader.speedReading.current;
  reader.pageStep(1); const current = reader.speedReading.current;
  reader.pageStep(-1);
  assert.equal(reader.speedReading.current.start, previous.start);
  assert.equal(reader.speedReading.current.end, current.start);
  reader.pageStep(1); assert.equal(reader.speedReading.current.start, current.start);
});

test('Markdown titles are atomic, centered, independent of word count, and dwell at half rate', () => {
  const title = 'A whole section title with more than ten words all shown together';
  const { reader } = readerFor(`prefix words\n\n## ${title}\n\nfollowing body words\n\nFinal title\n===========`);
  reader.setWordGroup(10); reader.setWordSpeed(600);
  assert.equal(reader.speedReading.current.text, 'prefix words', 'body group stops before a heading');
  reader.pageStep(1);
  const group = reader.speedReading.current;
  assert.equal(group.text, title); assert.equal(group.heading, true); assert.equal(group.words, 12);
  assert.equal(group.content.trim().replace(/\s+/g, ' '), title);
  reader.setWordGroup(1); assert.equal(reader.speedReading.current, group);
  reader.togglePlay(); reader.tick(1); reader.tick(1); reader.tick(.3);
  assert.equal(reader.speedReading.current, group, '12 words at 300 effective wpm need 2.4 seconds');
  reader.tick(.11); assert.equal(reader.speedReading.current.text, 'following');
  reader.pageStep(-1); assert.equal(reader.speedReading.current, group);
  reader.pageStep(-1); assert.equal(reader.speedReading.current.text, 'words');
  reader.pageStep(1); assert.equal(reader.speedReading.current, group);
  reader.seekWords(100); assert.equal(reader.speedReading.current.text, 'Final title', 'Setext and last titles stay whole');
});

test('word indexes survive the upgrade and old positions inside titles snap to their start', () => {
  const { reader, layout } = readerFor('# A long title wraps over several lines but keeps every source word at its old index\n\nFollowing body');
  const entries = reader.speedReading.entries;
  const saved = { total: entries.length, index: 6, text: entries[6].text };
  reader.setDocument(layout.maxY); reader.setSpeedDocument(layout, saved);
  assert.equal(reader.speedReading.cursor, 0);
  reader.seekWords(30); assert.equal(reader.speedReading.cursor, 0);
  reader.pageStep(1); assert.equal(reader.speedReading.current.text, 'Following body');
  reader.restoreWords(saved); assert.equal(reader.speedReading.cursor, 0);
  const plain = speedEntries(nativeLayout(parseDocument('# This is plain text', true)));
  assert.ok(plain.every(entry => !entry.heading), 'plain text does not invent headings');
});

test('title pauses wait for a click, including adjacent titles, last titles and restart', () => {
  const { reader, layout } = readerFor('body\n\n## First title\n\n### Second title\n\nnext body\n\n## Final title');
  reader.setPauseAtTitles(true); reader.setWordGroup(1); reader.setWordSpeed(600);
  reader.togglePlay(); reader.tick(.11);
  assert.equal(reader.speedReading.current.text, 'First title'); assert.equal(reader.playing, false);
  reader.tick(1); assert.equal(reader.speedReading.current.text, 'First title');
  reader.togglePlay(); assert.equal(reader.speedReading.current.text, 'Second title'); assert.equal(reader.playing, false);
  reader.togglePlay(); assert.equal(reader.speedReading.current.text, 'next'); assert.equal(reader.playing, true);
  reader.tick(.11); reader.tick(.11);
  assert.equal(reader.speedReading.current.text, 'Final title'); assert.equal(reader.playing, false);
  reader.togglePlay(); assert.equal(reader.speedReading.finished, true); assert.equal(reader.playing, false);
  reader.togglePlay(); assert.equal(reader.speedReading.current.text, 'body'); assert.equal(reader.playing, true);
  reader.setDocument(layout.maxY); reader.setSpeedDocument(layout);
  assert.equal(reader.pauseAtTitles, true, 'shared preference survives a document change');
  reader.pageStep(1); reader.setPauseAtTitles(false); reader.togglePlay();
  assert.equal(reader.speedReading.current.text, 'First title'); assert.equal(reader.playing, true);
  reader.tick(.39); assert.equal(reader.speedReading.current.text, 'First title');
  reader.setPauseAtTitles(true); assert.equal(reader.playing, false, 'enabling title pauses takes effect immediately');
});

test('recognized reflowed PDF headings stay whole without classifying notes or body as titles', () => {
  const block = (text, y, size = 16, extra = {}) => ({ kind: 'text', y, drawHeight: 30,
    lines: [{ text, x: 60, y, width: text.length * size * .45, height: size }],
    reflow: { rows: [{ text, y: 0, start: 0, end: text.length }] }, ...extra });
  const blocks = [block('I', 0), block('This is a sufficiently long body paragraph to establish the body font size.', 35),
    block('1. A Numbered Section', 70), block('Introduction', 105, 24),
    block('FOOTNOTE CONTENT', 140, 24, { annotation: { kind: 'footnote' } }),
    block('Caption — PDF page 1', 175, 24, { annotationLabel: true }),
    block('A normal sentence with Capitalized Words.', 210),
    { y: 245, drawHeight: 100, page: 1, kind: 'figure', lines: [{ text: 'PLOT TITLE', x: 1, y: 1, height: 24, width: 100 }] }];
  const layout = { format: 'pdf', blocks }; const entries = speedEntries(layout);
  assert.deepEqual([...new Set(entries.map(e => e.heading?.text).filter(Boolean))], ['I', '1. A Numbered Section', 'Introduction']);
  assert.deepEqual(speedEntries(JSON.parse(JSON.stringify(layout))), entries, 'classification survives cached source geometry');
  assert.equal(entries.at(-1).image, true);
});

test('very long titles request one fitted image instead of overflowing or silently dropping words', () => {
  const title = 'This exceptionally long heading '.repeat(60).trim() + '終わり';
  const { reader } = readerFor(`# ${title}\n\nbody`);
  assert.equal(reader.speedReading.current.heading, true);
  assert.equal(reader.speedReading.current.content, null);
  assert.equal(reader.speedReading.current.text, title);
  assert.equal(reader.speedReading.current.words, title.split(/\s+/).length);
  reader.pageStep(1); assert.equal(reader.speedReading.current.text, 'body');
  reader.pageStep(-1); assert.equal(reader.speedReading.current.text, title);
});

test('title status exposes half rate or the manual stop without altering the configured rate', () => {
  const frame = { mode: 'speed', wordFrame: { heading: true }, wordRate: 251, playing: true };
  assert.equal(statusText(frame), '0% Title · ▶ 125.5 wpm');
  assert.equal(statusText({ ...frame, playing: false }), '0% Title · Ⅱ 125.5 wpm');
  assert.equal(statusText({ ...frame, pauseAtTitles: true, playing: false }), '0% Title · Tap: next');
});

test('speed reading time counts remaining words and half-speed titles across seeks and rate changes', () => {
  const { reader } = readerFor('# A whole title\n\none two three four five six');
  reader.setWordSpeed(60); reader.setWordGroup(2);
  assert.equal(reader.speedReading.remainingSeconds, 12);
  reader.pageStep(1); assert.equal(reader.speedReading.remainingSeconds, 6);
  reader.pageStep(1); assert.equal(reader.speedReading.remainingSeconds, 4);
  reader.setWordSpeed(120); assert.equal(reader.speedReading.remainingSeconds, 2);
  reader.setWordGroup(1); assert.equal(reader.speedReading.remainingSeconds, 2, 'group size does not change words per minute');
  reader.pageStep(-1); assert.equal(reader.speedReading.remainingSeconds, 2.5);
  reader.speedReading.finished = true; assert.equal(reader.speedReading.remainingSeconds, 0);
  reader.speedReading.load(null); assert.equal(reader.speedReading.remainingSeconds, 0);
});

test('PDF reading time excludes figure waits and counts split display tokens as one word', () => {
  const reader = new SpeedReading(); reader.load(pdf); reader.rate = 60;
  assert.equal(reader.remainingSeconds, 11);
  reader.seek(3); assert.equal(reader.current.image, true); assert.equal(reader.remainingSeconds, 8);
  reader.step(1); assert.equal(reader.remainingSeconds, 8, 'another screen of a figure adds no invented duration');
  reader.load(nativeLayout(parseDocument('w'.repeat(250))));
  assert.ok(Math.abs(reader.remainingSeconds - 1) < 1e-8);
});

test('speed footer shows a bounded estimate for text, titles and figure pauses', () => {
  const frame = { mode: 'speed', percent: 100, wordRate: 1000, remainingSeconds: 6000 };
  for (const more of [{}, { playing: true }, { wordFrame: { heading: true } },
    { wordFrame: { heading: true }, pauseAtTitles: true }, { wordFrame: { image: true, page: 300 } }]) {
    const status = statusText({ ...frame, ...more });
    assert.match(status, /~2h$/);
    assert.ok(measureNativeText(status) <= 552, status);
  }
  assert.match(statusText({ ...frame, remainingSeconds: 18 }), /<1m$/);
  assert.doesNotMatch(statusText({ ...frame, finished: true }), /~|<1m/);
});
