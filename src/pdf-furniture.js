// Detect running text across pages, before cropping or reflow. Restrict matches
// to the page edges: a phrase repeated in the body is still document content.
import { pdfTextRows } from './pdf-reflow.js';
const bottom = box => box.y + box.height;
const signature = text => text.toLocaleLowerCase().replace(/[\u0000-\u001f]/g, '')
  .replace(/\d+/g, '#').replace(/[^\p{L}#]/gu, '');

function edgeRows(page) {
  const rows = [];
  for (const box of [...page.text].sort((a, b) => a.y - b.y || a.x - b.x)) {
    if (!box.text.trim() || box.height <= 0 || box.height > page.height * .04) continue;
    const cy = (box.y + box.height / 2) / page.height;
    if (cy > .12 && cy < .88) continue;
    const row = rows.findLast(r => Math.abs(r.cy - cy) * page.height < Math.min(r.height, box.height) * .5);
    if (row) { row.parts.push(box); row.height = Math.max(row.height, box.height); }
    else rows.push({ cy, height: box.height, parts: [box] });
  }
  return rows.map(row => {
    row.parts.sort((a, b) => a.x - b.x);
    return { ...row, signature: signature(row.parts.map(t => t.text).join(' ')) };
  });
}

function rowMask(page, row) {
  const first = Math.min(...row.parts.map(t => t.y)), last = Math.max(...row.parts.map(bottom));
  const padding = Math.max(4, Math.min(12, row.height * .75));
  let top = Math.max(0, first - padding), low = Math.min(page.height, last + padding);
  // Clear scanned glyphs outside their OCR boxes, bounded by adjacent prose.
  for (const other of page.text) {
    if (row.parts.includes(other)) continue;
    if (bottom(other) <= first) top = Math.max(top, bottom(other));
    else if (other.y >= last) low = Math.min(low, other.y);
  }
  return low > top ? { x: 0, y: top, width: page.width, height: low - top } : null;
}

function numberedHead(row, page) {
  const words = row.parts.flatMap(part => part.words?.length ? part.words : [part]).sort((a, b) => a.x - b.x);
  const first = words[0], last = words.at(-1);
  const leading = /^\d{1,5}$/.test(first?.text.trim()), trailing = /^\d{1,5}$/.test(last?.text.trim());
  if (words.length < 2 || leading === trailing) return null;
  const folio = leading ? first : last, title = leading ? words.slice(1) : words.slice(0, -1);
  const gap = leading ? title[0].x - folio.x - folio.width : folio.x - lastRight(title);
  const label = title.map(word => word.text).join(' ').trim();
  // A detached folio at the page edge is stronger evidence than a heading
  // like “4. Results”. Never classify a numbered section by its string alone.
  if (gap < Math.max(row.height * 3, page.width * .04) || folio.width > page.width * .12
    || !/^[\p{L}\s,'’:&–—-]+$/u.test(label) || (label.match(/\p{L}+/gu) || []).length < 2
    || label.length < 8 || label.length > 100) return null;
  const body = page.text.filter(box => box.y > page.height * .12 && bottom(box) < page.height * .88
    && box.text.length > 35 && box.width > page.width * .35 && box.height > 0 && box.height < page.height * .04);
  const sizes = body.map(box => box.height).sort((a, b) => a - b);
  if (body.length < 3 || row.height > sizes[Math.floor(sizes.length / 2)] * 1.25) return null;
  return signature(label);
}

function lastRight(boxes) { return Math.max(...boxes.map(box => box.x + box.width)); }

export function repeatedPdfTextMasks(pages) {
  const masks = pages.map(() => []);
  const rows = pages.map(edgeRows);
  const hidden = pages.map(() => new Set());
  const hide = (index, row) => {
    if (hidden[index].has(row)) return;
    const mask = rowMask(pages[index], row);
    if (mask) { masks[index].push(mask); hidden[index].add(row); }
  };
  // Partial preparation may have only a chapter opener and its first running
  // head. Match that already-read title (or an alternating numbered head),
  // without waiting for many more OCR pages. Only the numbered edge row is
  // removed; the real chapter title remains in the reading stream.
  const titles = new Map();
  for (const [index, page] of pages.entries()) {
    const add = (key, height) => {
      if (!key) return;
      const entries = titles.get(key) || []; entries.push({ index, height }); titles.set(key, entries);
    };
    for (const row of rows[index]) add(numberedHead(row, page), row.height / page.height);
    for (const row of pdfTextRows(page.text.filter(box => box.y >= page.height * .12 && bottom(box) < page.height * .5))) {
      if (row.text.length < 8 || row.text.length > 100 || !/^[\p{L}\s,'’:&–—-]+$/u.test(row.text)) continue;
      add(signature(row.text), Math.max(...row.items.map(item => item.height)) / page.height);
    }
  }
  for (const [index, pageRows] of rows.entries()) for (const row of pageRows) {
    const key = numberedHead(row, pages[index]);
    if (key && titles.get(key)?.some(other => other.index !== index && other.height >= row.height / pages[index].height * .8)) hide(index, row);
  }
  if (pages.length < 3) return masks;
  const groups = [];
  for (const [index, pageRows] of rows.entries()) for (const row of pageRows) {
    if (!row.signature) continue;
    let group = groups.find(g => g.signature === row.signature && Math.abs(g.cy - row.cy) < .035);
    if (!group) { group = { signature: row.signature, cy: row.cy, pages: new Set(), rows: [] }; groups.push(group); }
    group.pages.add(index); group.rows.push({ index, row });
  }
  // Allow alternating recto/verso headers, but require multiple different pages.
  const minimum = Math.max(2, Math.min(6, Math.ceil(pages.length * .3)));
  for (const group of groups) {
    if (group.pages.size < minimum) continue;
    for (const { index, row } of group.rows) hide(index, row);
  }
  // Manuscript repositories print a vertical status watermark in a narrow
  // outside lane. It is not a short horizontal running head, and leaving its
  // letters/rule behind can create dozens of spurious image fragments.
  const sideMarks = pages.map(page => page.text.filter(box => box.height > box.width * 3
    && box.width < page.width * .04 && (box.x + box.width < page.width * .12 || box.x > page.width * .88)
    && /^(?:author|accepted)\s+manuscript$/i.test(box.text.trim())));
  for (const [index, marks] of sideMarks.entries()) for (const mark of marks) {
    const page = pages[index];
    if (sideMarks.filter((others, n) => others.some(other => signature(other.text) === signature(mark.text)
      && Math.abs(other.x / pages[n].width - mark.x / page.width) < .015)).length < minimum) continue;
    const pad = Math.min(12, mark.width * .5);
    const x = Math.max(0, mark.x - pad), right = Math.min(page.width, mark.x + mark.width + pad);
    // Protect any other source text entering the lane, even on a cover page.
    const protectedText = page.text.filter(t => !marks.includes(t) && t.x < right && t.x + t.width > x);
    const bands = protectedText.map(t => [Math.max(0, t.y - 2), Math.min(page.height, bottom(t) + 2)]).sort((a,b) => a[0]-b[0]);
    let top = 0;
    for (const [start, end] of [...bands, [page.height, page.height]]) {
      if (start > top) masks[index].push({ x, y: top, width: right - x, height: start - top });
      top = Math.max(top, end);
    }
    break; // All copies in this lane are cleared together.
  }
  return masks;
}

// First-page folios can occur only once (for example a journal starts with a
// centered 633, then switches to running heads). Don't require repetition for
// an isolated number outside the text. In-body numbers and neighboring table,
// equation and footnote text protect their numeric labels.
export function pdfPageNumberMasks(page) {
  return page.text.filter(box => {
    const value = box.text.trim(); const cy = (box.y + box.height / 2) / page.height;
    const roman = /^[ivxlcdm]{1,8}$/i.test(value);
    if (!/^\d{1,5}$/.test(value) && !roman) return false;
    if (box.width > page.width * .15 || box.height > page.height * .03) return false;
    if (roman ? cy > .055 && cy < .94 : cy > .09 && cy < .85) return false;
    const others = page.text.filter(other => other !== box && other.text.trim());
    if (others.some(other => Math.abs(other.y - box.y) < Math.min(box.height, other.height) * .75)) return false;
    return (pdfTextRows(others).some(row => row.text.length > 25
      && Math.max(...row.items.map(t => t.x + t.width)) - Math.min(...row.items.map(t => t.x)) > page.width * .3)
      || !roman && others.filter(t => t.text.length > 25 && t.height > page.height*.3 && t.height > t.width*2).length >= 3)
      && !others.some(other => cy > .5 ? other.y > bottom(box) : bottom(other) < box.y);
  }).map(box => ({ x: Math.max(0, box.x - 5), y: Math.max(0, box.y - 5),
    width: Math.min(page.width, box.x + box.width + 5) - Math.max(0, box.x - 5),
    height: Math.min(page.height, box.y + box.height + 5) - Math.max(0, box.y - 5) }));
}

// Publisher marks can be images or outlined glyphs, so a recurring text mask
// alone leaves a strip of their logo behind. Limit this extension to small
// edge graphics; body diagrams, captions and cover illustrations stay intact.
export function pdfGraphicFurnitureMasks({ width, height, text, images, masks = [] }) {
  const publishing = text.some(box => box.y < height*.3 && /\b(?:doi|journal|publication|published|received|accepted)\b/i.test(box.text));
  return images.filter(box => {
    if (box.y > height*.08 || box.y+box.height > height*.12 || box.height > height*.07 || box.width > width*.32) return false;
    if (text.some(t => /^(?:figure|fig\.?|table)\s+\d/i.test(t.text.trim()) && t.y < box.y+box.height+height*.04)) return false;
    const repeated = masks.some(mask => box.y < mask.y+mask.height && box.y+box.height > mask.y
      && box.x < mask.x+mask.width && box.x+box.width > mask.x);
    const cornerLogo = publishing && box.y < height*.04 && (box.x > width*.6 || box.x+box.width < width*.4);
    return repeated || cornerLogo;
  }).map(box => ({ x: Math.max(0,box.x-2),y:Math.max(0,box.y-2),width:Math.min(width-box.x,box.width+4),height:box.height+4 }));
}

// Textless running ornaments (often textured horizontal bars) survive text
// masks. Remove only isolated, shallow strips repeated at the same page-edge
// position on several pages. Tables, formulas, unique marks and body dividers
// are deliberately outside this rule.
export function removeRepeatedPdfDividers(pages) {
  const groups = [];
  for (const [index, page] of pages.entries()) {
    if (!page.blocks.some(b => b.reflow)) continue;
    for (const block of page.blocks) {
      if (block.kind !== 'scan' || block.lines.length || block.height > page.height * .015
        || block.width < page.width * .4 || block.width < block.height * 40
        || block.y > page.height * .2 && bottom(block) < page.height * .88) continue;
      const normalized = [block.x / page.width, block.y / page.height, block.width / page.width, block.height / page.height];
      let group = groups.find(g => normalized.every((value, i) => Math.abs(value - g.position[i]) < (i === 3 ? .004 : .008)));
      if (!group) { group = { position: normalized, pages: new Set(), blocks: [] }; groups.push(group); }
      group.pages.add(index); group.blocks.push(block);
    }
  }
  const removed = new Set(groups.filter(g => g.pages.size >= Math.max(3, Math.min(6, Math.ceil(pages.length * .3))))
    .flatMap(g => g.blocks));
  return pages.map(page => ({ ...page, blocks: page.blocks.filter(block => !removed.has(block)) }));
}
