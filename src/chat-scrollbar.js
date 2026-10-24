// A visible, touch-draggable scrollbar even when the host hides native bars.
export class ChatScrollbar {
  constructor(history, rail, content, changed) {
    Object.assign(this, { history, rail, changed });
    this.thumb = rail.firstElementChild;
    history.addEventListener('scroll', () => this.update(), { passive: true });
    this.resize = new ResizeObserver(() => this.update());
    this.resize.observe(history); this.resize.observe(content);
    rail.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0 || !this.max) return;
      event.preventDefault();
      this.dragging = true; this.pointer = event.pointerId;
      const thumb = this.thumb.getBoundingClientRect();
      this.grab = event.clientY >= thumb.top && event.clientY <= thumb.bottom ? event.clientY - thumb.top : thumb.height / 2;
      rail.setPointerCapture(event.pointerId); this.seek(event.clientY);
    });
    rail.addEventListener('pointermove', event => { if (this.dragging && event.pointerId === this.pointer) this.seek(event.clientY); });
    const end = event => {
      if (event.pointerId !== this.pointer) return;
      this.dragging = false; this.pointer = null; this.changed();
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) rail.addEventListener(type, end);
    rail.addEventListener('keydown', event => {
      const { scrollTop, clientHeight } = history;
      const target = { ArrowUp: scrollTop - 40, ArrowDown: scrollTop + 40,
        PageUp: scrollTop - clientHeight * .9, PageDown: scrollTop + clientHeight * .9,
        Home: 0, End: this.max }[event.key];
      if (target == null || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault(); event.stopPropagation(); this.move(target);
    });
    this.update();
  }
  get max() { return Math.max(0, this.history.scrollHeight - this.history.clientHeight); }
  update() {
    const { history, rail, thumb } = this;
    const height = rail.clientHeight, max = this.max;
    this.size = Math.min(height, Math.max(28, height * history.clientHeight / (history.scrollHeight || 1)));
    this.travel = Math.max(0, height - this.size);
    const progress = max ? Math.max(0, Math.min(1, history.scrollTop / max)) : 0;
    thumb.style.height = `${this.size}px`; thumb.style.transform = `translateY(${progress * this.travel}px)`;
    rail.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
    rail.setAttribute('aria-valuetext', max ? `${Math.round(progress * 100)}% through conversation` : 'Entire conversation visible');
    rail.setAttribute('aria-disabled', String(!max)); rail.tabIndex = max ? 0 : -1;
  }
  seek(y) {
    this.update();
    this.move(this.travel ? (y - this.rail.getBoundingClientRect().top - this.grab) / this.travel * this.max : 0);
  }
  move(top) {
    this.history.scrollTop = Math.max(0, Math.min(this.max, top));
    this.update(); this.changed();
  }
}
