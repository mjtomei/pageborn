import { pdfTextRows } from './pdf-reflow.js';

// A cover, title page or plate is one image, even when OCR finds a few labels.
// Dense scanned prose still goes through the normal text/column reflow path.
export function pdfWholePageImage({ width, height, data, images, text }) {
  if (!images.some(image => image.kind !== 'drawing' && image.width * image.height >= width * height * .85)) return null;
  const prose = pdfTextRows(text).filter(row => row.text.length >= 35 && row.text.trim().split(/\s+/).length >= 5);
  if (prose.length >= 5 && prose.reduce((sum, row) => sum + row.text.length, 0) >= 240) return null;
  let ink = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 20 && data[i] * .2126 + data[i + 1] * .7152 + data[i + 2] * .0722 < 235 && ++ink >= 20) {
      const bounds = { x: 0, y: 0, width, height };
      return { blocks: [{ ...bounds, kind: 'figure', fullPage: true, lines: [], text: '' }],
        bounds, columns: false, marginMasks: [] };
    }
  }
  return null;
}

// Once a scan has readable prose, a textless fragment containing only ink in
// the outer paper edge is binding/shadow noise, not another reading pane.
// Check pixels, not just the bounding box: two disconnected edge marks can
// produce a page-wide crop. Preserve every fragment with any interior ink,
// recognized text, or figure classification, and leave whole-page scans alone.
export function removePdfScanBorderFragments({ blocks, width, height, data }) {
  if (blocks.filter(block => block.kind === 'text').reduce((sum, block) => sum + block.text.length, 0) < 240) return blocks;
  const edge = Math.max(2, Math.min(20, Math.min(width, height) * .025));
  return blocks.filter(block => {
    if (block.kind !== 'scan' || block.fullPage || block.lines.length || block.text.trim()) return true;
    if (block.x > 2 && block.y > 2 && block.x + block.width < width - 2 && block.y + block.height < height - 2) return true;
    const left = Math.max(Math.ceil(edge), Math.floor(block.x)), top = Math.max(Math.ceil(edge), Math.floor(block.y));
    const right = Math.min(Math.floor(width - edge), Math.ceil(block.x + block.width));
    const bottom = Math.min(Math.floor(height - edge), Math.ceil(block.y + block.height));
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const p = (y * width + x) * 4;
      if (data[p + 3] > 20 && data[p] * .2126 + data[p + 1] * .7152 + data[p + 2] * .0722 < 235) return true;
    }
    return false;
  });
}
