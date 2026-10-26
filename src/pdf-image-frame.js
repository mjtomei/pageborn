// Center a complete short image run in the glasses reading area. Keep the
// source coordinates intact: bookmarks, cached preparations and the continuous
// phone passage all use the original layout. A tall run keeps its scroll crop.
export function pdfImageFrame(layout, y, height, endAt = Infinity) {
  const scroll = { y, end: Math.min(y + height, endAt), top: 0 };
  const first = layout.blocks.findLastIndex(block => block.y <= y + .5);
  const block = layout.blocks[first];
  if (!block || block.reflow || block.y >= endAt) return scroll;
  if (block.fullPage) return { y: block.y, end: block.y + block.drawHeight, top: Math.floor((height - block.drawHeight) / 2) };
  let end = block.y;
  for (let i = first; i < layout.blocks.length; i++) {
    const next = layout.blocks[i];
    if (next.reflow || next.y >= endAt) break;
    end = Math.min(endAt, next.y + next.drawHeight);
    if (end - block.y > height) return scroll;
  }
  if (end <= y) return scroll;
  // Hold the complete small image while autoscroll traverses it, instead of
  // clipping its top or recentering a different fragment on each interval.
  return { y: block.y, end, top: Math.floor((height - (end - block.y)) / 2) };
}
