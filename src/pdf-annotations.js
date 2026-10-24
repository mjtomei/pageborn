import { pdfTextRows, reflowPdfBlock } from './pdf-reflow.js';
import { pdfCaptionReference as caption, splitPdfCaptionColumns, associatePdfCaptions } from './pdf-captions.js';

const bottom = b => b.y + b.height;
const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] || 0;
const sizeOf = block => median(block.lines.filter(t => t.text.trim().length > 1).map(t => t.height)) || median(block.lines.map(t => t.height));
const overlapsX = (a, b) => Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > Math.min(a.width, b.width) * .4;
function hasNoteRule(block, pixels, width, bodySize) {
  if (!pixels || !width) return false;
  for (let y = Math.max(0, Math.floor(block.y - bodySize * 1.5)); y < Math.min(block.y + bodySize * .4, pixels.length / 4 / width); y++) {
    let run = 0;
    for (let x = Math.max(0, Math.floor(block.x)); x < Math.min(width, block.x + block.width); x++) {
      const at = (y * width + x) * 4;
      run = pixels[at] < 180 && pixels[at + 1] < 180 && pixels[at + 2] < 180 ? run + 1 : 0;
      if (run > block.width * .25) return true;
    }
  }
  return false;
}
function noteNumber(row, style = 'numeric') {
  if (row.items[0]?.noteMarker) return row.items[0].noteMarker;
  const marker = style === 'letters' ? /^([a-z][.)]?|[*†‡])\s+(?=[A-Z0-9])/ : /^(\d{1,3}[.)]|[*†‡])\s+(?=\S)/;
  const explicit = row.text.trim().match(marker)?.[1];
  if (explicit) return explicit.replace(/[.)]$/, '');
  const first = row.items[0]; const rest = row.items.slice(1);
  // Superscript markers often have no separating space ("1https://...").
  // An ordinary citation volume at the start of a line is not a note marker.
  if ((style === 'letters' ? /^[a-z]$/ : /^\d{1,3}$/).test(first?.text.trim()) && rest.length
    && (first.height < median(rest.map(t => t.height)) * .88
      || first.y + first.height < median(rest.map(t => t.y + t.height)) - first.height * .3)) return first.text.trim();
  const words = first?.words;
  if (words?.length > 1 && /^\d{1,3}[.)]?$/.test(words[0].text || '')
    && (words[0].height < median(words.slice(1).map(w => w.height)) * .88
      || /^[0-9]+[.)]$/.test(words[0].text))) return words[0].text.replace(/[.)]$/, '');
  return null;
}

export function pdfFootnoteStyle(pages, bodySize) {
  let letters = 0; let numbers = 0;
  for (const page of pages) {
    const text = page.text || page.blocks.flatMap(b => b.lines);
    for (const row of pdfTextRows(text.filter(t => t.y > page.height * .3 && t.height < bodySize * .9))) {
      if (noteNumber(row, 'letters')) letters++;
      if (noteNumber(row)) numbers++;
    }
  }
  return letters >= 3 && letters > numbers ? 'letters' : 'numeric';
}

// Body text is usually the larger sustained prose size. Use a weighted upper
// quantile so a page/article with unusually long footnotes doesn't define the
// smaller note font as the body font. Short headings and superscripts abstain.
export function pdfBodySize(pages) {
  const samples = pages.flatMap(page => page.text || page.blocks.filter(b => b.kind === 'text').flatMap(b => b.lines))
    .filter(t => t.text.trim().length >= 3 && /[A-Za-z]{3}/.test(t.text) && t.width > t.height * 1.5 && t.height > 0)
    .sort((a, b) => a.height - b.height);
  const target = samples.reduce((n, t) => n + t.text.length, 0) * .7;
  let count = 0;
  return samples.find(t => (count += t.text.length) >= target)?.height || 0;
}

function sliceBlock(block, rows, top, low) {
  return { ...block, y: top, height: low - top, ...(block.figureBounds ? { figureBounds: block.figureBounds.filter(b => b.y < low && bottom(b) > top) } : {}), lines: rows.flatMap(row => row.items),
    text: rows.map(row => row.text).join(' ') };
}

const endMatterTitle = text => /^(?:(?:supplementarymaterials?)?references(?:andnotes)?|bibliography|endnotes|notes)$/i.test(text.replace(/\s/g, ''));
export function pdfEndMatterStart(page) {
  return Math.min(Infinity, ...page.blocks.flatMap(block => [...block.lines, ...pdfTextRows(block.lines)]
    .filter(row => endMatterTitle(row.text)).map(row => row.y)));
}

export function separatePdfAnnotations(page, { bodySize = 0, endMatter = false, noteStyle = 'numeric', ...reflowOptions } = {}) {
  bodySize ||= pdfBodySize([page]);
  if (!bodySize) return page.blocks;
  const notesEnd = endMatter ? 0 : pdfEndMatterStart(page);
  let blocks = [];
  for (const block of page.blocks.flatMap(block => splitPdfCaptionColumns(block, reflowOptions.pixels, reflowOptions.pageWidth))) {
    const rows = pdfTextRows(block.lines);
    // A heading can touch its following paragraph in the pixel crop. Split
    // only a standalone title row, with body text below it in the same column.
    if (block.kind === 'text' && rows.length > 1 && rows[0].text.length < 120
      && /^(?:(?:\d+(?:\.\d+)*\.?|[IVXLCDM]+[.)])\s+[A-Z][^.!?]*|[A-Z][A-Z\s:–—-]{2,}|Abstract|References|Bibliography)$/.test(rows[0].text.trim())
      && rows[0].text.split(/\s+/).length <= 14 && !rows[0].gaps.some(gap => gap > bodySize*2.5)
      && rows.slice(1).some(row => /[a-z]{3}/.test(row.text))) {
      const low = Math.min(rows[1].y-1, rows[0].y+Math.max(...rows[0].items.map(t=>t.height))+2);
      if (low > rows[0].y && low < bottom(block)) {
        blocks.push(sliceBlock(block,rows.slice(0,1),block.y,low),sliceBlock(block,rows.slice(1),low,bottom(block)));
        continue;
      }
    }
    // Separate neighboring objects before detaching either caption. Otherwise
    // a table below a plot can be mistaken for the plot's long caption.
    const starts = rows.flatMap((row, i) => caption(row.text) ? [i] : []);
    if (block.kind === 'figure' && starts.length >= 2) {
      const cut = Math.min(...(block.figureBounds || []).filter(b => b.y > rows[starts[0]].y
        && b.y < rows[starts[1]].y).map(b => b.y));
      if (Number.isFinite(cut) && cut > block.y && cut < bottom(block)) {
        const split = rows.findIndex(row => row.y >= cut);
        if (split > 0) {
          const head = sliceBlock(block, rows.slice(0, split), block.y, cut);
          if (!head.figureBounds?.some(b => b.y < rows[starts[0]].y)) { head.kind = 'text'; delete head.figureBounds; }
          const tail = sliceBlock(block, rows.slice(split), cut, bottom(block));
          blocks.push(...separatePdfAnnotations({ ...page, blocks: [head, tail] }, { bodySize, endMatter, noteStyle, ...reflowOptions }));
          continue;
        }
      }
    }
    // Panel labels may precede a caption in the same text band.
    if (block.kind === 'text' && starts[0] > 0) {
      const i = starts[0]; const cut = rows[i].y - 2;
      blocks.push(sliceBlock(block, rows.slice(0, i), block.y, cut), sliceBlock(block, rows.slice(i), cut, bottom(block)));
      continue;
    }
    // A caption can share a pixel crop with its figure. Detach only a bottom
    // band whose ink can actually be accounted for by the caption text.
    const start = block.kind === 'figure' ? rows.findIndex(row => caption(row.text)) : -1;
    if (start >= 0 && rows[start].y > block.y + bodySize * 2
      && !(block.figureBounds || []).some(b => bottom(b) > rows[start].y + bodySize && b.y < bottom(block))) {
      const top = Math.max(block.y, rows[start].y - Math.max(3, sizeOf(block) * .25));
      const tail = { ...sliceBlock(block, rows.slice(start), top, bottom(block)), kind: 'text' };
      if (reflowPdfBlock(tail, reflowOptions)) {
        blocks.push({ ...sliceBlock(block, rows.slice(0, start), block.y, top), captionId: caption(rows[start].text) }, tail);
        continue;
      }
    }
    // Tables often put their caption above the grid. Stop at the first row
    // of separated cells (or a substantial gap), and verify the caption's
    // pixels before detaching it from the table image.
    if (start === 0) {
      const end = rows.findIndex((row, i) => i > 0 && (row.gaps.some(gap => gap > bodySize * 2)
        || row.gaps.filter(gap => gap > bodySize * .8).length >= 2
        || row.y - rows[i - 1].y > bodySize * 2));
      if (end > 0) {
        const low = Math.min(rows[end].y - 3, bottom({ y: rows[end - 1].y,
          height: Math.max(...rows[end - 1].items.map(t => t.height)) }) + 2);
        const head = { ...sliceBlock(block, rows.slice(0, end), block.y, low), kind: 'text' };
        if (reflowPdfBlock(head, reflowOptions)) {
          blocks.push(head, ...separatePdfAnnotations({ ...page, blocks: [{ ...sliceBlock(block, rows.slice(end), low, bottom(block)), captionId: caption(rows[0].text) }] }, { bodySize, endMatter, noteStyle, ...reflowOptions }));
          continue;
        }
      }
    }
    // Recover prose after an image too. A narrow paragraph gap can join an
    // entire body section onto a chart, shrinking it badly in the gallery.
    if (block.kind === 'figure' && rows.length >= 2) {
      const imageBottom = Math.max(...(block.figureBounds || []).map(bottom));
      const start = rows.findIndex(row => row.y >= imageBottom + 1);
      if (Number.isFinite(imageBottom) && start >= 0 && rows.length - start >= 2) {
        const top = Math.max(imageBottom + 1, rows[start].y - 3);
        const tail = { ...sliceBlock(block, rows.slice(start), top, bottom(block)), kind: 'text' };
        if (tail.text.length >= 100 && reflowPdfBlock(tail, reflowOptions)) {
          const head = sliceBlock(block, rows.slice(0, start), block.y, top);
          blocks.push(...separatePdfAnnotations({ ...page, blocks: [head, tail] }, { bodySize, endMatter, noteStyle, ...reflowOptions }));
          continue;
        }
      }
    }
    // A plot can touch the paragraph immediately above it and inherit that
    // paragraph's crop. Recover sustained prose only when its entire band is
    // explained by text pixels; plot labels and table rows remain attached.
    if (block.kind === 'figure' && rows.length >= 4) {
      const imageTop = Math.min(...(block.figureBounds || []).map(b=>b.y));
      const boundary = Number.isFinite(imageTop) ? rows.findIndex(row => row.y+Math.max(...row.items.map(t=>t.height)) > imageTop) : -1;
      const end = boundary === -1 && Number.isFinite(imageTop) ? rows.length
        : boundary > 0 ? boundary : rows.findIndex((row, i) => i > 0 && row.y - rows[i - 1].y > bodySize * 1.8);
      if (end >= 2) {
        const low = Math.min((rows[end]?.y ?? imageTop) - 3, rows[end - 1].y + Math.max(...rows[end - 1].items.map(t => t.height)) + 3);
        const head = { ...sliceBlock(block, rows.slice(0, end), block.y, low), kind: 'text' };
        if (head.text.length >= 100 && reflowPdfBlock(head, reflowOptions)) {
          blocks.push(...separatePdfAnnotations({ ...page, blocks: [head, sliceBlock(block, rows.slice(end), low, bottom(block))] }, { bodySize, endMatter, noteStyle, ...reflowOptions }));
          continue;
        }
      }
    }
    // Dense PDFs sometimes put body and small-print notes in a single crop.
    // Split only a sustained smaller tail low on the page, never an isolated
    // superscript, an equation, or a small phrase in the middle of a paragraph.
    if (block.kind === 'text' && block.y < notesEnd && rows.length >= 4) {
      const rowSize = row => median(row.items.filter(t => t.text.length > 1).map(t => t.height));
      const start = rows.findIndex((row, i) => i > 0 && row.y > page.height * .3 && rowSize(row) < bodySize * .87
        && rowSize(rows[i - 1]) >= bodySize * .92 && rows.slice(i).every(r => rowSize(r) < bodySize * .9));
      if (start > 0 && (rows.length - start >= 2 || rows[start].items.some(t=>t.noteMarkerRaised)) && bottom(block) > page.height * .75) {
        const top = Math.max(bottom({ y: rows[start - 1].y, height: rowSize(rows[start - 1]) }), rows[start].y - 3);
        blocks.push(sliceBlock(block, rows.slice(0, start), block.y, top), sliceBlock(block, rows.slice(start), top, bottom(block)));
        continue;
      }
    }
    blocks.push(block);
  }
  for (const block of blocks) {
    if (block.kind !== 'text' || !block.lines.length) continue;
    const id = caption(pdfTextRows(block.lines)[0]?.text || '');
    if (id) {
      block.annotation = { kind: 'caption', reference: id };
    }
  }
  const small = block => block.kind === 'text' && !block.annotation
    && sizeOf(block) < bodySize * (block.lines.filter(line => line.noteMarker).length >= 2 ? .96 : .87) && block.y > page.height * .3;
  const footnotes = blocks.filter(block => small(block)
    && bottom(block) < notesEnd
    // Scanned glyph heights vary too much to infer footnotes from font size.
    // Preserve uncertain OCR in its original order rather than moving prose.
    && (block.lines.every(line => line.confidence == null) || block.lines.some(line => line.noteMarker)
      // A note continued from the preceding page has no repeated number.
      // A separating rule supplies the local evidence; pdfSectionOrder still
      // requires a preceding numbered footnote before retaining an unnumbered
      // candidate as a note. Unattached candidates stay in the body.
      || block.lines.every(line => line.confidence >= 65) && hasNoteRule(block, reflowOptions.pixels, reflowOptions.pageWidth, bodySize))
    && (!/[{}]|<\/?\w|\\n/.test(block.text) || block.lines.some(line=>line.noteMarkerRaised))
    && blocks.some(b => b.kind === 'text' && !small(b) && !b.annotation && b.text.length > 100
      && overlapsX(block, b) && b.y < block.y)
    && !blocks.some(b => b.kind === 'text' && !small(b) && !b.annotation && b.text.length > 100
      && overlapsX(block, b) && b.y > block.y)
    && blocks.some(b => small(b) && overlapsX(block, b) && bottom(b) >= page.height * .75)
    && (() => {
      const markers = pdfTextRows(block.lines).filter(row => noteNumber(row, noteStyle));
      // A compact numbered bibliography at the end of the body is not a
      // footnote band. True dense notes retain their separating rule.
      return markers.length < 6 || block.text.length / markers.length >= 300 || block.lines.some(line=>line.noteMarkerRaised)
        || hasNoteRule(block, reflowOptions.pixels, reflowOptions.pageWidth, bodySize);
    })());
  blocks = blocks.flatMap(block => {
    if (!footnotes.includes(block)) return [block];
    const rows = pdfTextRows(block.lines); const groups = [];
    for (const row of rows) {
      const number = noteNumber(row, noteStyle);
      // A citation year or an indented quotation is not another footnote.
      if (!groups.length || number && row.items[0].x <= block.x + bodySize * 3) groups.push({ number, rows: [] });
      groups.at(-1).rows.push(row);
    }
    return groups.map((group, index) => {
      const top = index ? Math.max(block.y, group.rows[0].y - 3) : block.y;
      const low = groups[index + 1] ? Math.max(top + 1, groups[index + 1].rows[0].y - 3) : bottom(block);
      return { ...sliceBlock(block, group.rows, top, low), annotation: { kind: 'footnote', number: group.number || null } };
    });
  });
  return blocks;
}

export function pdfSectionTitle(block, bodySize) {
  if (block.annotation || block.kind !== 'text' || !block.reflow || block.lines.length === 0) return null;
  const rows = pdfTextRows(block.lines); const text = rows.map(row => row.text).join(' ').trim();
  if (rows.length > 3 || text.length > 130 || !text || /[=∑∫]/.test(text)) return null;
  if (/^[IVXLCDM]{1,8}\.?$/.test(text)) return `Section ${text.replace(/\.$/, '')}`;
  const letters = text.replace(/[^a-zA-Z]/g, '');
  const upper = letters.replace(/[^A-Z]/g, '').length / (letters.length || 1);
  const numbered = /^(?:[A-Z]\.\d+(?:\.\d+)*\.?|\d+(?:\.\d+)*\.?|[A-Z]|[IVXLCDM]+[.)])\s+[A-Z]/.test(text);
  if (letters.length >= 3 && ((upper >= .8 && sizeOf(block) >= bodySize * .8)
    || numbered && sizeOf(block) >= bodySize * .95)) return text;
  return null;
}

// Retain source page/geometry even when reading order changes. Resolve notes
// against references before emitting sections, since a note on the page where
// a new section starts can still belong to the previous section.
export function pdfSectionOrder(pages) {
  const captionOwners = associatePdfCaptions(pages);
  const attached = new Map();
  // Bibliographies and explicit endnotes already have their own reading
  // order. Their smaller numbered entries must not become page footnotes.
  let endMatter = false; let previousNote;
  for (const page of pages) for (const block of page.blocks) {
    if (Number.isFinite(pdfEndMatterStart({ blocks: [block] }))) endMatter = true;
    if (endMatter && block.annotation?.kind === 'footnote') delete block.annotation;
    if (block.annotation?.kind !== 'footnote') continue;
    if (!block.annotation.number && !(previousNote?.number && page.number <= previousNote.page + 1)) delete block.annotation;
    else previousNote = { number: block.annotation.number || previousNote.number, page: page.number };
  }
  const bodySize = pdfBodySize(pages); const sections = [{ title: 'Opening', body: [], notes: [] }];
  const entries = []; let section = 0;
  for (const page of pages) for (const block of page.blocks) {
    const title = pdfSectionTitle(block, bodySize);
    if (title) { sections.push({ title, body: [], notes: [] }); section++; }
    const entry = { page: page.number, block, section };
    entries.push(entry);
    if (!block.annotation || block.annotation.kind === 'caption' && !captionOwners.has(block)) sections[section].body.push(entry);
  }
  let lastFootnote;
  for (const entry of entries.filter(entry => entry.block.annotation)) {
    const note = entry.block.annotation; const samePage = entries.filter(e => e.page === entry.page && !e.block.annotation);
    let owner;
    if (note.kind === 'footnote') {
      if (note.number) {
        const escaped = note.number === '*' ? '\\*' : note.number;
        const boundary = /^[a-z]$/.test(note.number) ? 'a-zA-Z0-9' : '0-9';
        const reference = new RegExp(`(?:^|[^${boundary}])${escaped}(?![${boundary}])`);
        owner = samePage.findLast(e => e.block.kind === 'text' && e.block.text.length > 100 && reference.test(e.block.text));
      } else if (lastFootnote && entry.page <= lastFootnote.page + 1) {
        owner = lastFootnote; note.number = lastFootnote.block.annotation.number; note.continued = true;
      }
      entry.section = owner?.section ?? entry.section;
      lastFootnote = entry;
    } else {
      owner = entries.find(e => e.block === captionOwners.get(entry.block));
      entry.section = owner?.section ?? entry.section;
    }
    note.section = sections[entry.section].title;
    note.label = `${note.kind === 'caption' ? `${note.reference} caption` : `Footnote${note.number ? ` ${note.number}` : ''}${note.continued ? ' (continued)' : ''}`} — PDF page ${entry.page}`;
    if (note.kind === 'caption') {
      if (owner) attached.set(owner.block, entry);
    } else sections[entry.section].notes.push(entry);
  }
  return sections.flatMap(group => [...group.body.flatMap(entry => attached.has(entry.block) ? [entry, attached.get(entry.block)] : [entry]), ...group.notes]);
}

export function labelPdfAnnotation(block, measure, fontSize = 20) {
  const label = block.annotation?.label;
  if (!label) return block;
  const lineHeight = block.reflow?.lineHeight || Math.ceil(fontSize * 1.25); const rows = []; let text = '';
  for (const word of label.split(' ')) {
    const next = text ? `${text} ${word}` : word;
    if (text && measure(next) > 552) { rows.push(text); text = word; } else text = next;
  }
  if (text) rows.push(text);
  const gap = Math.ceil(lineHeight * .4); const offset = rows.length * lineHeight + gap;
  const labelRows = rows.map((text, i) => ({ text, y: i * lineHeight, start: -1, end: -1, sourceY: block.y, items: [], label: true }));
  if (!block.reflow) return { ...block, kind: 'text', annotationLabel: true, lines: [], text: label,
    reflow: { nativeWrap: 2, fontSize, lineHeight, height: offset, text: label, rows: labelRows } };
  return { ...block, reflow: { ...block.reflow, nativeWrap: 2, height: block.reflow.height + offset,
    rows: [...labelRows,
      ...block.reflow.rows.map(row => ({ ...row, y: row.y + offset }))] } };
}
