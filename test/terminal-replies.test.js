import test from 'node:test';
import assert from 'node:assert/strict';
import { EvenTerminal } from '../src/ask-terminal.js';

test('footer detects a completed reply without submitting a prompt, including replies sent from the desktop', async () => {
  let messages = [{ id: 1, type: 'user_prompt', text: 'our-marker' }]; let state = 'busy'; const requests = [];
  const client = new EvenTerminal({ mode: 'terminal', endpoint: 'https://terminal.example', token: 'test', agent: 'codex' }, { fetcher: async (url, options) => {
    requests.push(options.method); return Response.json({ state, messages });
  } });
  const pending = { sessionId: 'paper', pending: { marker: 'our-marker', cursor: 0 } };
  assert.equal((await client.peek(pending)).kind, 'pending');
  messages.push({ id: 2, type: 'text_delta', text: 'The answer' }, { id: 3, type: 'result', success: true, text: '' }); state = 'idle';
  const ready = await client.peek(pending); assert.equal(ready.kind, 'ready'); assert.equal(ready.answer, 'The answer');
  const seen = { sessionId: 'paper', seenEventId: ready.seenEventId }; assert.equal((await client.peek(seen)).kind, 'idle');
  messages.push({ id: 4, type: 'user_prompt', text: 'A question from the desktop' }, { id: 5, type: 'result', success: true, text: 'Desktop reply' });
  assert.equal((await client.peek(seen)).answer, 'Desktop reply'); assert(requests.every(method => method === 'GET'));
  assert.equal((await client.peek({ ...pending, pending: { marker: 'a-different-question' } })).kind, 'pending');
});

test('later successful results and new turns supersede historical errors without hiding unresolved failures', async () => {
  let messages = [{ id: 1, type: 'user_prompt', text: 'our-marker' }, { id: 2, type: 'error', text: 'Temporary failure' }];
  const client = new EvenTerminal({ mode: 'terminal', endpoint: 'https://terminal.example', token: 'test', agent: 'codex' }, {
    fetcher: async () => Response.json({ state: 'idle', messages }), pollMs: 1,
  });
  const pending = { sessionId: 'paper', pending: { marker: 'our-marker', cursor: 0 } };
  assert.equal((await client.peek(pending)).kind, 'error');
  let failed;
  await assert.rejects(client.reply(pending, value => { failed = value; }), /reported an error/);
  assert.equal(failed.notification, 'error'); assert.deepEqual(failed.pending, pending.pending, 'keep the question marker until a terminal result arrives');
  messages.push({ id: 3, type: 'result', success: true, text: 'Recovered answer' });
  assert.equal((await client.peek(pending)).answer, 'Recovered answer');
  assert.equal((await client.peek(failed)).answer, 'Recovered answer');
  messages.push({ id: 4, type: 'user_prompt', text: 'Later question' }, { id: 5, type: 'result', success: false });
  assert.equal((await client.peek({ sessionId: 'paper' })).kind, 'error');
  messages.push({ id: 6, type: 'user_prompt', text: 'Another question' }, { id: 7, type: 'result', success: true, text: 'Latest answer' });
  assert.equal((await client.peek({ sessionId: 'paper' })).answer, 'Latest answer');
  // The completed answer belongs to our question even if more turns followed.
  assert.deepEqual(await client.peek(pending), { kind: 'ready', answer: 'Recovered answer', seenEventId: 3 });
});

test('a pending question recovers its own completed outcome before later desktop turns', async () => {
  const messages = [{ id: 1, type: 'user_prompt', text: 'our-marker' },
    { id: 2, type: 'text_delta', text: 'Our answer' }, { id: 3, type: 'result', success: true },
    { id: 4, type: 'user_prompt', text: 'Later desktop question' }, { id: 5, type: 'result', success: true, text: 'Later answer' }];
  const client = new EvenTerminal({ mode: 'terminal', endpoint: 'https://terminal.example', token: 'test', agent: 'codex' }, {
    fetcher: async () => Response.json({ state: 'idle', messages }), pollMs: 1,
  });
  const pending = { sessionId: 'paper', pending: { marker: 'our-marker', cursor: 0 } };
  let saved;
  assert.equal((await client.reply(pending, value => { saved = value; })).answer, 'Our answer');
  assert.equal(saved.seenEventId, 3); assert.equal(saved.pending, undefined);
  assert.equal((await client.peek(saved)).answer, 'Later answer', 'retain the later turn for the next check');
  messages[2].success = false;
  assert.equal((await client.peek(pending)).kind, 'error', 'a later success must not conceal our failed turn');
  messages[2].success = true; messages[1].text = '';
  assert.match((await client.peek(pending)).message, /no text/, 'an empty completed reply is still an error');
  messages.splice(1, 2);
  assert.match((await client.peek(pending)).message, /Another prompt/, 'unrelated text cannot complete an unfinished question');
});

test('timed-out reply reads reconnect without failing or resubmitting the question', async () => {
  const binding = { sessionId: 'paper', pending: { marker: 'question', cursor: 0, turnId: 'turn' } };
  const client = new EvenTerminal({ mode: 'terminal', endpoint: 'https://terminal.example', token: 'test', agent: 'codex' }, { pollMs: 1 });
  const observations = [], progress = [], saves = [];
  client.peek = async current => {
    observations.push(current);
    if (observations.length < 3) throw Object.assign(new Error('Request timed out'), { connectionFailure: 'timeout' });
    return { kind: 'ready', answer: 'Recovered reply', seenEventId: 7 };
  };
  assert.equal((await client.reply(binding, value => saves.push(value), undefined, text => progress.push(text))).answer, 'Recovered reply');
  assert.deepEqual(progress, ['Reconnecting…', 'Reconnecting…']);
  assert(observations.every(value => value.pending === binding.pending && value.sessionId === binding.sessionId));
  assert.equal(saves.length, 1); assert.equal(saves[0].pending, undefined); assert.equal(saves[0].reply.turnId, 'turn');
  const abort = new AbortController();
  client.peek = async () => { abort.abort(); throw Object.assign(new Error('Request timed out'), { connectionFailure: 'timeout' }); };
  await assert.rejects(client.reply(binding, () => assert.fail('Cancellation must preserve pending'), abort.signal), /timed out/);
  client.peek = async () => { throw Object.assign(new Error('Access rejected'), { status: 401 }); };
  await assert.rejects(client.reply(binding, () => {}), /Access rejected/);
});
