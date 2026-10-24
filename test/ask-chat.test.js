import test from 'node:test';
import assert from 'node:assert/strict';
import { AskChat } from '../src/ask-chat.js';

function storage() {
  let saved = {}, writes = 0;
  const read = () => structuredClone(saved);
  const save = value => { saved = structuredClone(value); writes++; };
  return { create: () => new AskChat(read, save), read, writes: () => writes };
}
test('chat keeps multiple turns and papers, but sends only four completed pairs as follow-up context', () => {
  const store = storage(); const chat = store.create();
  for (let i = 0; i < 10; i++) {
    const id = chat.begin('one', `Question ${i}`, { position: 20, passage: 'PRIVATE SOURCE MUST NOT BE SAVED' });
    chat.update('one', id, `Answer ${i}`, 'complete');
  }
  chat.begin('two', 'Other paper', {});
  const restored = store.create();
  assert.equal(restored.turns('one').length, 10); assert.equal(restored.turns('two').length, 1);
  assert.equal(restored.history('one').length, 8); assert.equal(restored.history('one')[0].content, 'Question 6');
  assert(!JSON.stringify(store.read()).includes('PRIVATE SOURCE'));
  restored.forget('one'); assert.deepEqual(store.create().turns('one'), []); assert.equal(store.create().turns('two').length, 1);
});
test('background and reloaded replies join their original question without duplicating turns or writing every chunk', () => {
  const store = storage(); const chat = store.create(); const id = chat.begin('paper', 'Explain?', {});
  const before = store.writes(); chat.update('paper', id, 'Part'); chat.update('paper', id, 'Partial');
  assert.equal(store.writes(), before);
  const binding = { sessionId: 'session', pending: { turnId: id, question: 'Explain?', marker: 'unique' } };
  const restored = store.create(); assert.equal(restored.reconcile('paper', binding), id);
  const reply = { sessionId: 'session', seenEventId: 3, reply: { turnId: id, question: 'Explain?', answer: 'Complete', unread: true } };
  restored.reconcile('paper', reply); restored.reconcile('paper', reply);
  assert.equal(restored.turns('paper').length, 1); assert.equal(restored.turns('paper')[0].answer, 'Complete');
  assert.equal(store.create().history('paper')[0].content, 'Explain?');
  restored.reconcile('paper', { sessionId: 'session', seenEventId: 9, reply: { answer: 'Desktop follow-up', unread: true } });
  assert.equal(restored.turns('paper').length, 2); assert.equal(restored.history('paper').length, 2);
});
test('legacy cached replies migrate once and local chat storage stays bounded', () => {
  const store = storage(); const chat = store.create();
  const binding = { sessionId: 'old', seenEventId: 4, reply: { answer: 'Old answer' } };
  chat.reconcile('old', binding); chat.reconcile('old', binding); assert.equal(chat.turns('old').length, 1);
  for (let i = 0; i < 50; i++) { const id = chat.begin('paper', `Question ${i}`, {}); chat.update('paper', id, 'x'.repeat(16000), 'complete'); }
  assert(JSON.stringify(store.read().paper).length < 105000); assert.equal(chat.turns('paper').at(-1).question, 'Question 49');
  for (let i = 0; i < 25; i++) chat.begin(`paper-${i}`, 'hello', {});
  assert.equal(Object.keys(store.read()).length, 20);
});

test('saved long questions retain their beginning and ending on reload', () => {
  const store = storage(), chat = store.create(), question = 'Opening. ' + 'Spoken details. '.repeat(600) + ' Ending.';
  const id = chat.begin('paper', question, {}); chat.update('paper', id, 'Answer.', 'complete');
  assert.equal(store.create().turns('paper')[0].question, question);
  assert.equal(store.create().history('paper')[0].content, question);
});

test('the document retention budget keeps both model histories when switching', () => {
  const store = storage(), chat = store.create();
  const key = (id, agent) => JSON.stringify([id, 'terminal', 'https://desktop.test', agent, '']);
  for (let i = 0; i < 20; i++) for (const agent of ['claude', 'codex']) chat.begin(key(`paper-${i}`, agent), `${agent} question`, {});
  const restored = store.create();
  assert.equal(Object.keys(store.read()).length, 40);
  for (const agent of ['claude', 'codex']) assert.equal(restored.turns(key('paper-0', agent))[0].question, `${agent} question`);
  chat.begin(key('paper-0', 'claude'), 'Followup', {});
  chat.begin(key('paper-20', 'claude'), 'New document', {});
  for (const agent of ['claude', 'codex']) {
    assert(store.read()[key('paper-0', agent)]);
    assert.equal(store.read()[key('paper-1', agent)], undefined);
  }
});
