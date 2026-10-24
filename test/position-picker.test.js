import test from 'node:test';
import assert from 'node:assert/strict';
import { openPositionPicker, movePositionPicker, togglePositionStep, positionPickerText } from '../src/position-picker.js';
import { nativeLayout, byteLength, VISIBLE_LINES } from '../src/native-text.js';
import { parseDocument } from '../src/document.js';
import { createPdfLayout } from '../src/pdf-layout.js';

test('position swipes use the selected 5% or 1% marks and clamp at both ends', () => {
  const start = openPositionPicker({ maxY: 1000 }, 375);
  assert.equal(start.percent, 37.5);
  assert.equal(start.step, 5);
  const fine = togglePositionStep(start);
  assert.equal(fine.percent, 37.5, 'holding does not move the candidate');
  assert.deepEqual(togglePositionStep(fine), start, 'holding again restores coarse steps');
  for (const [initial, next, previous] of [[start, 40, 35], [fine, 38, 37]]) {
    assert.equal(movePositionPicker(initial, 1).percent, next);
    assert.equal(movePositionPicker(initial, -1).percent, previous);
    let picker = initial;
    for (let n = 0; n < 101; n++) picker = movePositionPicker(picker, 1);
    assert.equal(picker.percent, 100);
    for (let n = 0; n < 101; n++) picker = movePositionPicker(picker, -1);
    assert.equal(picker.percent, 0);
    assert.equal(picker.step, initial.step);
  }
  assert.equal(start.percent, 37.5, 'selecting a percentage does not mutate the starting state');
  assert.equal(movePositionPicker(openPositionPicker({ maxY: 0 }, 0), 1).percent, 0);
  assert.equal(movePositionPicker(togglePositionStep(openPositionPicker({ maxY: 0 }, 0)), 1).percent, 0);
});

test('position selector previews the target using bounded native text for Markdown and PDFs', () => {
  const layout = nativeLayout(parseDocument('# Test\n\n' + '中文👓 '.repeat(2000)));
  for (const percent of [0, 37.5, 50, 100]) {
    const picker = togglePositionStep(openPositionPicker(layout, layout.maxY * percent / 100));
    const text = positionPickerText(picker, layout);
    assert.match(text, new RegExp(`${percent}% of document`));
    assert.ok(byteLength(text) < 900);
    assert.equal(text.split('\n').length, VISIBLE_LINES);
    assert.equal(text.split('\n')[3].length, 23);
  }
  const pdf = createPdfLayout([1, 2, 3].map(number => ({ number, blocks: [{ x: 0, y: 0, width: 576, height: 1000, lines: [], text: '' }] })));
  assert.match(positionPickerText(openPositionPicker(pdf, 0), pdf), /PDF page 1 of 3/);
  assert.match(positionPickerText(openPositionPicker(pdf, pdf.maxY), pdf), /PDF page 3 of 3/);
});
