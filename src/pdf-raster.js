import { normalizePdfColors } from './pdf-colors.js';
import { renderPdfPage } from './pdf-render.js';

export const PDF_RASTER_TILE = 384;
const HALO = 2;
const SAMPLES = 2;

// Gentle unsharp masking at the final pixel size, after resampling. The halo
// around each tile makes the result independent of scroll/tile boundaries.
// Only flat-paper text blocks use this; figures and photographs retain tones.
export function sharpenPdfText(data, width, height) {
  const source = new Uint8ClampedArray(data);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = (y * width + x) * 4; const stride = width * 4;
    const blurred = (source[i - stride - 4] + 2 * source[i - stride] + source[i - stride + 4]
      + 2 * source[i - 4] + 4 * source[i] + 2 * source[i + 4]
      + source[i + stride - 4] + 2 * source[i + stride] + source[i + stride + 4]) / 16;
    const value = Math.max(0, Math.min(255, Math.round(source[i] + .5 * (source[i] - blurred))));
    data[i] = data[i + 1] = data[i + 2] = value;
  }
  return data;
}

export function pdfRasterGeometry(block, index, analysisScale) {
  const y = index * PDF_RASTER_TILE;
  const width = Math.ceil(block.width * block.scale);
  const height = Math.min(PDF_RASTER_TILE, block.drawHeight - y);
  return { y, width, height, scale: analysisScale * block.scale * SAMPLES,
    renderWidth: (width + HALO * 2) * SAMPLES, renderHeight: (height + HALO * 2) * SAMPLES,
    transform: [1, 0, 0, 1, (HALO - block.x * block.scale) * SAMPLES,
      (HALO - block.sourceY * block.scale - y) * SAMPLES] };
}

// Keep the 900px page renders for analysis only. Display tiles are rendered
// from the original PDF at twice their final size, then reduced once. A small
// tile cache and one render at a time bound canvas memory on the phone.
export class PdfRaster {
  constructor(pdf, scales, normalizeColors) {
    this.pdf = pdf; this.scales = scales; this.normalizeColors = normalizeColors;
    this.cache = new Map(); this.pending = new Map(); this.ids = new WeakMap(); this.nextId = 0;
    this.queue = Promise.resolve(); this.closed = false;
  }
  tile(block, index) {
    if (this.closed) return Promise.reject(new Error('PDF closed.'));
    if (!this.ids.has(block)) this.ids.set(block, ++this.nextId);
    const key = `${this.ids.get(block)}:${index}`;
    if (this.cache.has(key)) {
      const canvas = this.cache.get(key); this.cache.delete(key); this.cache.set(key, canvas);
      return Promise.resolve(canvas);
    }
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = this.queue.then(async () => {
      if (this.closed) throw new Error('PDF closed.');
      const canvas = await this.render(block, index);
      if (this.closed) { canvas.width = canvas.height = 1; throw new Error('PDF closed.'); }
      this.cache.set(key, canvas);
      while (this.cache.size > 12) {
        const oldest = this.cache.keys().next().value;
        const unused = this.cache.get(oldest); unused.width = unused.height = 1;
        this.cache.delete(oldest);
      }
      return canvas;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise); this.queue = promise.catch(() => {});
    return promise;
  }
  async render(block, index) {
    const page = await this.pdf.getPage(block.page);
    if (this.closed) throw new Error('PDF closed.');
    // Rendered tiles own their pixels. Release the previous page's decoded
    // images so reading a long scan does not retain every full-size image.
    if (this.page && this.page !== page) this.page.cleanup();
    this.page = page;
    const geometry = pdfRasterGeometry(block, index, this.scales.get(block.page));
    const high = document.createElement('canvas'); high.width = geometry.renderWidth; high.height = geometry.renderHeight;
    const reduced = document.createElement('canvas'); reduced.width = high.width / SAMPLES; reduced.height = high.height / SAMPLES;
    try {
      this.task = renderPdfPage(page, { canvas: high, viewport: page.getViewport({ scale: geometry.scale, rotation: block.pageRotation ?? page.rotate }),
        transform: geometry.transform, background: '#fff' });
      await this.task.promise;
      if (this.normalizeColors) {
        const ctx = high.getContext('2d'); const pixels = ctx.getImageData(0, 0, high.width, high.height);
        normalizePdfColors(pixels.data, block.colorProfile); ctx.putImageData(pixels, 0, 0);
      }
      const ctx = reduced.getContext('2d'); ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(high, 0, 0, reduced.width, reduced.height);
      if (this.normalizeColors && block.colorProfile && block.kind !== 'figure') {
        const pixels = ctx.getImageData(0, 0, reduced.width, reduced.height);
        sharpenPdfText(pixels.data, reduced.width, reduced.height); ctx.putImageData(pixels, 0, 0);
      }
      const canvas = document.createElement('canvas'); canvas.width = geometry.width; canvas.height = geometry.height;
      canvas.getContext('2d').drawImage(reduced, HALO, HALO, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      return canvas;
    } finally { this.task = null; high.width = high.height = reduced.width = reduced.height = 1; }
  }
  destroy() {
    this.closed = true; this.task?.cancel();
    for (const canvas of this.cache.values()) canvas.width = canvas.height = 1;
    this.cache.clear();
  }
  cleanup(clean) {
    // Pause new thumbnail/preview tiles behind document cleanup. PDF.js cannot
    // drop shared fonts/images while any page is still rendering.
    const pending = this.queue.then(async () => {
      if (this.closed) return;
      await clean(); this.page = null;
    });
    this.queue = pending.catch(() => {});
    return pending;
  }
}
