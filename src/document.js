import { Lexer } from 'marked';

function decode(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (entity[0] !== '#') return named[entity.toLowerCase()] || match;
    const point = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '�';
  });
}
function inline(tokens = []) {
  return tokens.map(token => {
    if (token.type === 'html') return /^<br\s*\/?\s*>$/i.test(token.raw) ? '\n' : '';
    if (token.type === 'br') return '\n';
    if (token.type === 'image') return `[Image: ${decode(token.text || 'image')}]`;
    if (token.tokens) return inline(token.tokens);
    return decode(token.text || token.raw || '');
  }).join('');
}

export function parseDocument(markdown, plainText = false) {
  const source = markdown.replace(/\r\n?/g, '\n');
  const blocks = [];
  const add = (text, kind, sourceLine, extra = {}) => {
    if (text.trim() || kind === 'code') blocks.push({ index: blocks.length, text, kind, sourceLine, ...extra });
  };
  if (plainText) {
    source.split('\n').forEach((text, i) => add(text || ' ', 'code', i + 1));
  } else {
    const walk = (tokens, startLine = 1, prefix = '') => {
      let line = startLine;
      for (const token of tokens) {
        const text = token.tokens ? inline(token.tokens) : decode(token.text || '');
        switch (token.type) {
          case 'heading': add(text, 'heading', line, { level: token.depth }); break;
          case 'paragraph': case 'text': add(prefix + text, 'paragraph', line); break;
          case 'code': add(token.text.replace(/\t/g, '    '), 'code', line + (token.raw.startsWith('```') || token.raw.startsWith('~~~') ? 1 : 0)); break;
          case 'blockquote': walk(token.tokens, line, '> '); break;
          case 'list': {
            let itemLine = line;
            token.items.forEach((item, i) => {
              const bullet = item.task ? (item.checked ? '[x] ' : '[ ] ') : token.ordered ? `${Number(token.start) + i}. ` : '• ';
              const before = blocks.length;
              walk(item.tokens, itemLine, bullet);
              if (blocks.length === before) add(bullet + item.text, 'paragraph', itemLine);
              itemLine += (item.raw.match(/\n/g) || []).length;
            });
            break;
          }
          case 'table': {
            const names = token.header.map((cell, i) => inline(cell.tokens).replace(/\s+/g, ' ').trim() || `Column ${i + 1}`);
            const counts = new Map();
            for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
            const headers = names.map((name, i) => counts.get(name) > 1 ? `${name} (column ${i + 1})` : name);
            add(`Table (${token.rows.length} ${token.rows.length === 1 ? 'row' : 'rows'})`, 'table-caption', line, { table: true });
            // Each record keeps the original Markdown row as its source line.
            // Field breaks below are presentation, not extra source lines.
            const addRecord = (row, i) => {
              let record = '';
              const tableFields = headers.map((header, j) => {
                const value = row ? inline(row[j]?.tokens).split('\n').map(part => part.replace(/\s+/g, ' ').trim()).join('\n').trim() || '(empty)' : '(no rows)';
                const text = `${j === 0 && row ? `[${i + 1}/${token.rows.length}] ` : ''}${header}: ${value}`;
                if (record) record += '\n';
                const offset = record.length; record += text;
                return { text, offset };
              });
              add(record, 'table-record', row ? line + i + 2 : line, { table: true, tableFields });
            };
            if (token.rows.length) token.rows.forEach(addRecord); else addRecord(null, 0);
            break;
          }
          case 'hr': add('────────────', 'rule', line); break;
          // Raw HTML is deliberately excluded; nothing from a document is executed.
        }
        line += (token.raw.match(/\n/g) || []).length;
      }
    };
    walk(Lexer.lex(source, { gfm: true }));
  }
  if (!blocks.length) add('(Empty document)', 'paragraph', 1);
  const headings = blocks.filter(b => b.kind === 'heading' && !b.table);
  return { blocks, headings, sourceLines: source.split('\n').length };
}

export const WIDTH = 576;
export const HEIGHT = 288;
export const BODY_TOP = 0;
export const BODY_HEIGHT = 258;
export const MARGIN = 12;
export function fontFor(kind, size) {
  return kind === 'code' ? `${size - 2}px monospace` : `${['heading', 'table-caption', 'table-row-start'].includes(kind) ? '600 ' : ''}${size}px sans-serif`;
}

// Binary search long words instead of measuring every successively longer prefix.
function splitWord(word, maxWidth, measure) {
  const chars = Array.from(word); const result = [];
  let start = 0;
  while (start < chars.length) {
    let low = 1; let high = 1;
    while (high < chars.length - start && measure(chars.slice(start, start + high).join('')) <= maxWidth) {
      low = high; high = Math.min(chars.length - start, high * 2);
    }
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (measure(chars.slice(start, start + mid).join('')) <= maxWidth) low = mid; else high = mid - 1;
    }
    result.push(chars.slice(start, start + low).join('')); start += low;
  }
  return result;
}
export function wrapText(text, maxWidth, measure, preserveSpace = false) {
  const result = [];
  text.split('\n').forEach((paragraph, sourceOffset) => {
    let line = '';
    const words = preserveSpace ? (paragraph.match(/\s+|\S+/g) || []) : paragraph.trim().split(/\s+/);
    for (const word of words) {
      const joiner = preserveSpace || !line ? '' : ' ';
      if (measure(line + joiner + word) <= maxWidth) { line += joiner + word; continue; }
      if (line) { result.push({ text: line, sourceOffset }); line = ''; }
      const parts = measure(word) > maxWidth ? splitWord(word, maxWidth, measure) : [word];
      for (const part of parts.slice(0, -1)) result.push({ text: part, sourceOffset });
      line = parts.at(-1) || '';
    }
    result.push({ text: line, sourceOffset });
  });
  return result;
}

// Shared by the native glasses layout and the browser/canvas layout. Tables
// use labeled records: no fixed-width grid or off-screen column headers.
export function blockLines(block, maxWidth, measure) {
  if (block.tableFields) {
    return block.tableFields.flatMap((field, i) => {
      let cursor = 0;
      return wrapText(field.text, maxWidth - measure('    '), measure).map((line, j) => {
        const offset = Math.max(cursor, field.text.indexOf(line.text, cursor));
        cursor = offset + line.text.length;
        return { text: (j ? '    ' : i ? '  ' : '') + line.text, offset: field.offset + offset,
          sourceLine: block.sourceLine, table: true, kind: j ? 'table-value' : i ? 'table-field' : 'table-row-start' };
      });
    });
  }
  const text = block.kind === 'code' ? block.text : block.text.replace(/\n/g, ' ');
  let cursor = 0; let sourceOffset = 0; let lastOffset = 0;
  return wrapText(text, maxWidth, measure, block.kind === 'code').map(line => {
    const offset = Math.max(cursor, text.indexOf(line.text, cursor));
    sourceOffset += (block.text.slice(lastOffset, offset).match(/\n/g) || []).length;
    cursor = offset + line.text.length; lastOffset = offset;
    return { text: line.text, offset, sourceLine: block.sourceLine + sourceOffset, kind: block.kind, table: !!block.table };
  });
}

export function layoutDocument(parsed, measure, size = 22) {
  const rows = []; const blockY = []; let y = 0;
  for (const block of parsed.blocks) {
    blockY[block.index] = y;
    const font = fontFor(block.kind, size);
    const rowHeight = size + 7;
    for (const row of blockLines(block, WIDTH - MARGIN * 2, value => measure(value, font))) {
      rows.push({ ...row, y, height: rowHeight, font, block: block.index });
      y += rowHeight;
    }
    y += block.kind === 'heading' ? 10 : 12;
  }
  const rawMax = Math.max(0, y - BODY_HEIGHT);
  const maxY = rawMax ? (rows.find(row => row.y >= rawMax)?.y || rows.at(-1).y) : 0;
  const result = { ...parsed, rows, blockY, height: y, maxY, size, pages: [0] };
  while (result.pages.at(-1) < maxY) {
    const start = result.pages.at(-1);
    let next = start;
    for (let i = rowAt(result, start); i < rows.length && rows[i].y + rows[i].height <= start + BODY_HEIGHT; i++) next = rows[i].y;
    // Reuse the last fully visible row on the next page. Never cut its top.
    result.pages.push(Math.min(maxY, next > start ? next : start + BODY_HEIGHT));
  }
  return result;
}

export function rowAt(layout, position) {
  let low = 0; let high = layout.rows.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (layout.rows[mid].y <= position) low = mid; else high = mid - 1;
  }
  return low;
}
export function anchorAt(layout, position) {
  const row = layout.rows[rowAt(layout, position)];
  const heading = layout.headings.filter(b => layout.blockY[b.index] <= position).at(-1);
  return { text: row.text, sourceLine: row.sourceLine, blockOffset: row.offset, heading: heading?.text || '', offset: position - row.y,
    percent: layout.maxY ? position / layout.maxY * 100 : 0 };
}
export function restoreAnchor(layout, anchor) {
  if (!anchor) return 0;
  const heading = layout.headings.find(h => h.text === anchor.heading);
  const candidates = layout.rows.filter(r => r.text === anchor.text);
  // A paragraph can contain identical wrapped rows on the same source line.
  // Keep its character offset to distinguish them when returning to the file.
  let match = candidates.sort((a, b) => Math.abs(a.sourceLine - anchor.sourceLine) - Math.abs(b.sourceLine - anchor.sourceLine)
    || (Number.isFinite(anchor.blockOffset) ? Math.abs(a.offset - anchor.blockOffset) - Math.abs(b.offset - anchor.blockOffset) : 0))[0];
  if (heading) match = candidates.find(r => r.y >= layout.blockY[heading.index]) || match;
  // Older versions joined all cells into one paragraph. Preserve its source
  // row when upgrading an existing table bookmark to the stacked presentation.
  if (!match) match = layout.rows.find(r => r.table && r.sourceLine === anchor.sourceLine);
  const y = match ? match.y + (Number(anchor.offset) || 0) : heading ? layout.blockY[heading.index] : layout.maxY * (Number(anchor.percent) || 0) / 100;
  return Math.max(0, Math.min(layout.maxY, y));
}
export function searchDocument(parsed, query, limit = 100) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const hits = [];
  for (const block of parsed.blocks) {
    let from = 0; const lower = block.text.toLocaleLowerCase();
    while (hits.length < limit) {
      const at = lower.indexOf(needle, from);
      if (at === -1) break;
      hits.push({ block: block.index, offset: at, sourceLine: block.sourceLine + (block.table ? 0 : (block.text.slice(0, at).match(/\n/g) || []).length),
        text: block.text.slice(Math.max(0, at - 45), at + needle.length + 90) });
      from = at + needle.length;
    }
    if (hits.length === limit) break;
  }
  return hits;
}

export function positionForMatch(layout, hit) {
  const rows = layout.rows.filter(row => row.block === hit.block && row.offset <= hit.offset);
  return rows.at(-1)?.y ?? layout.blockY[hit.block];
}
