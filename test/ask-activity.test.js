import test from 'node:test';
import assert from 'node:assert/strict';
import { AskChat } from '../src/ask-chat.js';
import { AskConversation, MESSAGE_WIDTH } from '../src/ask-conversation.js';
import { boundedActivities, chatMessages } from '../src/ask-activity.js';
import { conversationTurns } from '../integrations/even-terminal/pageborne-conversation.js';
import { bodyTextObjects, pageDefinition, reviewPageDefinition, modePageDefinition } from '../src/glasses.js';
import { LINE_HEIGHT, byteLength, TEXT_BYTES, measureNativeText } from '../src/native-text.js';

const activity = (id, text = 'Read agents.md', state = 'pending') => ({ id, kind: 'tool', text, state });

test('activity sync persists without reply notifications, context pollution or changed read receipts', () => {
  let stored = {}; const chat = new AskChat(() => stored, value => { stored = structuredClone(value); });
  const remote = { id: 'remote', question: 'Question', answer: 'Answer', state: 'complete' };
  chat.mergeConversation('p', 's', [remote], { baseline: true });
  chat.turns('p')[0].readThrough = 3;
  for (const state of ['pending', 'complete', 'pending']) {
    const merged = chat.mergeConversation('p', 's', [{ ...remote, activities: [activity('read', 'Read agents.md', state)] }]);
    assert.equal(merged.reply, undefined); assert.equal(chat.turns('p')[0].readThrough, 3);
  }
  const restored = new AskChat(() => stored, () => {});
  assert.equal(restored.turns('p')[0].activities[0].state, 'complete');
  assert.deepEqual(restored.history('p').map(i => i.content), ['Question', 'Answer']);
  restored.mergeConversation('p', 's', [remote]);
  assert.equal(restored.turns('p')[0].activities.length, 1);
});

test('late activity preserves glasses answer anchor and creates no assistant read receipts', () => {
  const turns = [{ id: 'one', question: 'Question', answer: 'A long answer. '.repeat(180), state: 'pending', readThrough: 0 }];
  const view = new AskConversation(); let frame = view.update(turns, 0, 'one:assistant');
  frame.y += LINE_HEIGHT * 2; const anchor = view.anchor(frame.y), before = view.window(frame.y).content;
  turns[0].activities = [activity('read'), { id: 'thinking', kind: 'thinking', text: 'Checking sources. '.repeat(20), state: 'complete' }];
  frame = view.update(turns, frame.y);
  assert.deepEqual(view.anchor(frame.y), anchor); assert.equal(view.window(frame.y).content, before);
  assert(!view.messages.some(m => m.key.endsWith(':thinking')));
  frame = view.update(turns, frame.y, 'one:activity:read');
  const window = view.window(frame.y);
  assert(window.alignments.includes('activity'));
  assert(window.readReceipts.every(r => r.prefix === turns[0].answer.replace(/\s/g, '').slice(0, r.end)));
  const pending = new AskConversation(); pending.update([{ id: 'two', question: 'Question', state: 'pending', activities: [activity('a')] }], 0, 'latest');
  assert.equal(pending.following, true); assert.deepEqual(pending.window(0).readReceipts, []);
});

test('native activity has its own dim layer, with bright answers and bounded review/menu containers', () => {
  const content = { body: 'Question\nRunning: Read agents.md\nAnswer', alignments: ['user', 'activity', 'assistant'], status: 'Ask' };
  const boxes = bodyTextObjects(content);
  assert.equal(boxes[0].textColor, 4); assert.equal(boxes[0].content, 'Question\n\nAnswer');
  assert.equal(boxes[1].textColor, 1); assert.equal(boxes[1].content, '\nRunning: Read agents.md\n');
  const dialog = { text: 'one two three four five six seven eight', hint: 'Tap: send', uncertain: [{ start: 4, end: 7 }, { start: 14, end: 18 }] };
  for (const page of [pageDefinition('page', content), reviewPageDefinition(content, dialog), modePageDefinition(content, 0)]) {
    assert(page.containerTotalNum <= 8); assert.equal(page.textObject.filter(b => b.isEventCapture).length, 1);
    assert.equal(page.textObject.find(b => b.containerName === 'status').textColor, 4);
    assert(page.textObject.every(b => byteLength(b.content) <= TEXT_BYTES));
  }
  assert.equal(bodyTextObjects({ body: 'Ordinary reading' }).length, 1);
});

test('activity is bounded independently and the server does not expose arbitrary tool payloads', () => {
  const values = Array.from({ length: 100 }, (_, i) => ({ id: String(i), kind: 'tool', text: 'x'.repeat(2000), state: 'complete' }));
  const bounded = boundedActivities(values);
  assert(bounded.length <= 24); assert(bounded.reduce((n, a) => n + a.text.length, 0) <= 4000);
  assert.equal(bounded.at(-1).id, '99');
  const turns = conversationTurns([{ id: 't', status: 'completed', items: [
    { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'Question' }] },
    { id: 'raw', type: 'commandExecution', aggregatedOutput: 'SECRET' },
    ...values.map(a => ({ ...a, type: 'activity' })), { id: 'a', type: 'agentMessage', text: 'Answer' }] }]);
  assert.doesNotMatch(JSON.stringify(turns), /SECRET/); assert.equal(turns[0].answer, 'Answer');
  assert(turns[0].activities.reduce((n, a) => n + a.text.length, 0) <= 4000);
});

test('saved and incoming thinking entries disappear without losing actions, answers or live progress', () => {
  const thoughts = Array.from({ length: 30 }, (_, i) => ({ id: `think-${i}`, kind: 'thinking', text: 'Checking sources.', state: 'complete' }));
  const remote = { id: 'remote', question: 'Question', answer: 'Answer', state: 'complete', activities: [activity('read'), ...thoughts] };
  let stored = { p: [remote] };
  const chat = new AskChat(() => stored, value => { stored = structuredClone(value); });
  assert.deepEqual(chat.turns('p')[0].activities, [activity('read')]);
  chat.persist('p'); assert(!JSON.stringify(stored).includes('Checking sources.'));
  chat.mergeConversation('p', 's', [remote], { baseline: true });
  const turn = chat.turns('p').find(t => t.remoteId === 'remote');
  assert.deepEqual(turn.activities, [activity('read')]);
  assert.deepEqual(chatMessages(turn).map(m => m.text), ['Question', 'Tool: Read agents.md', 'Answer']);
  const pending = chatMessages({ question: 'Question', state: 'pending', activities: thoughts });
  assert.equal(pending.find(m => m.role === 'activity').text, 'Working…');
  assert.equal(chatMessages({ ...remote, activities: thoughts }).filter(m => m.role === 'activity').length, 0);
});

test('native actions fit exactly one line including ellipsis and preserve literal command syntax', () => {
  for (const state of ['pending', 'complete', 'error']) {
    for (const text of ['Read agents.md', 'Shell echo <file> && cat __x__',
      'Shell ' + 'W'.repeat(48) + '…', 'Shell ' + 'i'.repeat(120), 'Read ' + '文😀'.repeat(30),
      'Shell echo first\nsecond\tthird', 'Shell ' + 'very-long-file_name/'.repeat(10)]) {
      const view = new AskConversation();
      view.update([{ id: 'one', question: 'Question', answer: 'Answer', state, activities: [activity('command', text, state)] }], 0, 'latest');
      const message = view.messages.find(m => m.role === 'activity');
      assert.equal(message.rows.length, 1, text);
      const line = message.rows[0].text;
      assert(measureNativeText(line) <= MESSAGE_WIDTH, line);
      assert(byteLength(line) < TEXT_BYTES); assert(!/\n|\t|…{2}/.test(line));
      const full = message.text.replace(/\s+/g, ' ').trim();
      if (measureNativeText(full) <= MESSAGE_WIDTH) assert.equal(line, full);
      else { assert(line.endsWith('…')); assert(full.startsWith(line.slice(0, -1))); }
      if (text.includes('<file>')) assert(line.includes('<file>') && line.includes('__x__'));
    }
  }
});

test('long command detail survives restart and older snapshots without changing replies or receipts', () => {
  let saved = {};
  const chat = new AskChat(() => saved, data => { saved = structuredClone(data); });
  const remote = { id: 'r', question: 'Question', answer: 'Answer', state: 'complete', activities: [activity('command', 'Shell short…', 'complete')] };
  chat.mergeConversation('p', 's', [remote], { baseline: true });
  chat.turns('p')[0].readThrough = 3;
  const detail = 'Shell node scripts/check.mjs --input documents/a-long-filename.md --format markdown --include-notes';
  const result = chat.mergeConversation('p', 's', [{ ...remote, activities: [{ ...remote.activities[0], state: 'pending', detail }] }]);
  assert.equal(result.reply, undefined); assert.equal(chat.turns('p')[0].readThrough, 3);
  assert.equal(chat.turns('p')[0].activities[0].state, 'complete');
  chat.mergeConversation('p', 's', [remote]);
  const restored = new AskChat(() => saved, () => {}), turn = restored.turns('p')[0];
  assert.equal(turn.activities[0].detail, detail);
  assert.deepEqual(restored.history('p').map(m => m.content), ['Question', 'Answer']);
  const message = chatMessages(turn).find(m => m.role === 'activity');
  assert.equal(message.text, 'Tool: ' + detail); assert.equal(message.lines, 2);
  const values = Array.from({ length: 24 }, (_, i) => ({ ...activity(String(i)), detail: 'x'.repeat(2000) }));
  assert(boundedActivities(values).reduce((n, a) => n + a.text.length + (a.detail?.length || 0), 0) <= 4000);
});

test('long native command details fill up to two lines with ellipsis inside the final line', () => {
  const view = new AskConversation();
  for (const detail of ['Shell echo <file> && cat __x__',
    'Shell node scripts/check-document.mjs --include-annotations --input a-long-filename.md',
    'Bash ' + 'W'.repeat(130), 'Shell ' + 'i'.repeat(400), 'Read ' + '文😀'.repeat(100)]) {
    view.update([{ id: 'one', question: 'Question', answer: 'Answer', state: 'complete',
      activities: [{ ...activity('command', 'Old short summary…'), detail }] }], 0, 'latest');
    const message = view.messages.find(m => m.role === 'activity'), rows = message.rows;
    assert(rows.length >= 1 && rows.length <= 2);
    for (const row of rows) { assert(measureNativeText(row.text) <= MESSAGE_WIDTH); assert(byteLength(row.text) < TEXT_BYTES); }
    if (measureNativeText(message.text) <= MESSAGE_WIDTH) assert.equal(rows[0].text, message.text);
    else assert.equal(rows.length, 2);
    if (measureNativeText(message.text) > MESSAGE_WIDTH * 2) {
      assert(rows[1].text.endsWith('…')); assert(!rows[0].text.endsWith('…'));
      assert(measureNativeText(rows[1].text) > MESSAGE_WIDTH * 0.85);
    }
  }
});
