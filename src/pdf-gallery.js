import { pdfGalleryItems } from './pdf-captions.js';
import { fitPdfGallery } from './pdf-gallery-layout.js';

const release = element => {
  for (const canvas of element.querySelectorAll('canvas')) canvas.width = canvas.height = 1;
  element.replaceChildren();
};

export class PdfGallery {
  constructor(element, dialog, items = pdfGalleryItems) {
    this.element = element; this.dialog = dialog;
    this.galleryItems = items;
    this.strip = element.querySelector('.figure-strip');
    this.stage = dialog.querySelector('.figure-stage');
    this.image = dialog.querySelector('.figure-image');
    this.caption = dialog.querySelector('.figure-caption');
    this.measure = this.caption.cloneNode(false);
    this.measure.className = 'figure-caption-measure'; this.measure.removeAttribute('tabindex');
    this.measure.setAttribute('aria-hidden', 'true'); this.stage.append(this.measure);
    this.items = new Map();
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const item = this.items.get(entry.target.dataset.figureId);
        if (!item) continue;
        item.visible = entry.isIntersecting;
        if (!item.visible) { item.abort?.abort(); release(item.thumb); }
      }
      this.pump();
    }, { root: this.strip, rootMargin: '0px 120px' });
    new ResizeObserver(() => this.fit()).observe(this.stage);
    dialog.querySelector('.figure-close').onclick = () => this.close();
    dialog.querySelector('.figure-previous').onclick = () => this.step(-1);
    dialog.querySelector('.figure-next').onclick = () => this.step(1);
    dialog.addEventListener('close', () => { if (!dialog.open) this.clearModal(); });
    dialog.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); this.step(event.key === 'ArrowRight' ? 1 : -1); }
    });
  }
  setLayout(layout) {
    if (this.layout === layout) return;
    const sameDocument = layout && this.layout && layout.document && layout.document === this.layout.document;
    if (!sameDocument) {
      this.close();
      this.observer.disconnect();
      for (const item of this.items.values()) item.abort?.abort();
      release(this.strip); this.items.clear(); this.strip.scrollLeft = 0;
    }
    this.layout = layout;
    const figures = this.galleryItems(layout); const ids = new Set(figures.map(figure => figure.id));
    for (const [id, item] of this.items) if (!ids.has(id)) {
      item.abort?.abort(); this.observer.unobserve(item.button); release(item.thumb); item.button.remove(); this.items.delete(id);
    }
    for (const figure of figures) {
      let item = this.items.get(figure.id);
      if (!item) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'figure-thumbnail';
        button.dataset.figureId = figure.id; button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-controls', this.dialog.id);
        const thumb = document.createElement('span'); thumb.className = 'figure-thumb-image'; thumb.setAttribute('aria-hidden', 'true');
        const title = document.createElement('span'); title.className = 'figure-thumb-title';
        const caption = document.createElement('span'); caption.className = 'figure-thumb-caption';
        button.append(thumb, title, caption);
        item = { button, thumb, titleElement: title, captionElement: caption }; this.items.set(figure.id, item);
        button.onclick = () => this.open(figure.id);
        this.strip.append(button); this.observer.observe(button);
      }
      Object.assign(item, figure);
      item.titleElement.textContent = figure.title; item.captionElement.textContent = figure.caption || `PDF page ${figure.page}`;
      item.button.setAttribute('aria-label', `Open ${figure.title}, PDF page ${figure.page}`);
    }
    // Reorder in place without replacing retained thumbnail canvases or focus.
    for (let i = 0; i < figures.length; i++) {
      const button = this.items.get(figures[i].id).button;
      if (this.strip.children[i] !== button) this.strip.insertBefore(button, this.strip.children[i] || null);
    }
    this.items = new Map(figures.map(figure => [figure.id, this.items.get(figure.id)]));
    this.element.hidden = !figures.length;
    if (this.openId && !ids.has(this.openId)) this.close();
    else if (this.openId) this.describe(this.items.get(this.openId));
    this.pump();
  }
  async pump() {
    if (this.rendering) return;
    this.rendering = true;
    try {
      for (;;) {
        const item = [...this.items.values()].find(item => item.visible && !item.failed && !item.thumb.firstChild);
        if (!item) break;
        const abort = new AbortController(); item.abort = abort;
        try {
          const canvas = await this.layout.pdf.drawFigure(item.block, { maxWidth: 288, maxHeight: 192, signal: abort.signal });
          if (abort.signal.aborted || this.items.get(item.id) !== item) canvas.width = canvas.height = 1;
          else item.thumb.append(canvas);
        } catch {
          if (!abort.signal.aborted) { item.failed = true; item.thumb.textContent = 'Tap to open'; }
        } finally { if (item.abort === abort) item.abort = null; }
      }
    } finally { this.rendering = false; }
  }
  describe(item) {
    this.dialog.querySelector('.figure-title').textContent = `${item.title} · PDF page ${item.page}`;
    this.caption.textContent = item.caption;
    this.caption.hidden = !item.caption;
    this.measure.textContent = item.caption; this.measure.hidden = !item.caption;
    const ids = [...this.items.keys()]; const at = ids.indexOf(item.id);
    this.dialog.querySelector('.figure-previous').disabled = at <= 0;
    this.dialog.querySelector('.figure-next').disabled = at >= ids.length - 1;
    this.dialog.querySelector('.figure-count').textContent = `${at + 1} / ${ids.length}`;
    this.fit();
  }
  clearModal() { this.modalAbort?.abort(); this.openId = null; release(this.image); }
  close() { this.clearModal(); if (this.dialog.open) this.dialog.close(); }
  async open(id) {
    const item = this.items.get(id); if (!item) return;
    this.modalAbort?.abort(); const abort = new AbortController(); this.modalAbort = abort;
    this.openId = id; this.describe(item); this.caption.scrollTop = 0; release(this.image);
    const status = this.dialog.querySelector('.figure-loading'); status.textContent = 'Loading image…';
    if (!this.dialog.open) this.dialog.showModal();
    this.stage.setAttribute('aria-busy', 'true');
    try {
      const fit = this.fit().image;
      const pixels = Math.min(2, devicePixelRatio || 1);
      const canvas = await this.layout.pdf.drawFigure(item.block, { maxWidth: Math.max(1, fit.width * pixels), maxHeight: Math.max(1, fit.height * pixels), signal: abort.signal });
      if (abort.signal.aborted) { canvas.width = canvas.height = 1; return; }
      canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', item.caption || item.title);
      this.image.append(canvas); status.textContent = ''; this.fit();
    } catch {
      if (!abort.signal.aborted) status.textContent = 'Could not load this image. Close and tap it to retry.';
    } finally { if (!abort.signal.aborted) this.stage.setAttribute('aria-busy', 'false'); }
  }
  fit() {
    const item = this.items.get(this.openId); if (!item) return;
    const measureCaption = width => {
      if (!item.caption) return 0;
      this.measure.style.width = `${width}px`;
      return this.measure.getBoundingClientRect().height;
    };
    const fit = fitPdfGallery(item.block.width, item.block.height, this.stage.clientWidth, this.stage.clientHeight, measureCaption,
      { minCaptionWidth: parseFloat(getComputedStyle(this.caption).fontSize) * 9, allowRotation: item.block.annotation?.kind !== 'handwriting' });
    for (const [element, box] of [[this.image, fit.image], [this.caption, fit.caption]]) {
      element.style.width = `${box.width}px`; element.style.height = `${box.height}px`;
      element.style.left = `${box.x}px`; element.style.top = `${box.y}px`;
      element.style.transform = `translate(-50%, -50%) rotate(${box.rotate ? 90 : 0}deg)`;
      element.dataset.rotated = String(box.rotate);
    }
    this.stage.dataset.captionPlacement = fit.placement;
    return fit;
  }
  step(direction) {
    const ids = [...this.items.keys()]; const next = ids[ids.indexOf(this.openId) + direction];
    if (next) this.open(next);
  }
}
