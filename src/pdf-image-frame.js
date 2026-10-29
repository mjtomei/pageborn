// Each image is a complete pane. Keep source coordinates intact for bookmarks,
// the continuous phone preview and gallery renders at a larger resolution.
export function pdfImageFrame(layout, y, height, endAt = Infinity) {
  const scroll = { y, end: Math.min(y + height, endAt), top: 0 };
  const block = layout.blocks.findLast(block => block.y <= y + .5);
  if (!block || block.reflow || block.y >= endAt) return scroll;
  // Hold the whole image while autoscroll traverses it, including its trailing
  // gap. Never pull a fragment of the next image onto the same pane.
  return { y: block.y, end: block.y + block.drawHeight, top: Math.floor((height - block.drawHeight) / 2) };
}
