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

test('contents leaders do not block small-cap heading case consensus', () => {
  const lines = [row('CONTENTS'), row('I. SearcH For THE PuBLIC . . . . . 3'),
    { ...row('II. DiscovERY OF THE STATE . . . . . 37'), y: 100 }];
  for (const line of lines) for (const word of line.words) word.confidence = 96;
  const embedded = [...source('I. Search for the Public 3'), { ...source('II. Discovery of the State 37')[0], y: 103 }];
  const fixed = reconcilePdfOcr(lines, embedded);
  assert.equal(fixed[1].text, 'I. Search for the Public . . . . . 3');
  assert.equal(fixed[2].text, 'II. Discovery of the State . . . . . 37');
  assert.equal(fixed[1].words[4].ocrOriginal, 'PuBLIC');
  assert.equal(fixed[1].words.at(-1).text, '3');
});

test('contents casing requires page context and preserves source acronyms with bounded glyph repairs', () => {
  const heading = row('I. NASA And THE UN . . . . 7');
  for (const word of heading.words) word.confidence = 96;
  assert.equal(reconcilePdfOcr([heading], source('I. Nasa and the Un 7'))[0].text, heading.text);
  const lines = [row('CONTENTS'), heading, { ...row('II. Tue Democratic STATE . . . 75'), y: 100 }];
  const embedded = [...source('I. NASA and the UN 7'), { ...source('II. The Democratic State 75')[0], y: 103 }];
  const fixed = reconcilePdfOcr(lines, embedded);
  assert.equal(fixed[1].text, 'I. NASA and the UN . . . . 7');
  assert.equal(fixed[2].text, 'II. The Democratic State . . . 75');
  const partial = { ...row('IV. Ecuripse oF THE PuBric . . . .'), y: 200 };
  assert.equal(reconcilePdfOcr([...lines, partial], [...embedded, { ...source('IV. Eclipse of the Public 110')[0], y: 203 }])[3].text,
    'IV. Ecuripse of the Public . . . .', 'leaders and a missed folio must not misalign a title word');
  const third = { ...row('III. Our Modern WORLD . . . 80'), y: 150 };
  assert.equal(reconcilePdfOcr([...lines, third], [...embedded, { ...source('III. The Modern World 80')[0], y: 153 }])[3].text,
    'III. Our Modern World . . . 80', 'an unrelated word must not be substituted');
});
