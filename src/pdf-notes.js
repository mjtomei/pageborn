import { PDF_SCREEN, pdfPageTurn } from './pdf-layout.js';
import { preparePdfNative } from './pdf-native.js';
import { measureNativeText } from './native-text.js';
import { bracketPdfFootnotes } from './pdf-footnote-markers.js';

// Derive compact reading views from the saved preparation without recognizing
// the PDF again. Preserve every crop's source geometry for pixels/bookmarks.
function project(full, blocks) {
  const view = { ...full, blocks: [], blockY: [], lineStarts: [], rows: [], pages: [0] };
  let y = 0;
  for (const source of blocks) {
    const block = { ...source, y }; view.blocks.push(block);
    if (block.reflow) view.lineStarts.push(...block.reflow.rows.map(row => y + row.y));
    else if (block.kind !== 'figure') view.lineStarts.push(...block.lines.map(line => y + Math.max(0, line.y - block.sourceY) * block.scale));
    y += block.drawHeight + 12;
  }
  view.height = Math.max(1, y - 12);
  view.maxY = Math.max(0, view.height - PDF_SCREEN, view.blocks.at(-1)?.y || 0);
  view.blockY = full.headings.map((_, index) => view.blocks.find(b => b.page === index + 1 && !b.annotation)?.y
    ?? view.blocks.find(b => b.page === index + 1)?.y ?? view.maxY);
  view.lineStarts.sort((a, b) => a - b);
  for (let y = 0; y < view.height; y += 27) view.rows.push({ y, height: 27 });
  preparePdfNative(view);
  while (view.pages.at(-1) < view.maxY) view.pages.push(pdfPageTurn(view, view.pages.at(-1), 1));
  if (full.pdf) view.pdf = { draw: (y, height, inverted, options) => full.pdf.draw(y, height, inverted, { ...options, layout: view }),
    drawFigure: (block, options) => full.pdf.drawFigure(block, options) };
  return view;
}

export function pdfReadingViews(full, { measure = text => measureNativeText(text) * 552 / 544 } = {}) {
  const isNote = block => block.annotation?.kind === 'footnote';
  if (!full.blocks.some(isNote)) return { body: full, notes: null };
  const numbers = new Map();
  for (const block of full.blocks.filter(isNote)) if (block.annotation.number) {
    if (!numbers.has(block.page)) numbers.set(block.page, new Set());
    numbers.get(block.page).add(block.annotation.number);
  }
  const blocks = full.blocks.map(block => bracketPdfFootnotes(block, numbers.get(block.page), measure));
  return { body: project(full, blocks.filter(block => !isNote(block))),
    notes: project(full, blocks.filter(isNote)) };
}

export function nearbyPdfNote(body, notes, y) {
  if (!notes?.blocks.length) return 0;
  const source = body.blocks.findLast(block => block.y <= y) || body.blocks[0];
  const candidates = notes.blocks.filter(block => !block.annotationLabel && !block.annotation.continued);
  const samePage = candidates.filter(block => block.page === source?.page);
  // Prefer the last recognizable reference at/before the current source row;
  // otherwise open the first note on this page, then the nearest source page.
  const text = source?.reflow?.rows.filter(row => source.y + row.y <= y).map(row => row.text).join(' ') || '';
  let chosen; let last = -1;
  for (const note of samePage) {
    const number = note.annotation.number;
    if (!number) continue;
    const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundary = /^[a-z]$/i.test(number) ? 'a-zA-Z0-9' : '0-9';
    const matches = [...text.matchAll(new RegExp(`(?:^|[^${boundary}])${escaped}(?![${boundary}])`, 'g'))];
    const at = matches.at(-1)?.index ?? -1;
    if (at > last) { last = at; chosen = note; }
  }
  chosen ||= samePage[0] || candidates.sort((a, b) => Math.abs(a.page - (source?.page || 1)) - Math.abs(b.page - (source?.page || 1)))[0] || notes.blocks[0];
  const index = notes.blocks.indexOf(chosen);
  const label = notes.blocks[index - 1];
  return Math.min(notes.maxY, label?.annotationLabel ? label.y : chosen.y);
}
