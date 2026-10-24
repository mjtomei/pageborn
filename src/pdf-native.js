import { byteLength, TEXT_BYTES, VISIBLE_LINES, LINE_HEIGHT } from './native-text.js';

// Native text and image runs share the PDF's source-mapped coordinates. Stop
// text at every image so paging never skips a figure or renders prose as tiles.
export function preparePdfNative(layout) {
  const runs = []; let run = null;
  for (const block of layout.blocks) {
    if (!block.reflow) { if (run) run.end = block.y; run = null; continue; }
    if (!run) { run = { start: block.y, end: Infinity, rows: [] }; runs.push(run); }
    else run.rows.push({ y: block.y - 6, text: '' });
    let previous;
    for (const row of block.reflow.rows) {
      if (previous && row.y - previous.y > block.reflow.lineHeight + .5) {
        run.rows.push({ y: block.y + previous.y + block.reflow.lineHeight, text: '' });
      }
      run.rows.push({ y: block.y + row.y, text: row.text }); previous = row;
    }
  }
  layout.nativeRuns = runs;
  const last = runs.at(-1);
  if (last?.end === Infinity) {
    // Make the final native lines reachable even when the preview's font fits
    // more lines per screen than the fixed-size glasses font.
    let bytes = 0; let start = last.rows.length;
    while (start > 0 && last.rows.length - start < VISIBLE_LINES) {
      const cost = byteLength(last.rows[start - 1].text) + (start < last.rows.length ? 1 : 0);
      if (bytes + cost > TEXT_BYTES) break;
      bytes += cost; start--;
    }
    layout.maxY = last.rows[start]?.y ?? last.start;
  }
}

export function pdfNativeWindow(layout, y = 0, { lines = VISIBLE_LINES, bottom = false, padding = 0 } = {}) {
  const run = layout?.nativeRuns?.find(r => y >= r.start && y < r.end);
  if (!run) return null;
  const start = Math.max(0, run.rows.findLastIndex(row => row.y <= y));
  let end = start; let bytes = 0;
  while (end < run.rows.length && end - start < Math.min(lines, VISIBLE_LINES - padding)) {
    const cost = byteLength(run.rows[end].text) + (end > start ? 1 : 0);
    const leading = bottom ? VISIBLE_LINES - (end + 1 - start) : padding;
    if (bytes + cost + leading > TEXT_BYTES) break;
    bytes += cost; end++;
  }
  const next = end < run.rows.length ? run.rows[Math.max(start + 1, end)].y : run.end;
  if (bottom) padding = VISIBLE_LINES - (end - start);
  return { content: ('\n'.repeat(padding) + run.rows.slice(start, end).map(row => row.text).join('\n')) || ' ',
    nextY: Math.min(layout.maxY, next), stepY: Math.min(layout.maxY, run.rows[start + 1]?.y ?? run.end),
    start, end, padding };
}

export function pdfImageEnd(layout, y) {
  return layout.nativeRuns?.find(run => run.start > y)?.start ?? Infinity;
}

export function pdfAutoStep(layout, y) {
  return pdfNativeWindow(layout, y)?.stepY ?? Math.min(layout.maxY, y + LINE_HEIGHT, pdfImageEnd(layout, y));
}

export function pdfEntryLines(value) {
  return value != null && Number.isFinite(Number(value)) ? Math.max(1, Math.min(VISIBLE_LINES, Math.round(Number(value)))) : 3;
}

// Keep the source position on the first unread line while the screen fills.
// Reveals are independent display states, even though their y stays the same.
export class PdfAutoscroll {
  constructor(layout, lines) { this.layout = layout; this.initialLines = pdfEntryLines(lines); this.fill = null; }
  reset() { this.fill = null; }
  window(y) {
    const filling = this.fill?.y === y;
    const window = pdfNativeWindow(this.layout, y, filling ? { padding: this.fill.padding } : undefined);
    return window && filling ? { ...window, reveal: `${window.start}:${window.end}:${window.padding}` } : window;
  }
  canFill(y) {
    // A short run between figures still moves up one screen row per tick,
    // including empty rows below it. The first line gets its full reading time.
    // At the document end, stop once all remaining text is visible.
    return this.fill?.y === y && this.fill.padding > 0
      && (y < this.layout.maxY || this.window(y).end < pdfNativeWindow(this.layout, y).end);
  }
  canAdvance(y) { return y < this.layout.maxY || this.canFill(y); }
  step(y) {
    if (this.canFill(y)) { this.fill.padding--; return y; }
    const image = !pdfNativeWindow(this.layout, y);
    const next = pdfAutoStep(this.layout, y);
    this.reset();
    if (image && this.initialLines < VISIBLE_LINES && pdfNativeWindow(this.layout, next)) {
      this.fill = { y: next, padding: pdfNativeWindow(this.layout, next, { lines: this.initialLines, bottom: true }).padding };
    }
    return next;
  }
}
