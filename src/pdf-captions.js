import { pdfTextRows } from './pdf-reflow.js';

export const pdfCaptionReference = text => text.trim().match(/^((?:Figure|Figue|Fig\.?|Table|Plate|Chart|Algorithm)\s+(?:[A-Z]?\d+(?:[-–.]\d+)*[a-z]?|[IVX]+))(?:\s*[:.|]|\s+j\s+|\s*$)/i)?.[1]?.replace(/^Figue\b/i, 'Figure');
const bottom = b => b.y + b.height;
const right = b => b.x + b.width;
export const pdfFigureId = (page, block) => [page, block.x, block.sourceY ?? block.y, block.width, block.height].join(':');

// A caption starting in a neighboring column can cause paragraph/figure
// detection to join two independent objects. Split only across a clear lane,
// with no crossing text or drawing pixels; never split a shared caption.
export function splitPdfCaptionColumns(block, pixels, pageWidth) {
  const starts = block.lines.filter(line => pdfCaptionReference(line.text));
  for (const start of starts.sort((a, b) => b.x - a.x)) {
    if (start.x < block.x + block.width * .2 || start.x > right(block) - block.width * .2) continue;
    const left = block.lines.filter(line => right(line) <= start.x - 2);
    const rest = block.lines.filter(line => !left.includes(line));
    if (!left.length || !rest.length) continue;
    const leftEdge = Math.max(...left.map(right)); const rightEdge = Math.min(...rest.map(line => line.x));
    if (rightEdge - leftEdge < 3) continue;
    const cut = (leftEdge + rightEdge) / 2;
    if (block.kind === 'figure') {
      if (!pixels || !pageWidth) continue;
      let ink = 0;
      for (let y = Math.floor(block.y); y < Math.ceil(bottom(block)); y++) {
        for (let x = Math.floor(cut) - 1; x <= Math.floor(cut) + 1; x++) {
          const at = (y * pageWidth + x) * 4;
          if (pixels[at] < 180 && pixels[at + 1] < 180 && pixels[at + 2] < 180) ink++;
        }
      }
      if (ink > 2) continue;
    }
    return [[block.x, cut, left], [cut, right(block), rest]].map(([x, end, lines]) => ({
      ...block, x, width: end - x, lines, text: pdfTextRows(lines).map(row => row.text).join(' '),
      ...(block.figureBounds ? { figureBounds: block.figureBounds.filter(b => right(b) > x && b.x < end)
        .map(b => ({ ...b, x: Math.max(x, b.x), width: Math.min(end, right(b)) - Math.max(x, b.x) })) } : {}),
    }));
  }
  return [block];
}

// Column-region boundaries can cut through a drawing which does not itself
// cross the gutter. Reunite fragments sharing the same source drawing, along
// with text enclosed by that drawing, before extracting its caption.
export function reunitePdfFigureFragments(blocks) {
  blocks = blocks.map(block => {
    if (!block.figureBounds) return block;
    const figureBounds = block.figureBounds.filter(b => Math.min(bottom(block), bottom(b)) - Math.max(block.y, b.y) > Math.min(block.height, b.height) * .25);
    return { ...block, figureBounds, kind: figureBounds.length ? block.kind : block.lines.length ? 'text' : 'scan' };
  });
  const groups = [];
  for (const block of blocks) {
    if (!block.figureBounds?.length) continue;
    const matches = groups.filter(group => group.some(other => other.figureBounds.some(box => block.figureBounds.includes(box))));
    if (!matches.length) groups.push([block]);
    else { const target = matches[0]; target.push(block);
      for (const group of matches.slice(1)) { target.push(...group); groups.splice(groups.indexOf(group), 1); }
    }
  }
  const consumed = new Set(); const replacements = new Map();
  for (const parts of groups) {
    if (parts.length < 2) continue;
    const x = Math.min(...parts.map(b => b.x)), y = Math.min(...parts.map(b => b.y));
    const end = Math.max(...parts.map(right)), low = Math.max(...parts.map(bottom));
    const enclosed = blocks.filter(b => b.x >= x-1 && right(b) <= end+1 && b.y >= y-1 && bottom(b) <= low+1);
    const members = [...new Set([...parts, ...enclosed])].sort((a,b) => blocks.indexOf(a)-blocks.indexOf(b));
    if (members.some(b => consumed.has(b))) continue;
    members.forEach(b => consumed.add(b));
    const lines = [...new Set(members.flatMap(b => b.lines))];
    replacements.set(members[0], { ...parts[0], x, y, width: end-x, height: low-y,
      lines, text: pdfTextRows(lines).map(row => row.text).join(' '),
      figureBounds: [...new Set(parts.flatMap(b => b.figureBounds))] });
  }
  return blocks.flatMap(b => replacements.has(b) ? [replacements.get(b)] : consumed.has(b) ? [] : [b]);
}

// A flattened screenshot may have no image operator at all (just PDF text
// and rectangles). Recognize explicitly captioned form/instruction exhibits
// only on isolated, inset pages with a substantial gap below their caption.
export function protectPdfCaptionedExhibits(page) {
  let blocks = page.blocks;
  const captions = blocks.filter(b => b.annotation?.kind === 'caption');
  if (captions.length === 1) {
    const caption = captions[0];
    const rest = blocks.filter(b => b.y >= bottom(caption));
    if (/^Fig/i.test(caption.annotation.reference) && caption.y < page.height * .25
      && /\b(?:instructions|consent form|screenshot|screen shot)\b/i.test(caption.text)
      && rest.length >= 2 && Math.min(...rest.map(b => b.y)) - bottom(caption) > 24
      && rest.every(b => b.x > page.width * .15 && right(b) < page.width * .85 && bottom(b) < page.height * .93)) {
      const x = Math.min(...rest.map(b => b.x)), y = Math.min(...rest.map(b => b.y));
      const end = Math.max(...rest.map(right)), low = Math.max(...rest.map(bottom));
      const lines = rest.flatMap(b => b.lines);
      const merged = { ...rest[0], x, y, width: end-x, height: low-y, lines,
        text: pdfTextRows(lines).map(row => row.text).join(' '), kind: 'figure',
        captionId: caption.annotation.reference, figureBounds: [{ x, y, width: end-x, height: low-y }] };
      blocks = blocks.flatMap(b => b === rest[0] ? [merged] : rest.includes(b) ? [] : [b]);
    }
  }
  // Scanned screenshots with an external caption belong in the gallery too.
  for (const caption of captions) {
    const scan = blocks.filter(b => b.kind === 'scan' && b.width > page.width*.2 && b.height > 40
      && bottom(b) <= caption.y && caption.y-bottom(b) < page.height*.1
      && Math.min(right(b),right(caption))-Math.max(b.x,caption.x) > Math.min(b.width,caption.width)*.5)
      .sort((a,b) => bottom(b)-bottom(a))[0];
    if (scan) { scan.kind = 'figure'; scan.captionId = caption.annotation.reference; }
  }
  return blocks;
}

// Caption ownership uses source coordinates, never the reordered reader y.
// Keep this metadata on the crop so cached/partial/footnote-free views and the
// gallery all agree without running recognition again.
export function associatePdfCaptions(pages) {
  const owners = new Map();
  for (const page of pages) {
    const figures = page.blocks.filter(block => block.kind === 'figure');
    for (const figure of figures) {
      figure.figureId = pdfFigureId(page.number, figure);
      delete figure.figureCaption;
      const rows = pdfTextRows(figure.lines);
      const start = rows.findIndex(row => pdfCaptionReference(row.text));
      if (start >= 0) {
        // Captions which couldn't safely be detached remain in the scan. Use
        // only their prose band as gallery text, not subsequent table cells.
        const tail = rows.slice(start); const end = tail.findIndex((row, i) => i > 0 &&
          (row.gaps.filter(gap => gap > Math.max(...row.items.map(t => t.height)) * .8).length >= 2
            || row.y - tail[i - 1].y > Math.max(...row.items.map(t => t.height)) * 2));
        const text = tail.slice(0, end < 0 ? undefined : end).map(row => row.text).join(' ');
        figure.figureCaption = { reference: pdfCaptionReference(rows[start].text), text };
      }
    }
    for (const block of page.blocks) {
      if (block.kind === 'figure') continue;
      const reference = block.annotation?.kind === 'caption' ? block.annotation.reference : pdfCaptionReference(pdfTextRows(block.lines)[0]?.text || '');
      if (!reference) continue;
      const distance = figure => Math.min(Math.abs(bottom(figure) - block.y), Math.abs(figure.y - bottom(block)));
      // Captions below a figure often sit almost equally close to the next
      // object. Prefer the preceding figure and the same column center.
      const score = figure => distance(figure)
        + Math.abs((figure.x + figure.width / 2) - (block.x + block.width / 2)) * .3
        + (/^(?:Fig|Plate|Chart)/i.test(reference) && figure.y >= bottom(block) ? 35 : 0);
      const candidates = figures.filter(figure => !figure.figureCaption && (figure.captionId === reference ||
        !figure.captionId && distance(figure) < page.height * .15 &&
        Math.min(right(figure), right(block)) - Math.max(figure.x, block.x) > Math.min(figure.width, block.width) * .4));
      candidates.sort((a, b) => Number(b.captionId === reference) - Number(a.captionId === reference) || score(a) - score(b));
      const owner = candidates[0];
      if (!owner) continue;
      owner.figureCaption = { reference, text: block.reflow?.text || block.text };
      block.figureId = owner.figureId; owners.set(block, owner);
    }
  }
  return owners;
}

export function pdfGalleryItems(layout) {
  if (layout?.format !== 'pdf') return [];
  const images = layout.blocks.flatMap(block => {
    if (block.originalPage && block.digitizationCredit) return [{ ...block, ...block.originalPage, x: 0, sourceY: 0,
      kind: 'figure', fullPage: true, reflow: undefined, lines: [], text: '', figureCaption: undefined }];
    return !block.reflow && !block.annotationLabel ? [block] : [];
  });
  return images.map(block => ({
    id: block.figureId || pdfFigureId(block.page, block), block, page: block.page,
    title: block.fullPage ? `Page image · page ${block.page}` : block.figureCaption?.reference || (block.figureBounds?.some(b => b.kind === 'table') ? `Table · page ${block.page}` : `Figure · page ${block.page}`),
    caption: block.figureCaption?.text || '',
  }));
}

export function pdfAnnotationItems(layout) {
  if (layout?.format !== 'pdf') return [];
  return (layout.annotations || []).map(block => ({ id: `annotation:${pdfFigureId(block.page, block)}`, block, page: block.page,
    title: 'Written annotation', caption: '' }));
}
