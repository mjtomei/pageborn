import test from 'node:test';
import assert from 'node:assert/strict';
import { vocabularyWords, vocabularyBias, whisperVocabularyPrompt } from '../src/speech-vocabulary.js';
import { speechVocabulary, wordCommonness, vocabularyScore } from '../src/speech-vocabulary-ranking.js';

test('vocabulary is bounded, deduplicated and shares manual terms across documents', () => {
  assert.deepEqual(vocabularyWords(' Pageborne, JEV; Pageborne\nKantorowicz\n<|startoftranscript|>'), ['Pageborne', 'JEV', 'Kantorowicz', 'startoftranscript']);
  assert.equal(vocabularyWords(Array.from({ length: 80 }, (_, i) => 'Term' + i).join(',')).length, 80);
  const terms = speechVocabulary('JEV', { title: 'Pageborne', focus: 'Kantorowicz and phenomenology', passage: 'Kantorowicz and phenomenology. The conclusion about this paper.' }, [{ content: 'Quilter' }]);
  assert(terms.includes('JEV') && terms.includes('Kantorowicz') && terms.includes('phenomenology') && terms.includes('Quilter'));
  assert(!terms.includes('The')); assert.deepEqual(speechVocabulary('JEV', null, [{ content: 'Quilter' }]), ['JEV']);
});

test('English commonness favors uncommon lowercase words and caps absent words', () => {
  assert.equal(wordCommonness('the'), 7.73);
  assert.equal(wordCommonness('entropy'), 3.28);
  assert.equal(wordCommonness('ENTROPY'), 3.28);
  assert.equal(wordCommonness('entropy’s'), 3.28);
  assert.equal(vocabularyScore('the'), 0);
  assert(vocabularyScore('qubit') > vocabularyScore('model'));
  assert.equal(vocabularyScore('unlistedtechnicalword'), vocabularyScore('qubit'));
  assert(vocabularyScore('and-the') < vocabularyScore('qubit'));
  assert.deepEqual(speechVocabulary('', { passage: 'the and qubit' }), ['qubit']);
});

test('distance trades off with rarity, is symmetric, and follows the actual repeated reading place', () => {
  assert.equal(vocabularyScore('qubit', 120), vocabularyScore('qubit') / 2);
  assert.equal(vocabularyScore('qubit', -120), vocabularyScore('qubit', 120));
  assert(vocabularyScore('entropy', 0) > vocabularyScore('qubit', 240));
  const passage = 'repeated phrase qubit ' + 'the '.repeat(280) + 'repeated phrase axion';
  const at = focusOffset => speechVocabulary('', { passage, focus: 'repeated phrase', focusOffset });
  assert.equal(at(0)[0], 'qubit');
  assert.equal(at(passage.lastIndexOf('repeated phrase'))[0], 'axion');
  // A large context is cut around the reading place, never at its beginning.
  const large = 'the '.repeat(10000) + passage;
  assert.equal(speechVocabulary('', { passage: large, focusOffset: large.length - 5 })[0], 'axion');
  const distant = 'model ' + 'the '.repeat(260) + 'entropy';
  assert(speechVocabulary('', { passage: distant, focusOffset: 0 }).includes('model'));
  assert(!speechVocabulary('', { passage: distant, focusOffset: distant.length - 7 }).includes('model'), 'Tiny also drops weak hints as they recede');
});

test('manual terms win, current text precedes title/chat, and recent chat precedes older chat', () => {
  const terms = speechVocabulary('the, JEV', { title: 'Quilter', passage: 'qubit Qubit' },
    [{ content: 'Kantorowicz' }, { content: 'axion JEV' }]);
  assert.deepEqual(terms.slice(0, 3), ['the', 'JEV', 'qubit']);
  assert.equal(terms.filter(term => term.toLowerCase() === 'qubit').length, 1);
  assert(terms.indexOf('Quilter') < terms.indexOf('axion'));
  assert(terms.indexOf('axion') < terms.indexOf('Kantorowicz'));
});

test('all eligible terms survive old 24/64-term limits and worker normalization', () => {
  const candidates = Array.from({ length: 160 }, (_, i) => `technicalterm${i}`);
  const terms = speechVocabulary('JEV', { passage: candidates.join(' ') });
  assert.equal(terms.length, 161);
  assert(terms.includes(candidates.at(-1)));
  assert.deepEqual(vocabularyWords(terms), terms);
  // More than the manual field's 4000 chars still survive transport.
  const many = Array.from({ length: 200 }, (_, i) => `technicalterminology${i}`);
  assert(many.join('\n').length > 4000);
  assert.equal(vocabularyWords(many).length, many.length);
});

test('automatic vocabulary excludes URLs, numbers, overlong fragments and repeated OCR garbage', () => {
  assert.deepEqual(speechVocabulary('', { passage: `123456 https://example.com/notaword ${'x'.repeat(60)} aaaaab qubit` }), ['qubit']);
});

test('Tiny biases plausible term prefixes with a bounded boost and never rescues suppressed tokens', () => {
  const tokenizer = { all_special_ids: [9], encode: () => [2, 3] };
  const bias = vocabularyBias(tokenizer, ['Quilter']);
  const logits = { data: new Float32Array([0, 0, -.2, -.5, -10]) };
  assert.equal(bias([[1n]], logits).get(2), .6);
  assert.equal(bias([[1n, 2n]], logits).get(3), 1.2);
  logits.data[3] = -Infinity; assert(!bias([[2n]], logits).has(3));
  assert.equal(logits.data[2], Math.fround(-.2), 'Bias calculation does not alter confidence inputs');
});

test('Whisper fills its 223-token previous-text allowance with whole terms and no special tokens', () => {
  const tokenizer = { all_special_ids: [90], encode: text => [...text].map(char => char === '!' ? 90 : 5) };
  const config = { prev_sot_token_id: 90, decoder_start_token_id: 91, no_timestamps_token_id: 92 };
  const { prefix, terms } = whisperVocabularyPrompt(tokenizer, config, ['JEV!', 'Kantorowicz']);
  assert.deepEqual(terms, ['Kantorowicz']);
  assert.equal(prefix[0], 90); assert.deepEqual(prefix.slice(-2), [91, 92]); assert(!prefix.slice(1, -2).includes(90));
  const full = whisperVocabularyPrompt(tokenizer, config, Array(200).fill('long custom term'));
  assert(full.prefix.length > 131 && full.prefix.length <= 226); assert.equal(full.tokenBudget, 223);
  assert.equal(whisperVocabularyPrompt(tokenizer, config, []).prefix, null);
  assert.equal(whisperVocabularyPrompt(tokenizer, {}, ['word']).prefix, null);
});

test('Whisper skips a term that will not fit and uses smaller lower-ranked terms to fill the remainder', () => {
  const tokenizer = { encode: text => Array(({ ' first.': 7, ' larger.': 3, ' last.': 2 })[text]).fill(1) };
  const config = { prev_sot_token_id: 90, decoder_start_token_id: 91, no_timestamps_token_id: 92 };
  const { prefix, terms, tokenBudget } = whisperVocabularyPrompt(tokenizer, config, ['first', 'larger', 'last'], 20);
  assert.deepEqual(terms, ['first', 'last']); assert.equal(tokenBudget, 9); assert.equal(prefix.length, 12);
});
