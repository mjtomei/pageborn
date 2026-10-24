// Runs against the actual phone gallery after the corpus harness has prepared
// its PDF and restored reviewLayout through the durable preparation cache.
import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectPdfGallery } from './pdf-gallery-check.mjs';

export async function reviewPdfGallery(page, dir, expected = {}) {
  const result = await page.evaluate(async () => {
    const { pdfGalleryItems } = await import('/src/pdf-captions.js');
    const items = pdfGalleryItems(window.reviewLayout);
    return { items: items.map(item => ({ id: item.id, title: item.title, caption: item.caption, page: item.page,
      crop: [item.block.x, item.block.sourceY, item.block.width, item.block.height], text: item.block.text })),
      unmatchedCaptions: reviewLayout.blocks.filter(block => block.annotation?.kind === 'caption' && !block.figureId)
        .map(block => ({ page: block.page, text: block.text })),
      issues: reviewLayout.blocks.flatMap((block, i, blocks) => block.annotation?.kind === 'caption' && block.figureId
        && blocks[i-1]?.figureId !== block.figureId ? [{ kind: 'separated-caption', page: block.page, reference: block.annotation.reference }] : []),
      rotations: [], renders: [] };
  });
  for (const title of expected.references || []) {
    const count = result.items.filter(item => item.title === title).length;
    if (count !== 1) result.issues.push({ kind: 'expected-caption', title, count });
  }
  if (expected.count != null && result.items.length !== expected.count) result.issues.push({ kind: 'gallery-count', expected: expected.count, actual: result.items.length });
  await page.setViewportSize({ width: 390, height: 844 });
  const thumbnails = page.locator('#pdf-gallery .figure-thumbnail');
  await expect(thumbnails).toHaveCount(result.items.length);
  const screenshotKinds = new Set();
  for (let start = 0; start < result.items.length; start += 9) {
    await page.evaluate(() => {
      window.gallerySheet = document.createElement('canvas'); gallerySheet.width = 1200; gallerySheet.height = 1500;
      const c = gallerySheet.getContext('2d'); c.fillStyle = '#e6e6e6'; c.fillRect(0, 0, 1200, 1500);
    });
    for (let i = start; i < Math.min(start + 9, result.items.length); i++) {
      await thumbnails.nth(i).click();
      await expect(page.locator('#figure-dialog canvas')).toHaveCount(1, { timeout: 30000 });
      await expect(page.locator('.figure-stage')).toHaveAttribute('aria-busy', 'false');
      const render = await page.evaluate(({ i, slot, item }) => {
        const stage = document.querySelector('.figure-stage').getBoundingClientRect();
        const image = document.querySelector('.figure-image'); const box = image.getBoundingClientRect();
        const canvas = image.querySelector('canvas');
        const rotated = image.dataset.rotated === 'true';
        const pixels = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
        let ink = 0; for (let p = 0; p < pixels.length; p += 4) if (pixels[p] < 220 && pixels[p+3] > 0) ink++;
        const c = gallerySheet.getContext('2d'); const x = slot % 3 * 400; const y = Math.floor(slot/3)*500;
        c.fillStyle = '#111'; c.font = '16px sans-serif'; c.fillText(`${i+1}: ${item.title} / p${item.page} / ${rotated?'90°':'0°'}`,x+12,y+23);
        c.save(); c.translate(x+200,y+225); if (rotated) c.rotate(Math.PI/2);
        const scale = Math.min((rotated?365:376)/canvas.width,(rotated?376:365)/canvas.height);
        c.drawImage(canvas,-canvas.width*scale/2,-canvas.height*scale/2,canvas.width*scale,canvas.height*scale); c.restore();
        let line = ''; let row = 0; c.font = '14px sans-serif';
        for (const word of (item.caption || '[No caption detected]').split(/\s+/)) {
          if (c.measureText(`${line} ${word}`).width > 372) { c.fillText(line,x+12,y+432+row*17); line=''; if(++row>=4) break; }
          line += `${line?' ':''}${word}`;
        }
        if(row<4)c.fillText(line,x+12,y+432+row*17);
        return { i, rotated, width: canvas.width, height: canvas.height, ink,
          fits: box.left >= stage.left-1 && box.right <= stage.right+1 && box.top >= stage.top-1 && box.bottom <= stage.bottom+1,
          captionMatches: document.querySelector('.figure-caption').textContent === item.caption };
      }, { i, slot: i-start, item: result.items[i] });
      Object.assign(render, await page.evaluate(inspectPdfGallery, { width: result.items[i].crop[2], height: result.items[i].crop[3] }));
      result.renders.push(render);
      if (!render.spaceOptimized || !render.fits || !render.separate || !render.aspectPreserved || !render.captionMatches || render.ink < 10) result.issues.push(render);
      if (render.rotated) result.rotations.push(i);
      const kind = render.rotated ? 'wide' : 'upright';
      if (!screenshotKinds.has(kind)) { await page.screenshot({ path: path.join(dir,`gallery-${kind}.png`) }); screenshotKinds.add(kind); }
      await page.locator('.figure-close').click();
    }
    const data = await page.evaluate(() => gallerySheet.toDataURL());
    await writeFile(path.join(dir,`gallery-${start}.png`),Buffer.from(data.split(',')[1],'base64'));
    await page.evaluate(() => { gallerySheet.width=gallerySheet.height=1; delete window.gallerySheet; });
  }
  await writeFile(path.join(dir,'gallery.json'),JSON.stringify(result,null,2));
  return { items: result.items.length, rotated: result.rotations.length, issues: result.issues,
    unmatchedCaptions: result.unmatchedCaptions, uncaptained: result.items.filter(item=>!item.caption).length };
}
