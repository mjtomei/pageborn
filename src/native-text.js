import { getTextWidth, pxTruncate } from '@evenrealities/pretext';
import { blockLines, rowAt, WIDTH, BODY_HEIGHT, MARGIN } from './document.js';

export const LINE_HEIGHT = 27;
export const VISIBLE_LINES = Math.floor(BODY_HEIGHT / LINE_HEIGHT);
// Simulator 0.9.5 rejects >= 1000 UTF-8 bytes, including text upgrades.
export const TEXT_BYTES = 900;
const encoder = new TextEncoder();
export const byteLength = text => encoder.encode(text).length;
export const measureNativeText = value => Math.max(getTextWidth(value), byteLength(value) * 8);
export function pageOverlap(value) {
  const lines = value == null ? 1 : Number(value);
  return Number.isFinite(lines) ? Math.max(0, Math.min(VISIBLE_LINES - 1, Math.trunc(lines))) : 1;
}
export function titleText(text, width = WIDTH - MARGIN * 2) {
  // Missing font glyphs can measure as zero width. Bound bytes independently.
  let title = ''; let bytes = 0;
  for (const character of text || 'Pageborne') {
    bytes += byteLength(character);
    if (bytes > 800) break;
    title += character;
  }
  return pxTruncate(title, width);
}

export function nativeLayout(parsed, overlapLines = 0, { width = WIDTH - 2 * MARGIN - 8 } = {}) {
  const rows = []; const blockY = [];
  for (const block of parsed.blocks) {
    blockY[block.index] = rows.length * LINE_HEIGHT;
    // Reserve pixels for firmware discrepancies, and bound missing glyphs too.
    for (const line of blockLines(block, width, measureNativeText)) {
      rows.push({ ...line, y: rows.length * LINE_HEIGHT, height: LINE_HEIGHT, font: '22px sans-serif', block: block.index });
    }
    if (block.index < parsed.blocks.length - 1) rows.push({ text: '', y: rows.length * LINE_HEIGHT,
      height: LINE_HEIGHT, font: '22px sans-serif', block: block.index, offset: block.text.length,
      sourceLine: rows.at(-1).sourceLine, kind: 'space' });
  }
  const layout = { ...parsed, rows, blockY, height: rows.length * LINE_HEIGHT, size: 22,
    maxY: Math.max(0, rows.length - VISIBLE_LINES) * LINE_HEIGHT, pages: [0] };
  setPageOverlap(layout, overlapLines);
  return layout;
}

export function setPageOverlap(layout, lines) {
  layout.pageOverlap = pageOverlap(lines);
  layout.pages = [0];
  while (layout.pages.at(-1) < layout.maxY) {
    layout.pages.push(textWindow(layout, layout.pages.at(-1), 'page').nextY);
  }
}

// Turn from the currently displayed row, including after a phone jump. Snapping
// to the next global page boundary can advance only one row after such a jump.
export function pageTurnY(layout, y, direction) {
  const page = textWindow(layout, y, 'page');
  return direction > 0 ? page.nextY : page.previousY;
}

export function textWindow(layout, y = 0) {
  if (!layout) return { start: 0, end: 0, content: 'Add files on your phone.\nChoose a document to start reading.', nextY: 0, previousY: 0 };
  const start = rowAt(layout, y);
  const limit = VISIBLE_LINES;
  const lines = []; let end = start; let size = 0;
  while (end < layout.rows.length && lines.length < limit) {
    const text = layout.rows[end].text;
    const cost = byteLength(text) + (lines.length ? 1 : 0);
    if (size + cost > TEXT_BYTES) break;
    lines.push(text); size += cost; end++;
  }
  const overlap = pageOverlap(layout.pageOverlap);
  return { start, end, content: lines.join('\n') || ' ',
    nextY: Math.min(layout.maxY, Math.max(start + 1, end - overlap) * LINE_HEIGHT),
    previousY: Math.max(0, start - Math.max(1, end - start - overlap)) * LINE_HEIGHT };
}
