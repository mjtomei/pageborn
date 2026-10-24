// All dimensions are CSS pixels. Measure the caption at its actual font size
// and wrapping width; image and caption share a fixed viewport so changing the
// chosen layout cannot feed back into its ResizeObserver.
export function fitPdfGallery(width, height, availableWidth, availableHeight, measureCaption, { gap = 12, minCaptionWidth = 128 } = {}) {
  const W = Math.max(1, availableWidth), H = Math.max(1, availableHeight);
  const candidates = [];
  const box = (x, y, width, height, rotate = false) => ({ x, y, width, height, rotate });
  const below = (rotateImage, rotateCaption) => {
    const w = rotateCaption ? H : W, h = rotateCaption ? W : H;
    const captionHeight = Math.min(measureCaption(w), h * .25);
    const spacing = captionHeight ? Math.min(gap, h * .05) : 0;
    const turned = rotateImage !== rotateCaption;
    const scale = Math.min(w / (turned ? height : width), (h - captionHeight - spacing) / (turned ? width : height));
    const imageWidth = (turned ? height : width) * scale, imageHeight = (turned ? width : height) * scale;
    const top = (h - imageHeight - spacing - captionHeight) / 2;
    const image = box(w / 2, top + imageHeight / 2, width * scale, height * scale, rotateImage);
    const caption = box(w / 2, top + imageHeight + spacing + captionHeight / 2, w, captionHeight, rotateCaption);
    // Rotate the caption and the arrangement together, putting the caption
    // underneath the image when the phone is turned to read it.
    if (rotateCaption) for (const b of [image, caption]) [b.x, b.y] = [W - b.y, b.x];
    candidates.push({ scale, image, caption, placement: rotateCaption ? 'rotated-below' : 'below' });
  };
  below(false, false);
  below(true, false);
  // Tall figures can also use spare space beside them without rotating text.
  // Keep that column readable; do not squeeze the caption to a sliver merely
  // to win image area. Widen it into any remaining space after fitting.
  if (measureCaption(W) && minCaptionWidth <= W * .4) {
    for (const rotate of [false, true]) {
      const iw = rotate ? height : width, ih = rotate ? width : height;
      const scale = Math.min((W - minCaptionWidth - gap) / iw, H / ih);
      const imageWidth = iw * scale;
      const captionWidth = Math.min(W * .4, W - imageWidth - gap);
      const captionHeight = Math.min(H, measureCaption(captionWidth));
      const left = (W - imageWidth - gap - captionWidth) / 2;
      candidates.push({ scale, image: box(left + imageWidth / 2, H / 2, width * scale, height * scale, rotate),
        caption: box(left + imageWidth + gap + captionWidth / 2, H / 2, captionWidth, captionHeight), placement: 'beside' });
    }
  }
  // Prefer upright captions on ties, and rotate only for a larger figure.
  below(true, true);
  return candidates.reduce((best, candidate) => candidate.scale > best.scale + 1e-6 ? candidate : best);
}
