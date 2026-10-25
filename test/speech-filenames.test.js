import test from 'node:test';
import assert from 'node:assert/strict';
import { speechFilenames, speechVocabulary } from '../src/speech-vocabulary-ranking.js';
import { AskChat } from '../src/ask-chat.js';

test('dictation uses filenames throughout recent chat, including a long unfinished reply', () => {
  const chat = new AskChat(() => ({ paper: [
    { id: '1', question: 'Read `README.md`.', answer: 'A completed answer.', state: 'complete' },
    { id: '2', question: 'What should I change?', answer: '`speech_ui.js` needs updating. ' + 'More discussion. '.repeat(1000), state: 'pending' },
  ], other: [{ id: '3', question: 'Private_other.pdf', answer: 'Another document.', state: 'complete' }] }), () => {});
  assert.equal(chat.history('paper').length, 2, 'provider follow-up history still omits unfinished turns');
  const history = chat.vocabularyHistory('paper');
  assert.equal(history.length, 4);
  const context = { title: 'Paper', passage: 'A passage about entropy.' };
  assert.deepEqual(speechFilenames('', context, history), ['speech_ui.js', 'README.md']);
  const hints = speechVocabulary('Kantorowicz', context, history);
  assert.equal(hints[0], 'Kantorowicz');
  assert(hints.includes('speech ui dot j s')); assert(hints.includes('read me dot m d'));
  assert(hints.indexOf('speech ui dot j s') < hints.indexOf('entropy'));
  assert(!hints.some(t => t.includes('Private_other')));
});

test('filename context is bounded, recent-first and honors the context-vocabulary switch', () => {
  const history = Array.from({ length: 30 }, (_, i) => ({ content: `Use \`file_${i}.json\`.` }));
  const names = speechFilenames('', { title: 'document.pdf' }, history);
  assert.equal(names.length, 24); assert.equal(names[0], 'file_29.json');
  assert.deepEqual(speechFilenames('', null, history), []);
  assert.deepEqual(speechFilenames('manual.md', null, history), ['manual.md']);
  assert.deepEqual(speechVocabulary('manual', null, history), ['manual']);
});
