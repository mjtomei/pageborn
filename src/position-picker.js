import { byteLength, titleText, textWindow } from './native-text.js';

export const POSITION_STEP = 5;
export function openPositionPicker(layout, y) {
  const max = layout.maxY > 0 ? 100 : 0;
  return { percent: max ? Math.max(0, Math.min(100, Math.round(y / layout.maxY * 1000) / 10)) : 0, max, step: POSITION_STEP };
}
export function togglePositionStep(picker) {
  return { ...picker, step: picker.step === 1 ? POSITION_STEP : 1 };
}
export function movePositionPicker(picker, direction) {
  const size = picker.step || POSITION_STEP;
  const step = direction > 0 ? Math.floor(picker.percent / size) + 1
    : direction < 0 ? Math.ceil(picker.percent / size) - 1 : picker.percent / size;
  return { ...picker, percent: Math.max(0, Math.min(picker.max, step * size)) };
}
function boundedLine(text) {
  let result = '';
  for (const character of text || '') {
    if (byteLength(result + character) > 160) { result += '…'; break; }
    result += character;
  }
  return titleText(result || ' ');
}
export function positionPickerText(picker, layout) {
  const tick = Math.round(picker.percent / POSITION_STEP);
  const y = picker.y ?? layout.maxY * picker.percent / 100;
  const context = layout.format === 'pdf'
    ? [`PDF page ${(layout.blocks.findLast(block => block.y <= y) || layout.blocks[0])?.page || 1} of ${layout.headings.length}`, 'Tap to read from here.', ' ']
    : textWindow(layout, y).content.split('\n').slice(0, 3).map(boundedLine);
  while (context.length < 3) context.push(' ');
  return ['Go to position', `${picker.percent}% of document`, ' ',
    `[${'='.repeat(tick)}|${'-'.repeat(20 - tick)}]`, ' ', ...context,
    'Reopen Go to position to cancel'].join('\n');
}
