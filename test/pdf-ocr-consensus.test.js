import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcilePdfOcr } from '../src/pdf-ocr-consensus.js';
const row = text => ({ text, x: 20, y: 50, width: 600, height: 20, confidence: 90,
  words: text.split(' ').map((text, i) => ({ text, x: 20 + i * 40, y: 50, width: 35, height: 20, confidence: 75 })) });
const source = text => [{ text, x: 20, y: 53, width: 600, height: 18 }];
test('independent text agreement repairs digit/letter confusion and low-confidence case without rewriting prose', () => {
  const line = row('The state 1s public and may Influence further associations.');
  const [fixed] = reconcilePdfOcr([line], source('The state is public and may influence further associations.'));
  assert.equal(fixed.text, 'The state is public and may influence further associations.');
  assert.equal(fixed.words[2].ocrOriginal, '1s'); assert.equal(fixed.words[2].x, line.words[2].x);
  assert.equal(line.text, 'The state 1s public and may Influence further associations.');
});
test('numbers, identifiers, acronyms, references and unrelated hidden text cannot be corrected by guessing', () => {
  const line = row('The US uses 1s pulses in H2O at 101 degrees.');
  const [fixed] = reconcilePdfOcr([line], source('The us uses 1s pulses in H2O at IOI degrees.'));
  assert.equal(fixed.text, line.text);
  assert.equal(reconcilePdfOcr([row('The answer 1s not visible here.')], source('Some completely unrelated hidden text here.'))[0].text, 'The answer 1s not visible here.');
  const marked = row('The state 1s public and shared.'); marked.words[2].references = [{ number: '1' }];
  assert.equal(reconcilePdfOcr([marked], source('The state is public and shared.'))[0].text, marked.text);
});
