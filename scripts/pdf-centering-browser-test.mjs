import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import { createApp } from '../server/app.js';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';

const dir = path.resolve('test-results/pdf-centering'); await mkdir(dir, { recursive: true });
const bundle = path.join(dir, 'bundle'); const entry = path.join(dir, 'entry.js');
await writeFile(entry, `export { PdfDocument } from ${JSON.stringify(path.resolve('src/pdf.js'))};`);
await build({ build: { outDir: bundle, emptyOutDir: true, lib: { entry, formats: ['es'], fileName: () => 'centering.js' } } });
const server = createApp({ distDir: bundle }).listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const cache = path.join(os.homedir(), '.cache/ms-playwright');
const candidates = [process.env.CHROME_PATH, chromium.executablePath(), ...(await readdir(cache))
  .filter(name => /^chromium-\d+$/.test(name)).flatMap(name => [path.join(cache, name, 'chrome-linux/chrome'), path.join(cache, name, 'chrome-linux64/chrome')])].filter(Boolean);
const executablePath = (await Promise.all(candidates.map(async file => { try { await access(file); return file; } catch { return null; } }))).find(Boolean);
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const result = { passed: false, samples: [], errors: [] };
try {
  const context = await browser.newContext(); const page = await context.newPage();
  page.on('pageerror', error => result.errors.push(error.message));
  await page.route('**/__pdf-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>PDF centering regression</title>' }));
  await page.goto(`http://127.0.0.1:${server.address().port}/__pdf-test`);
  await page.evaluate(async () => { window.PdfDocument = (await import('/centering.js')).PdfDocument; });
  await context.setOffline(true);
  for (const kind of ['mixed', 'equation', 'figure']) {
    const sample = await page.evaluate(async ({ kind, bytes }) => {
      const bounds = canvas => {
        const { width, height } = canvas; const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
        let x0 = width, y0 = height, x1 = -1, y1 = -1;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4] > 48) {
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
        return { left: x0, right: width - x1 - 1, top: y0, bottom: height - y1 - 1, width: x1 - x0 + 1, height: y1 - y0 + 1 };
      };
      let saved; const cache = { read: async () => saved, write: async (_key, value) => { saved = JSON.parse(JSON.stringify(value)); return true; } };
      const pdf = new PdfDocument({ preparationCache: cache }); const layout = await pdf.open(bytes, 'auto');
      const image = layout.blocks.find(block => !block.reflow && (kind === 'equation' ? block.text.includes('x^2') : block.kind === 'figure'));
      if (!image) throw new Error(`Missing ${kind} image`);
      const endAt = image.y + image.drawHeight;
      const raw = await pdf.draw(image.y, 258, true, { paging: true, endAt });
      const centered = await pdf.draw(image.y, 258, true, { paging: true, endAt, centerImages: true });
      const scroll = await pdf.draw(image.y + 27, 258, true, { endAt, centerImages: true });
      const scrollRaw = await pdf.draw(image.y + 27, 258, true, { endAt });
      const unchangedPreview = await pdf.draw(image.y, 258, true, { paging: true, endAt });
      const output = { kind, drawHeight: image.drawHeight, rasterKind: image.kind, before: bounds(raw), after: bounds(centered),
        centered: centered.toDataURL(), raw: raw.toDataURL(), scroll: scroll.toDataURL(), scrollRaw: scrollRaw.toDataURL(),
        previewUnchanged: raw.toDataURL() === unchangedPreview.toDataURL(), originalGeometry: [image.x, image.sourceY, image.width, image.height] };
      await pdf.destroy();
      const second = new PdfDocument({ preparationCache: cache }); const restored = await second.open(bytes, 'auto');
      const cachedImage = restored.blocks.find(block => !block.reflow && (kind === 'equation' ? block.text.includes('x^2') : block.kind === 'figure'));
      output.cached = second.progress.cached;
      output.restored = (await second.draw(cachedImage.y, 258, true, { paging: true, endAt: cachedImage.y + cachedImage.drawHeight, centerImages: true })).toDataURL();
      await second.destroy(); return output;
    }, { kind, bytes: pdfFixture(kind).toString('base64') });
    assert.ok(sample.after.width > 0); assert.ok(sample.previewUnchanged); assert.ok(sample.cached);
    assert.equal(sample.restored, sample.centered, 'cached preparations get identical centered rendering');
    if (kind === 'figure') {
      assert.ok(sample.drawHeight > 258); assert.equal(sample.centered, sample.raw, 'tall figure starts unchanged');
      assert.equal(sample.scroll, sample.scrollRaw, 'tall figure scroll is unchanged');
      assert.notEqual(sample.scroll, sample.centered, 'scrolling a tall figure still moves it');
    } else {
      assert.ok(sample.drawHeight < 258); assert.ok(sample.after.top > 20);
      assert.ok(Math.abs(sample.after.left - sample.after.right) <= 6, `horizontal margins: ${JSON.stringify(sample.after)}`);
      assert.ok(Math.abs(sample.after.top - sample.after.bottom) <= 6, `vertical margins: ${JSON.stringify(sample.after)}`);
      assert.equal(sample.scroll, sample.centered, 'short image stays intact during its autoscroll interval');
      assert.equal(sample.after.width, sample.before.width, 'scale preserved');
      assert.equal(sample.after.height, sample.before.height, 'all pixels preserved');
    }
    for (const name of ['raw', 'centered']) await writeFile(path.join(dir, `${kind}-${name}.png`), Buffer.from(sample[name].split(',')[1], 'base64'));
    const { centered, raw, scroll, scrollRaw, restored, ...stats } = sample; result.samples.push(stats);
  }
  assert.deepEqual(result.errors, []); result.passed = true;
  console.log('PASS: real figure/equation pixels centered; tall scroll, scale, source geometry, continuous preview and cached rendering preserved.');
} finally {
  await writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
