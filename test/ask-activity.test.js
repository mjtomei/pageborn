import test from 'node:test';
import assert from 'node:assert/strict';
import { AskChat } from '../src/ask-chat.js';
import { AskConversation } from '../src/ask-conversation.js';
import { boundedActivities } from '../src/ask-activity.js';
import { conversationTurns } from '../integrations/even-terminal/pageborne-conversation.js';
import { bodyTextObjects, pageDefinition, reviewPageDefinition, modePageDefinition } from '../src/glasses.js';
import { LINE_HEIGHT, byteLength, TEXT_BYTES } from '../src/native-text.js';

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
  frame = view.update(turns, frame.y, 'one:activity:thinking');
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
  const values = Array.from({ length: 100 }, (_, i) => ({ id: String(i), kind: 'thinking', text: 'x'.repeat(2000), state: 'complete' }));
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
