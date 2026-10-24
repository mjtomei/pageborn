import test from 'node:test';
import assert from 'node:assert/strict';
import { confidenceWords, uncertainWords, SPEECH_CONFIDENCE_THRESHOLD } from '../src/speech-confidence.js';

test('word scores use weakest token, preserve punctuation/offsets and ignore punctuation confidence', () => {
  const pieces = [' Mr', '.', ' Qu', 'ilter', "'s", ' work', '.'];
  const scores = [.99, .01, .4, .98, .99, .95, .1].map((probability, token) => ({ token, probability }));
  const text = "Mr. Quilter's work.";
  const words = confidenceWords(text, scores, ids => ids.map(id => pieces[id]).join(''));
  assert.deepEqual(words.map(({ start, end, confidence }) => ({ start, end, confidence })), [{ start: 0, end: 2, confidence: .99 }, { start: 4, end: 13, confidence: .4 }, { start: 14, end: 18, confidence: .95 }]);
  assert.deepEqual(uncertainWords(text, words).map(word => text.slice(word.start, word.end)), ["Quilter's"]);
});
test('display threshold is 0.70 with strict comparison; malformed ranges/scores never hide arbitrary text', () => {
  assert.equal(SPEECH_CONFIDENCE_THRESHOLD, .7);
  const words = [.699, .7, .899, .9, NaN, -.2, 1.5].map(confidence => ({ start: 0, end: 4, confidence }));
  words.push({ start: -1, end: 4, confidence: .1 }, { start: 0, end: 50, confidence: .1 });
  assert.equal(uncertainWords('word', words).length, 1);
});
test('unalignable decoded output and partially decoded Unicode omit misleading highlighting', () => {
  const scores = [{ token: 0, probability: .2 }, { token: 1, probability: .9 }];
  assert.deepEqual(confidenceWords('café', scores, ids => ids.length === 1 ? 'caf�' : 'café'), []);
  assert.deepEqual(confidenceWords('corrected', scores, () => 'different'), []);
});
