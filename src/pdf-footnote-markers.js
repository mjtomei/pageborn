import { pdfTextRows } from './pdf-reflow.js';

const compact = text => text.replace(/[\s\u00ad\u2010-]/gu, '');
const superscripts = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const numberOf = text => [...text].map(char => superscripts.includes(char) ? superscripts.indexOf(char) : char).join('');
const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] || 0;

// Match a real note on this source page AND raised source geometry. Ordinary
// years, counts, equation labels and baseline digits are not references.
function sourceMarkers(block, numbers) {
  const markers = []; let text = '';
  for (const row of pdfTextRows(block.lines)) {
    const add = (start, end, number) => {
      const before = row.text.slice(0, start).trimEnd();
      if (/(?:^|[^\p{L}])\p{L}$/u.test(before) || /\d$/u.test(before)
        || /[=+^∑∫]/u.test(row.text.slice(Math.max(0, start - 3), end + 3))) return;
      if (numbers.has(number) && row.text[start - 1] !== '[' && row.text[end] !== ']') {
        markers.push({ start: text.length + compact(row.text.slice(0, start)).length,
          end: text.length + compact(row.text.slice(0, end)).length, number });
      }
    };
    for (const match of row.text.matchAll(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/gu)) add(match.index, match.index + match[0].length, numberOf(match[0]));
    const items = row.parts.flatMap(part => {
      if (!part.item.words?.length) return [{ ...part.item, start: part.start }];
      let offset = 0;
      return part.item.words.flatMap(word => {
        const at = part.item.text.indexOf(word.text, offset);
        if (at < 0) return [];
        offset = at + word.text.length;
        return [{ ...word, start: part.start + at }];
      });
    });
    const prose = items.filter(item => /\p{L}{2}/u.test(item.text));
    const size = median(prose.map(item => item.height));
    const baseline = median(prose.map(item => item.y + item.height));
    for (const item of items) {
      for (const reference of item.references || []) add(item.start + reference.start, item.start + reference.end, reference.number);
      const value = item.text.trim();
      if (!numbers.has(value) || !size || item.height >= size * .9
        || item.y + item.height >= baseline - size * .12) continue;
      const start = item.start + item.text.indexOf(value);
      add(start, start + value.length, value);
    }
    text += compact(row.text);
  }
  return { text, markers };
}

// Apply a display-only decoration to saved rows. Preparation, original text
// offsets, source boxes and raster crops remain available for old bookmarks.
export function bracketPdfFootnotes(block, numbers, measure) {
  if (!block.reflow || block.reflow.footnoteMarkers) return block;
  const changes = new Map();
  const add = (row, start, end, number) => {
    const spans = changes.get(row) || [];
    if (!spans.some(span => span.start === start)) spans.push({ start, end, text: `[${number}]` });
    changes.set(row, spans);
  };
  const rows = block.reflow.rows;
  if (block.annotation?.kind === 'footnote' && block.annotation.number) {
    const number = block.annotation.number;
    for (const row of rows.filter(row => row.label || block.annotationLabel)) {
      if (row.text.startsWith(`Footnote ${number}`) && !/[\p{L}\d]/u.test(row.text[9 + number.length] || '')) add(row, 9, 9 + number.length, number);
    }
    const first = rows.find(row => !row.label && !block.annotationLabel);
    if (first && !block.annotation.continued) {
      const marker = first.text.match(/^\s*([0-9⁰¹²³⁴⁵⁶⁷⁸⁹]+|[a-z*†‡])([.)]?)(?=\D|$)/u);
      if (marker && numberOf(marker[1]) === number) add(first, first.text.indexOf(marker[1]), marker[0].length, number);
    }
  } else if (numbers?.size && !block.annotation) {
    const source = sourceMarkers(block, numbers);
    const positions = []; let text = '';
    for (const row of rows.filter(row => !row.label)) for (let i = 0; i < row.text.length; i++) {
      if (!compact(row.text[i])) continue;
      text += row.text[i]; positions.push({ row, index: i });
    }
    // Reflow removes whitespace and line-end hyphens. If anything else differs,
    // leave uncertain references alone instead of highlighting the wrong digit.
    if (source.text === text) for (const marker of source.markers) {
      const start = positions[marker.start]; const end = positions[marker.end - 1];
      if (start && end && start.row === end.row) add(start.row, start.index, end.index + 1, marker.number);
    }
  }
  if (!changes.size) return block;
  const wrapped = []; let extra = 0;
  for (const row of rows) {
    const spans = changes.get(row);
    if (!spans) { wrapped.push({ ...row, y: row.y + extra, originalY: row.y }); continue; }
    let text = ''; const offsets = []; let at = 0;
    for (const span of spans.sort((a, b) => a.start - b.start)) {
      while (at < span.start) { offsets.push(at); text += row.text[at++]; }
      text += span.text;
      offsets.push(...[...span.text].map((_, i) => Math.min(span.end - 1, span.start + Math.max(0, i - 1))));
      at = span.end;
    }
    while (at < row.text.length) { offsets.push(at); text += row.text[at++]; }
    offsets.push(row.text.length);
    let start = 0; let count = 0;
    while (start < text.length) {
      let end = start; let space = -1;
      for (const char of text.slice(start)) {
        const next = end + char.length;
        if (end > start && measure(text.slice(start, next), block.reflow.fontSize) > 552) break;
        if (/\s/u.test(char)) space = end;
        end = next;
      }
      if (end < text.length && space > start) end = space;
      // Keep a marker intact even after a long unbroken word reaches the edge.
      const open = text.lastIndexOf('[', end - 1);
      const close = open >= start ? text.indexOf(']', open) : -1;
      if (open >= start && close >= end && /^\[[0-9a-z*†‡]+\]$/u.test(text.slice(open, close + 1))) end = open > start ? open : close + 1;
      wrapped.push({ ...row, text: text.slice(start, end).trimEnd(), y: row.y + extra + count * block.reflow.lineHeight,
        start: row.start < 0 ? row.start : row.start + offsets[start],
        end: end === text.length ? row.end : row.start + offsets[end], originalY: row.y });
      count++; start = end;
      while (/\s/u.test(text[start] || '') && start < text.length) start++;
    }
    extra += (count - 1) * block.reflow.lineHeight;
  }
  return { ...block, drawHeight: block.drawHeight + extra,
    lines: block.lines.map(line => ({ ...line, displayY: wrapped.find(row => row.originalY === line.displayY)?.y ?? line.displayY })),
    reflow: { ...block.reflow, footnoteMarkers: true, nativeWrap: 3, height: block.reflow.height + extra,
      rows: wrapped.map(({ originalY, ...row }) => row) } };
}
