// This entry is built only for the desktop service. Phone OCR is unchanged.
import { PdfDocument } from '../../src/pdf.js';
import { packPdfPreparation, pdfPreparationKey, PDF_PREPARATION_VERSION } from '../../src/pdf-cache.js';
import { version } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { base64ToBytes } from '../../src/binary.js';
import { renderPdfPage } from '../../src/pdf-render.js';

window.desktopPdfInfo = { version, preparationVersion: PDF_PREPARATION_VERSION };
window.prepareDesktopPdf = async ({ content, settings, batchSize }) => {
  const reader = new PdfDocument();
  const originalRead = reader.readPageText.bind(reader);
  const ready = new Map();
  reader.readPageText = async (number, reflow, progress) => {
    if (ready.has(number)) { const page = ready.get(number); ready.delete(number); return page; }
    const pending = [];
    for (let n = number; n <= Math.min(reader.pdf.numPages, number + batchSize - 1); n++) {
      await window.desktopProgress({ stage: 'recognizing', page: n, pages: reader.pdf.numPages });
      const cached = await window.desktopPageRead(n);
      if (cached) {
        if (cached.turn) reader.pageTurns.set(n, cached.turn);
        ready.set(n, cached.extracted); continue;
      }
      const extracted = await originalRead(n, reflow, progress);
      if (reader.ocrFailed) throw new Error('Desktop geometry OCR failed; preparation will retry.');
      const turn = reader.pageTurns.get(n) || 0;
      let png = null;
      if (reflow && extracted.needsOcr) {
        const page = await reader.pdf.getPage(n);
        const base = page.getViewport({ scale: 1, rotation: (page.rotate + turn) % 360 });
        const viewport = page.getViewport({ scale: 2048 / Math.max(base.width, base.height), rotation: base.rotation });
        const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        try {
          await renderPdfPage(page, { canvas, viewport, background: '#fff' }).promise;
          png = canvas.toDataURL('image/png').split(',')[1];
        } finally { canvas.width = canvas.height = 1; page.cleanup(); }
      }
      pending.push({ number: n, extracted, turn, png });
    }
    if (pending.length) for (const page of await window.desktopPageBatch(pending)) ready.set(page.number, page.extracted);
    const page = ready.get(number); ready.delete(number); return page;
  };
  try {
    const layout = await reader.open(content, settings.mode, () => {}, settings);
    if (reader.ocrFailed || reader.headingOcrFailed) throw new Error('Incomplete desktop OCR.');
    const key = await pdfPreparationKey(base64ToBytes(content), settings, version);
    return { key, saved: packPdfPreparation(layout, reader.marginMasks, reader.pageScales), warnings: reader.warnings };
  } finally { await reader.destroy(); }
};
