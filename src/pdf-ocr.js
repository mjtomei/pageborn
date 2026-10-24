import resources from 'virtual:ocr-resources';
import { base64ToBytes } from './binary.js';
import { normalizePdfColors, pdfColorProfile } from './pdf-colors.js';
import { OcrWorker } from './ocr-worker.js';
import { renderPdfPage } from './pdf-render.js';
import { pdfAnalysisViewport, pdfQuarterTurnNeeded, pdfOcrScore, pdfRomanStrokes } from './pdf-orientation.js';
import { pdfOcrReference } from './pdf-ocr-references.js';
import { simd } from 'wasm-feature-detect';

const cache = new Map();
export class PdfOcr {
  async recognize(page, viewport, key, progress) {
    if (this.destroyed) throw new Error('PDF closed.');
    if (cache.has(key)) return cache.get(key);
    if (!this.worker) {
      const vectorized = await simd().catch(() => false);
      if (this.destroyed) throw new Error('PDF closed.');
      this.core = vectorized ? 'simd' : 'scalar';
      // The self-contained core, worker and language data are local Blobs.
      // Tesseract appends a filename to langPath: put it in the URL fragment
      // so fetch still reads the exact language Blob, without a network request.
      this.url = URL.createObjectURL(new Blob([vectorized ? resources.simdCore : resources.core, '\n', resources.worker], { type: 'text/javascript' }));
      this.languageUrl = URL.createObjectURL(new Blob([base64ToBytes(resources.english)], { type: 'application/gzip' }));
      this.progress = progress;
      this.worker = new OcrWorker(this.url, message => this.progress?.(message.status === 'recognizing text' ? Math.round(message.progress * 100) : null));
      await this.worker.call('load', { options: { lstmOnly: true } });
      await this.worker.call('loadLanguage', { langs: 'eng', options: { langPath: `${this.languageUrl}#`, cacheMethod: 'none', gzip: true, lstmOnly: true } });
      await this.worker.call('initialize', { langs: 'eng', oem: 1, config: {} });
      await this.worker.call('setParameters', { params: { tessedit_pageseg_mode: '3', user_defined_dpi: '150' } });
    }
    this.progress = progress;
    let result = await this.recognizeTurn(page, viewport, 0); const originalText = result;
    if (pdfQuarterTurnNeeded(result)) {
      let score = pdfOcrScore(result); let turn = 0;
      for (const candidate of [90, 270]) {
        const lines = await this.recognizeTurn(page, pdfAnalysisViewport(page, candidate), candidate);
        const candidateScore = pdfOcrScore(lines);
        if (candidateScore.letters >= 60 && candidateScore.quality > score.quality + 10 && candidateScore.score > score.score * 1.3) {
          result = lines; score = candidateScore; turn = candidate;
        }
        if (turn && score.quality > 50) break;
      }
      result = { text: result, turn, ...(turn ? { originalText } : {}) };
    } else result = { text: result, turn: 0 };
    cache.set(key, result); while (cache.size > 64) cache.delete(cache.keys().next().value);
    this.progress = null;
    return result;
  }
  async recognizeTurn(page, viewport, turn) {
    if (this.destroyed) throw new Error('PDF closed.');
    const rotation = (page.rotate + turn) % 360;
    const base = page.getViewport({ scale: 1, rotation });
    const scale = Math.min(1800 / base.width, 4096 / base.height, Math.sqrt(4_000_000 / (base.width * base.height)));
    const ocrViewport = page.getViewport({ scale, rotation });
    const canvas = document.createElement('canvas'); canvas.width = Math.ceil(ocrViewport.width); canvas.height = Math.ceil(ocrViewport.height);
    try {
      await renderPdfPage(page, { canvas, viewport: ocrViewport, background: '#fff' }).promise;
      const ctx = canvas.getContext('2d'); const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      normalizePdfColors(pixels.data, pdfColorProfile(pixels.data)); ctx.putImageData(pixels, 0, 0);
      if (this.destroyed) throw new Error('PDF closed.');
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('Could not prepare scan for OCR.');
      const data = await this.worker.call('recognize', { image: new Uint8Array(await blob.arrayBuffer()), options: {}, output: { blocks: true, text: true } });
      const ratio = viewport.scale / scale; const lines = []; let paragraph = 0;
      const box = bbox => ({ x: bbox.x0 * ratio, y: bbox.y0 * ratio, width: (bbox.x1 - bbox.x0) * ratio, height: (bbox.y1 - bbox.y0) * ratio });
      for (const block of data.blocks || []) for (const p of block.paragraphs || []) {
        paragraph++;
        for (const line of p.lines || []) if (line.text?.trim()) {
          const words = []; let text = line.text.trim(); let offset = 0;
          const prose = line.words.filter(word => /\p{L}{2}/u.test(word.text));
          const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] || 0;
          const row = { baseline: median(prose.map(w => w.bbox.y1)), size: median(prose.map(w => w.bbox.y1 - w.bbox.y0)) };
          for (const word of line.words) {
            const item = { ...box(word.bbox), text: word.text, confidence: word.confidence };
            const candidate = pdfOcrReference(word, row);
            if (candidate) {
              const crop = box(candidate.bbox);
              // The whole-page recognizer commonly reads tiny 1/2/0 as !/?/°.
              // Re-read the actual raised glyph at higher resolution, rather
              // than guessing a footnote number from the surrounding prose.
              const number = await this.recognizeNumber(page, viewport, crop);
              if (number) {
                item.text = word.text.slice(0, candidate.start) + number;
                item.references = [{ ...crop, start: candidate.start, end: candidate.start + number.length, number }];
              }
            }
            const at = text.indexOf(word.text, offset);
            if (at >= 0) { text = text.slice(0, at) + item.text + text.slice(at + word.text.length); offset = at + item.text.length; }
            words.push(item);
          }
          lines.push({ ...box(line.bbox), text, confidence: line.confidence, paragraph, words });
        }
      }
      return lines;
    } finally { canvas.width = canvas.height = 1; }
  }
  async recognizeNumber(page, viewport, crop) {
    const factor = 5; const padding = 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil((crop.width + padding * 2) * factor);
    canvas.height = Math.ceil((crop.height + padding * 2) * factor);
    try {
      await renderPdfPage(page, { canvas, viewport: page.getViewport({ scale: viewport.scale * factor, rotation: viewport.rotation }),
        transform: [1, 0, 0, 1, -(crop.x - padding) * factor, -(crop.y - padding) * factor], background: '#fff' }).promise;
      const ctx = canvas.getContext('2d'); const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      normalizePdfColors(pixels.data, pdfColorProfile(pixels.data)); ctx.putImageData(pixels, 0, 0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) return null;
      const result = await this.worker.call('recognize', { image: new Uint8Array(await blob.arrayBuffer()),
        options: { tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789' }, output: { text: true } });
      const number = result.text.trim();
      return /^\d{1,3}$/.test(number) && result.confidence >= 60 ? number : null;
    } finally { canvas.width = canvas.height = 1; }
  }
  async recognizeRomanHeading(page, viewport, crop) {
    if (!this.worker || this.destroyed) return null;
    const left = Math.max(0,crop.x-6); const top = Math.max(0,crop.y-6);
    const canvas = document.createElement('canvas'); canvas.width = Math.ceil((crop.width+12)*3); canvas.height = Math.ceil((crop.height+12)*3);
    try {
      await renderPdfPage(page, { canvas, viewport: page.getViewport({ scale: viewport.scale*3, rotation: viewport.rotation }),
        transform: [1,0,0,1,-left*3,-top*3], background: '#fff' }).promise;
      const c = canvas.getContext('2d'); const pixels = c.getImageData(0,0,canvas.width,canvas.height);
      normalizePdfColors(pixels.data,pdfColorProfile(pixels.data)); c.putImageData(pixels,0,0);
      const prior = crop.lines?.length === 1 ? crop.lines[0] : null;
      const strokes = prior?.confidence >= 55 && /^[1lI]{2,4}$/.test(prior.text)
        ? pdfRomanStrokes(pixels.data,canvas.width,canvas.height) : null;
      if(strokes && strokes.length===prior.text.length) return {x:crop.x,y:crop.y,width:crop.width,height:crop.height,
        text:strokes,confidence:prior.confidence,heading:true};
      const blob = await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      if (!blob) return null;
      const result = await this.worker.call('recognize', { image: new Uint8Array(await blob.arrayBuffer()),
        options: { tessedit_pageseg_mode:'7',tessedit_char_whitelist:'IVXLCDM' }, output:{text:true} });
      const text = result.text.trim();
      // A whitelist can depress confidence for II/III despite agreeing with
      // the whole-page reading of 11/111. Use that independent shape evidence.
      const agrees = prior?.text.replace(/[l1]/g,'I').toUpperCase() === text;
      const confidence = agrees ? Math.max(result.confidence,prior.confidence) : result.confidence;
      if (!/^(?:X{0,3}(?:IX|IV|V?I{0,3}))$/.test(text) || !text || confidence < 55) return null;
      return { x:crop.x,y:crop.y,width:crop.width,height:crop.height,text,confidence,heading:true };
    } finally { canvas.width=canvas.height=1; }
  }
  async destroy() {
    this.destroyed = true; this.progress = null;
    this.worker?.close();
    if (this.url) URL.revokeObjectURL(this.url);
    if (this.languageUrl) URL.revokeObjectURL(this.languageUrl);
  }
}
