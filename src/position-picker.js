import { byteLength, titleText, textWindow } from './native-text.js';
import { documentContents } from './document-contents.js';

export function openNavigationPicker(layout, y) {
  const entries = documentContents(layout);
  if (!entries.length) return openPositionPicker(layout, y);
  let index = entries.findLastIndex(entry => entry.y <= y + .5);
  return { kind: 'contents', entries, index: Math.max(0, index) };
}
export function refreshNavigationPicker(picker, layout) {
  if (picker?.kind !== 'contents') return picker;
  const current = picker.entries[picker.index], entries = documentContents(layout);
  if (!entries.length) return openPositionPicker(layout, current?.y || 0);
  const index = entries.findIndex(entry => entry.title === current?.title && entry.page === current?.page);
  return { ...picker, entries, index: index < 0 ? Math.min(picker.index, entries.length - 1) : index };
}

export const POSITION_STEP = 5;
export function openPositionPicker(layout, y) {
  const max = layout.maxY > 0 ? 100 : 0;
  return { percent: max ? Math.max(0, Math.min(100, Math.round(y / layout.maxY * 1000) / 10)) : 0, max, step: POSITION_STEP };
}
export function togglePositionStep(picker) {
  if (picker.kind === 'contents') return picker;
  return { ...picker, step: picker.step === 1 ? POSITION_STEP : 1 };
}
export function movePositionPicker(picker, direction) {
  if (picker.kind === 'contents') return { ...picker, index: Math.max(0, Math.min(picker.entries.length - 1, picker.index + Math.sign(direction))) };
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
  if (picker.kind === 'contents') {
    const entry = picker.entries[picker.index];
    const start = Math.max(0, Math.min(picker.index - 2, picker.entries.length - 5));
    const lines = picker.entries.slice(start, start + 5).map((item, i) => boundedLine(
      `${start + i === picker.index ? '> ' : '  '}${'  '.repeat(item.level - 1)}${item.title}`));
    while (lines.length < 5) lines.push(' ');
    return ['Contents', `${picker.index + 1} of ${picker.entries.length}${entry.page ? ` · PDF page ${entry.page}` : ''}`, ' ', ...lines,
      layout.preparation?.complete === false ? 'Ready sections · more loading' : 'Double tap to go back'].join('\n');
  }
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
