// iOS shrinks the visual viewport, but leaves the layout viewport (and dvh)
// behind the keyboard. Keep the whole chat inside the visible area while typing.
export class AskKeyboard {
  constructor(panel, input, active, changed) {
    Object.assign(this, { panel, input, active, changed });
    this.baseline = window.innerHeight;
    const update = () => this.update();
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', () => requestAnimationFrame(update));
  }
  update() {
    const viewport = window.visualViewport;
    const height = viewport?.height ?? window.innerHeight;
    const focused = document.activeElement === this.input;
    if (!focused && !this.docked) this.baseline = window.innerHeight;
    this.baseline = Math.max(this.baseline, window.innerHeight);
    const docked = this.active() && (focused || this.docked)
      && Math.abs((viewport?.scale ?? 1) - 1) < .05 && this.baseline - height > 120;
    const geometry = docked ? [viewport?.offsetTop || 0, viewport?.offsetLeft || 0, viewport?.width || window.innerWidth, height].map(Math.round) : null;
    const key = JSON.stringify(geometry);
    if (key === this.key) return;
    this.key = key; this.docked = docked;
    this.panel.dataset.keyboard = String(docked);
    if (geometry) for (const [i, name] of ['top', 'left', 'width', 'height'].entries()) this.panel.style.setProperty(`--chat-${name}`, `${geometry[i]}px`);
    else this.baseline = window.innerHeight;
    this.changed();
  }
}
