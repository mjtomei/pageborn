import { rowAt, wrapText } from './document.js';

// All rows participate in the scrollbar, but only nearby rows have DOM nodes.
// Wrap with the same fonts used below so each row has a known, stable height.
export class PassageView {
  constructor(element, onSelect) {
    this.element = element; this.onSelect = onSelect; this.rows = []; this.offsets = [0];
    this.current = 0; this.follow = true; this.size = 12; this.width = 0;
    this.measure = document.createElement('canvas').getContext('2d');
    this.top = document.createElement('div'); this.bottom = document.createElement('div');
    this.top.setAttribute('aria-hidden', 'true'); this.bottom.setAttribute('aria-hidden', 'true');
    this.list = document.createElement('div'); this.list.className = 'passage-lines';
    element.replaceChildren(this.top, this.list, this.bottom);
    element.addEventListener('scroll', () => this.render(), { passive: true });
    for (const type of ['wheel', 'touchstart', 'pointerdown']) element.addEventListener(type, () => { this.follow = false; }, { passive: true });
    element.addEventListener('keydown', event => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) {
        this.follow = false; event.stopPropagation();
      }
    });
    this.list.addEventListener('click', event => {
      const button = event.target.closest('button[data-row]');
      if (button) { this.follow = false; this.onSelect(this.layout.rows[Number(button.dataset.row)].y); }
    });
    this.resize = new ResizeObserver(() => {
      if (element.clientWidth !== this.width) this.reflow();
    });
    this.resize.observe(element);
  }
  setLayout(layout, y) {
    if (layout !== this.layout) {
      this.layout = layout; this.follow = true; this.element.scrollTop = 0;
      this.current = layout ? rowAt(layout, y) : 0; this.reflow();
    }
    this.setPosition(y);
  }
  setSize(size) { if (this.size !== size) { this.size = size; this.reflow(); } }
  indexAt(y) {
    let low = 0; let high = this.rows.length;
    while (low < high) { const mid = (low + high) >>> 1; if (this.offsets[mid + 1] <= y) low = mid + 1; else high = mid; }
    return Math.min(low, Math.max(0, this.rows.length - 1));
  }
  reflow() {
    const anchor = this.indexAt(this.element.scrollTop);
    this.width = this.element.clientWidth;
    const family = getComputedStyle(this.element).fontFamily;
    this.lineHeight = Math.ceil(this.size * 1.25);
    this.element.style.setProperty('--passage-size', `${this.size}px`);
    this.element.style.setProperty('--passage-line-height', `${this.lineHeight}px`);
    this.rows = []; this.offsets = [0];
    const cache = new Map();
    for (const row of this.layout?.rows || []) {
      const font = `${['heading', 'table-caption', 'table-row-start'].includes(row.kind) ? 650 : 400} ${this.size}px ${row.kind === 'code' ? 'monospace' : family}`;
      this.measure.font = font;
      const key = `${font}\n${row.table}\n${row.text}`;
      let lines = cache.get(key);
      if (!lines) {
        lines = wrapText(row.text || ' ', Math.max(40, this.width - 24), value => this.measure.measureText(value).width, row.kind === 'code' || row.table);
        if (!lines.length) lines = [{ text: ' ' }];
        cache.set(key, lines);
      }
      const height = lines.length * this.lineHeight;
      this.rows.push({ ...row, lines, height }); this.offsets.push(this.offsets.at(-1) + height);
    }
    this.range = null;
    this.render();
    this.element.scrollTop = this.offsets[Math.min(anchor, this.rows.length)] || 0;
    if (this.follow) this.reveal(); else this.render();
  }
  setPosition(y) {
    this.current = this.layout ? rowAt(this.layout, y) : 0;
    if (this.follow) this.reveal(); else this.render();
  }
  showCurrent(alignStart = false) { this.follow = true; this.reveal(alignStart); }
  reveal(alignStart = false) {
    const top = this.offsets[this.current] || 0;
    const bottom = this.offsets[this.current + 1] || top;
    if (alignStart || top < this.element.scrollTop || bottom > this.element.scrollTop + this.element.clientHeight) this.element.scrollTop = top;
    this.render();
  }
  render() {
    const start = Math.max(0, this.indexAt(this.element.scrollTop) - 12);
    const end = Math.min(this.rows.length, this.indexAt(this.element.scrollTop + this.element.clientHeight) + 13);
    if (!this.range || start !== this.range.start || end !== this.range.end) {
      this.range = { start, end };
      const fragment = document.createDocumentFragment();
      for (let i = start; i < end; i++) {
        const row = this.rows[i]; const button = document.createElement('button');
        button.type = 'button'; button.className = row.kind; button.dataset.row = String(i);
        button.setAttribute('aria-label', row.text || 'Blank line');
        button.style.height = `${row.height}px`;
        row.lines.forEach((line, index) => {
          if (index) button.append(document.createTextNode('\n'));
          const span = document.createElement('span'); span.textContent = line.text || ' '; button.append(span);
        });
        fragment.append(button);
      }
      this.list.replaceChildren(fragment);
      this.top.style.height = `${this.offsets[start]}px`;
      this.bottom.style.height = `${this.offsets.at(-1) - this.offsets[end]}px`;
    }
    for (const button of this.list.children) {
      if (Number(button.dataset.row) === this.current) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    }
  }
}
