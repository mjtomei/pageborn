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
