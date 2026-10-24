import { BODY_HEIGHT, WIDTH, MARGIN } from './document.js';
import { titleLines } from './speed-reading.js';

const bitmaps = new WeakMap();
// Native text has a fixed font and nine rows. Exceptionally long titles use a
// fitted image so they still appear in full; normal headings stay native text.
export function speedTitleBitmap(group) {
  if (!group?.heading || group.content) return null;
  if (bitmaps.has(group)) return bitmaps.get(group);
  const canvas = document.createElement('canvas'); canvas.width = WIDTH; canvas.height = BODY_HEIGHT;
  const ctx = canvas.getContext('2d');
  let size = 22; let lines;
  do {
    ctx.font = `${size}px sans-serif`;
    lines = titleLines(group.text, text => ctx.measureText(text).width, WIDTH - 2 * MARGIN);
    if (lines.length * size * 1.25 <= BODY_HEIGHT - 2 * MARGIN) break;
    size *= .9;
  } while (size > .01);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, WIDTH, BODY_HEIGHT);
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const lineHeight = size * 1.25; const top = (BODY_HEIGHT - lines.length * lineHeight) / 2;
  lines.forEach((line, i) => ctx.fillText(line, WIDTH / 2, top + (i + .5) * lineHeight));
  bitmaps.set(group, canvas); return canvas;
}
