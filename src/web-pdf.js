import { getDocument, PDFWorker } from 'pdfjs-dist/legacy/build/pdf.mjs';
import PdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?worker&inline';
import resources from 'virtual:pdf-resources';
import { base64ToBytes } from './binary.js';
import { readPdfText } from './pdf-text.js';
import { renderPdfPage } from './pdf-render.js';

class LocalResources {
  async fetch({ kind, filename }) {
    const data = resources[`${kind}/${filename}`];
    if (!data) throw new Error(`Missing PDF resource: ${filename}`);
    return base64ToBytes(data);
  }
}

// Original pages for browser reading. No OCR, column splitting, or glasses
// reflow. Pixels exist only for the pages currently near the viewport.
export class WebPdf {
  constructor() { this.tasks = new Map(); this.closed = false; }
  async open(content) {
    this.port = new PdfWorker();
    const workerFailure = new Promise((_, reject) => {
      this.port.addEventListener('error', event => reject(new Error(event.message || 'The PDF worker could not start.')));
      this.port.addEventListener('messageerror', () => reject(new Error('Could not read the PDF worker response.')));
    });
    this.worker = new PDFWorker({ port: this.port });
    this.task = getDocument({ data: base64ToBytes(content), worker: this.worker,
      BinaryDataFactory: LocalResources, useWorkerFetch: false, isEvalSupported: false,
      enableXfa: false, cMapPacked: true, canvasMaxAreaInBytes: 16_000_000 });
    this.task.onPassword = () => { this.passwordError?.(new Error('Remove the PDF password before opening it.')); };
    this.pdf = await Promise.race([this.task.promise, workerFailure, new Promise((_, reject) => { this.passwordError = reject; })]);
    const blocks = []; let y = 0;
    for (let number = 1; number <= this.pdf.numPages; number++) {
      if (this.closed) throw new Error('PDF closed.');
      const page = await this.pdf.getPage(number), viewport = page.getViewport({ scale: 1 });
      const height = viewport.height * 552 / viewport.width;
      blocks.push({ index: number - 1, kind: 'image', page: number, y, height, x: 0, width: viewport.width,
        sourceY: 0, sourceHeight: viewport.height, sourceWidth: viewport.width, scale: 552 / viewport.width, text: '' });
      y += height + 16;
    }
    this.layout = { format: 'pdf', blocks, rows: [], blockY: blocks.map(b => b.y), pages: blocks.map(b => b.y), height: y,
      maxY: Math.max(0, y - 288), width: 552, headings: blocks.map(b => ({ text: `Page ${b.page}`, index: b.index, y: b.y })),
      preparation: { complete: true, totalPages: blocks.length, readyPages: blocks.length } };
    await this.text(1);
    return this.layout;
  }
  async text(number) {
    const block = this.layout?.blocks[number - 1];
    if (!block || block.textLoaded || this.closed) return;
    const page = await this.pdf.getPage(number), text = await readPdfText(page);
    if (!this.closed) { block.text = text.items.map(item => item.str || '').join(' '); block.textLoaded = true; this.layout.textRevision = (this.layout.textRevision || 0) + 1; }
  }
  async render(number, canvas, width) {
    const page = await this.pdf.getPage(number);
    if (this.closed || !canvas.isConnected) return;
    const original = page.getViewport({ scale: 1 });
    const ratio = Math.min(devicePixelRatio || 1, 2, Math.sqrt(4_000_000 / (width * width * original.height / original.width)));
    const viewport = page.getViewport({ scale: width / original.width * ratio });
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    // Let PDF.js request its own CPU canvas options before any getContext call.
    // A default accelerated context misrenders resumed text batches in WebKit.
    const task = renderPdfPage(page, { canvas, viewport });
    this.tasks.set(canvas, task);
    try { await task.promise; } finally { this.tasks.delete(canvas); }
  }
  cancel(canvas) { this.tasks.get(canvas)?.cancel(); }
  async destroy() {
    this.closed = true;
    for (const task of this.tasks.values()) task.cancel();
    await Promise.allSettled([...this.tasks.values()].map(task => task.promise));
    await this.task?.destroy().catch(() => {});
    this.port?.terminate();
  }
}
