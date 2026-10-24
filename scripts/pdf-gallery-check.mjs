// Passed directly to page.evaluate: inspect actual layout, including measured
// caption wrapping, without invoking the layout chooser under test.
export function inspectPdfGallery({ width, height }) {
  const dialog = document.querySelector('#figure-dialog');
  const stage = dialog.querySelector('.figure-stage').getBoundingClientRect();
  const image = dialog.querySelector('.figure-image'); const a = image.getBoundingClientRect();
  const caption = dialog.querySelector('.figure-caption'); const b = caption.getBoundingClientRect();
  const probe = caption.cloneNode(true); probe.removeAttribute('tabindex'); probe.setAttribute('aria-hidden', 'true');
  Object.assign(probe.style, { height: 'auto', width: `${stage.width}px`, transform: 'none', visibility: 'hidden' });
  dialog.append(probe); const captionHeight = probe.getBoundingClientRect().height; probe.remove();
  const H = stage.height - Math.min(captionHeight, stage.height * .25) - (captionHeight ? Math.min(12, stage.height * .05) : 0);
  const belowScale = Math.max(Math.min(stage.width/width,H/height),Math.min(stage.width/height,H/width));
  const minCaptionWidth = parseFloat(getComputedStyle(caption).fontSize)*9;
  const sideWidth = stage.width-minCaptionWidth-12;
  const besideScale = captionHeight && minCaptionWidth <= stage.width*.4
    ? Math.max(Math.min(sideWidth/width,stage.height/height),Math.min(sideWidth/height,stage.height/width)) : 0;
  const uprightMaximum = Math.max(belowScale,besideScale);
  const contains = box => box.left >= stage.left-1 && box.right <= stage.right+1 && box.top >= stage.top-1 && box.bottom <= stage.bottom+1;
  const rotated = image.dataset.rotated === 'true'; const captionRotated = caption.dataset.rotated === 'true';
  const area = a.width*a.height, uprightArea=width*height*uprightMaximum**2;
  return { rotated, captionRotated, placement: dialog.querySelector('.figure-stage').dataset.captionPlacement,
    area, uprightArea, captionScrollable: caption.scrollHeight > caption.clientHeight+1,
    fits: contains(a) && (caption.hidden || contains(b)),
    separate: caption.hidden || a.right <= b.left+1 || b.right <= a.left+1 || a.bottom <= b.top+1 || b.bottom <= a.top+1,
    // CSS edges are quantized to subpixels before their areas are multiplied.
    spaceOptimized: area >= uprightArea-Math.max(2,uprightArea*.0002) && (!captionRotated || area > uprightArea+1),
    aspectPreserved: Math.abs((rotated ? a.height/a.width : a.width/a.height) - width/height) < .01 };
}
