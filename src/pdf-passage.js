import { PDF_WIDTH, pdfAnchor, restorePdfAnchor } from './pdf-layout.js';

const TILE_HEIGHT = 384;
export class PdfPassageView {
  constructor(element, onSelect) {
    this.element = element; this.onSelect = onSelect; this.layout = null; this.current = 0; this.follow = true; this.generation = 0;
    element.addEventListener('scroll', () => this.render(), { passive: true });
    for (const type of ['wheel', 'touchstart', 'pointerdown']) element.addEventListener(type, () => { this.follow = false; }, { passive: true });
    element.addEventListener('keydown', event => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) { this.follow = false; event.stopPropagation(); }
    });
    this.resize = new ResizeObserver(() => { this.range = null; if (this.follow) this.showCurrent(); else this.render(); }); this.resize.observe(element);
  }
  setLayout(layout, y) {
    if (layout !== this.layout) {
      this.cancelRendering();
      const updating = layout && this.layout && layout.document === this.layout.document && layout.document;
      const ratio = this.element.clientWidth / PDF_WIDTH;
      const anchor = updating && ratio ? pdfAnchor(this.layout, this.element.scrollTop / ratio) : null;
      this.layout = layout; this.generation++; this.range = null;
      if (!updating) this.follow = true;
      this.top = document.createElement('div'); this.list = document.createElement('div'); this.bottom = document.createElement('div');
      this.top.setAttribute('aria-hidden', 'true'); this.bottom.setAttribute('aria-hidden', 'true');
      this.element.replaceChildren(this.top, this.list, this.bottom);
      // Install the height before restoring scrollTop (otherwise the browser
      // clamps the saved position to the empty replacement's height).
      this.bottom.style.height = `${(layout?.height || 0) * ratio}px`;
      this.element.scrollTop = anchor ? restorePdfAnchor(layout, anchor) * ratio : 0;
    }
    this.current = y;
    if (this.follow) this.showCurrent(); else this.render();
  }
  cancelRendering() {
    this.renderAbort?.abort();
    for (const canvas of this.element.querySelectorAll('canvas')) canvas.width = canvas.height = 1;
  }
  showCurrent(alignStart = false) {
    this.follow = true;
    const ratio = this.element.clientWidth / PDF_WIDTH;
    const top = this.current * ratio;
    if (alignStart || top < this.element.scrollTop || top + 100 > this.element.scrollTop + this.element.clientHeight) this.element.scrollTop = top;
    this.render();
  }
  render() {
    if (!this.layout || !this.list || this.element.hidden) return;
    const ratio = this.element.clientWidth / PDF_WIDTH;
    if (!ratio) return;
    const count = Math.ceil(this.layout.height / TILE_HEIGHT);
    const start = Math.max(0, Math.floor(this.element.scrollTop / ratio / TILE_HEIGHT) - 1);
    const end = Math.min(count, Math.ceil((this.element.scrollTop + this.element.clientHeight) / ratio / TILE_HEIGHT) + 1);
    const key = `${start}:${end}:${ratio}`;
    if (this.range !== key) {
      this.range = key; const generation = ++this.generation;
      this.cancelRendering();
      this.renderAbort = new AbortController(); const signal = this.renderAbort.signal;
      this.list.replaceChildren();
      this.top.style.height = `${start * TILE_HEIGHT * ratio}px`;
      this.bottom.style.height = `${Math.max(0, this.layout.height - end * TILE_HEIGHT) * ratio}px`;
      for (let index = start; index < end; index++) {
        const y = index * TILE_HEIGHT; const height = Math.min(TILE_HEIGHT, this.layout.height - y);
        const button = document.createElement('button'); button.type = 'button'; button.className = 'pdf-tile'; button.dataset.y = String(y);
        button.style.height = `${height * ratio}px`; button.setAttribute('aria-label', `Read PDF from ${Math.round(y / this.layout.height * 100)}%`);
        button.onclick = event => {
          const offset = event.detail === 0 ? 0 : (event.clientY - button.getBoundingClientRect().top) / ratio;
          this.follow = false; this.onSelect(Math.min(this.layout.maxY, y + offset));
        };
        this.list.append(button);
        this.layout.pdf.draw(y, height, false, { signal }).then(canvas => {
          if (generation !== this.generation) { canvas.width = canvas.height = 1; return; }
          canvas.setAttribute('aria-hidden', 'true'); button.append(canvas);
        }).catch(error => { if (generation === this.generation) button.textContent = `Could not render preview: ${error.message}`; });
      }
    }
    for (const button of this.list.children) {
      const y = Number(button.dataset.y);
      button.setAttribute('aria-current', String(this.current >= y && this.current < y + TILE_HEIGHT));
    }
  }
}
