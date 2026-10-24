import { chromium, webkit, expect } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';
import { showLibrary, waitForPdfReady } from './ui-helpers.mjs';
import { inspectPdfGallery } from './pdf-gallery-check.mjs';

process.env.PAGEBORNE_ASK_ORIGINS = '';
const vite = await createServer({ cacheDir: '.state/vite-pdf-gallery', server: { host: '127.0.0.1', port: 0, hmr: false }, clearScreen: false });
await vite.listen();
const out = process.env.PDF_GALLERY_RESULTS || 'test-results/pdf-gallery'; await mkdir(out, { recursive: true });
const results = [];
try {
  for (const engine of [chromium, webkit].filter(engine => !process.env.GALLERY_BROWSER || engine.name() === process.env.GALLERY_BROWSER)) {
    const browser = await engine.launch({ executablePath: engine === chromium ? '/usr/bin/google-chrome' : process.env.WEBKIT_PATH, headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const result = { engine: engine.name(), errors: [], passed: false }; results.push(result);
    page.on('pageerror', error => result.errors.push(error.message));
    if (process.env.PDF_GALLERY_TRACE) {
      page.on('console', message => { if (message.text().startsWith('PDF checkpoint')) console.log(engine.name(), message.text()); });
      await page.addInitScript(() => {
        const setItem = Storage.prototype.setItem; let last;
        Storage.prototype.setItem = function(key, value) {
          if (key === 'even-reader:diagnostics:v1') {
            const pdf = JSON.parse(value).pdf;
            const checkpoint = pdf && JSON.stringify({ stage: pdf.stage, page: pdf.page, cached: pdf.cached });
            if (checkpoint && checkpoint !== last) { console.log('PDF checkpoint', checkpoint); last = checkpoint; }
          }
          return setItem.call(this, key, value);
        };
      });
    }
    try {
      await page.goto(vite.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled();
      await page.locator('#file-picker').setInputFiles([
        { name: 'gallery.pdf', mimeType: 'application/pdf', buffer: pdfFixture('annotations') },
        { name: 'plain.md', mimeType: 'text/markdown', buffer: Buffer.from('# Plain document\n\nReading text.') },
      ]);
      await expect(page.locator('#doc-count')).toHaveText('2');
      await page.locator('[data-document-id="gallery.pdf"] .document-card').click(); await waitForPdfReady(page);
      const gallery = page.locator('#pdf-gallery'); const thumbs = gallery.locator('button'); const modal = page.locator('#figure-dialog');
      await expect(thumbs).toHaveCount(1); await gallery.scrollIntoViewIfNeeded();
      await expect(thumbs.first().locator('canvas')).toHaveCount(1);
      await expect(thumbs.first().locator('canvas')).toHaveCSS('filter', 'none');
      await expect(thumbs.first().locator('canvas')).toHaveCSS('aspect-ratio', 'auto');
      await expect(thumbs.first()).toContainText('CaptionText');
      const position = await page.locator('#position').inputValue();
      await thumbs.first().click(); await expect(modal).toBeVisible(); await expect(modal.locator('canvas')).toHaveCount(1);
      await expect(modal.locator('.figure-caption')).toContainText('CaptionText');
      await expect(modal.locator('.figure-image')).toHaveAttribute('data-rotated', 'true');
      const fitCheck = () => page.evaluate(() => {
        const stage = document.querySelector('.figure-stage').getBoundingClientRect();
        const image = document.querySelector('.figure-image').getBoundingClientRect();
        return image.left >= stage.left - 1 && image.right <= stage.right + 1 && image.top >= stage.top - 1 && image.bottom <= stage.bottom + 1;
      });
      assert(await fitCheck()); await page.screenshot({ path: `${out}/${engine.name()}-fullscreen.png` });
      await page.keyboard.press('ArrowRight'); assert.equal(await page.locator('#position').inputValue(), position);
      await modal.locator('.figure-close').click(); await expect(modal).toBeHidden(); await expect(thumbs.first()).toBeFocused();
      await expect(modal.locator('canvas')).toHaveCount(0);
      await page.reload(); await waitForPdfReady(page);
      const cached = await page.evaluate(() => JSON.parse(localStorage.getItem('even-reader:diagnostics:v1')).pdf.cached);
      assert.equal(cached, true); await expect(thumbs.first()).toContainText('CaptionText');
      await showLibrary(page); await page.locator('[data-document-id="plain.md"] .document-card').click();
      await expect(gallery).toBeHidden(); await expect(thumbs).toHaveCount(0);

      if (process.env.PDF_GALLERY_FILE) {
        await showLibrary(page); await page.locator('#file-picker').setInputFiles(process.env.PDF_GALLERY_FILE);
        await expect(page.locator('#doc-count')).toHaveText('3');
        await page.locator('.document-card').filter({ hasText: /minicpm/i }).first().click(); await waitForPdfReady(page, 120000);
        await gallery.scrollIntoViewIfNeeded(); await expect(thumbs).toHaveCount(19);
        for (const name of ['Figure 1', 'Figure 6', 'Table 1', 'Table 10', 'Table 13']) await expect(thumbs.filter({ has: page.locator('.figure-thumb-title', { hasText: new RegExp(`^${name}$`) }) })).toHaveCount(1);
        result.figures = await thumbs.count();
        await thumbs.nth(1).click(); await expect(modal.locator('canvas')).toHaveCount(1); assert(await fitCheck());
        await page.screenshot({ path: `${out}/${engine.name()}-minicpm-wide.png` });
        await modal.locator('.figure-close').click();
        await thumbs.last().click(); await expect(modal.locator('canvas')).toHaveCount(1);
        await expect(modal.locator('.figure-image')).toHaveAttribute('data-rotated', 'false'); assert(await fitCheck());
        await page.screenshot({ path: `${out}/${engine.name()}-minicpm-tall.png` });
        await modal.locator('.figure-close').click();
        await expect.poll(() => gallery.locator('canvas').count()).toBeLessThan(6);
        await page.screenshot({ path: `${out}/${engine.name()}-minicpm-gallery.png` });
        await page.reload(); await waitForPdfReady(page); await expect(thumbs).toHaveCount(19);
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('even-reader:diagnostics:v1')).pdf.cached), true);
        await thumbs.filter({ has: page.locator('.figure-thumb-title', { hasText: /^Table 1$/ }) }).click();
        await expect(modal.locator('canvas')).toHaveCount(1); await expect(modal.locator('.figure-caption')).toHaveText('Table 1: Ablation of full-duplex design choices.');
        await page.screenshot({ path: `${out}/${engine.name()}-minicpm-table-header.png` });
        await modal.locator('.figure-close').click();
        for (const [width, height] of [[320, 700], [1400, 1000]]) {
          await page.setViewportSize({ width, height }); await gallery.scrollIntoViewIfNeeded();
          const below = await page.evaluate(() => document.querySelector('#pdf-gallery').getBoundingClientRect().top >= document.querySelector('#pdf-passage').getBoundingClientRect().bottom - 1);
          assert(below, 'gallery stays below Read from here');
          await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await thumbs.first().click(); await expect(modal.locator('canvas')).toHaveCount(1); assert(await fitCheck());
          await modal.locator('.figure-close').click();
          await page.screenshot({ path: `${out}/${engine.name()}-gallery-${width}.png` });
        }
      }
      // Exercise partial-layout replacement and cancellation through the actual
      // component with deterministic, slow raster work. A late tile must never
      // resurrect a closed document or replace the newly selected figure.
      result.partial = await page.evaluate(async () => {
        const { PdfGallery } = await import('/src/pdf-gallery.js');
        const element = document.querySelector('#pdf-gallery').cloneNode(true); element.querySelector('.figure-strip').replaceChildren();
        const dialog = document.querySelector('#figure-dialog').cloneNode(true); dialog.removeAttribute('open'); dialog.querySelector('.figure-image').replaceChildren();
        element.id = 'test-gallery'; dialog.id = 'test-figure-dialog'; document.body.append(element, dialog);
        const view = new PdfGallery(element, dialog); const identity = {};
        const block = (id, width = 600) => ({ kind: 'figure', figureId: id, page: 1, x: 0, sourceY: 0, width, height: 200, lines: [], text: '', figureCaption: { reference: id, text: `${id} full caption` } });
        const a = block('Figure A'); const b = block('Figure B');
        let complete; const delayed = new Promise(resolve => complete = resolve);
        const pdf = { async drawFigure() { await delayed; const c = document.createElement('canvas'); c.width = 200; c.height = 100; return c; } };
        view.setLayout({ format: 'pdf', document: identity, blocks: [a], pdf });
        const retained = element.querySelector('button');
        const opening = view.open('Figure A');
        view.setLayout({ format: 'pdf', document: identity, blocks: [b, a], pdf });
        const same = element.querySelectorAll('button')[1] === retained && dialog.open;
        const ordered = [...view.items.keys()].join(',') === 'Figure B,Figure A';
        const latest = view.open('Figure B'); complete(); await Promise.all([opening, latest]);
        const latestOnly = dialog.querySelectorAll('canvas').length === 1 && dialog.querySelector('.figure-title').textContent.startsWith('Figure B');
        view.setLayout(null);
        const closed = !dialog.open && !element.querySelector('canvas') && !dialog.querySelector('canvas') && element.hidden;
        element.remove(); dialog.remove();
        return { same, ordered, latestOnly, closed };
      });
      assert.deepEqual(result.partial, { same: true, ordered: true, latestOnly: true, closed: true });
      // Use the real full-screen dialog and actual font metrics to check each
      // caption arrangement, long scrollable captions and resizing while open.
      await page.evaluate(async () => {
        const { PdfGallery } = await import('/src/pdf-gallery.js');
        const element = document.querySelector('#pdf-gallery').cloneNode(true); element.id='layout-gallery';
        element.querySelector('.figure-strip').replaceChildren(); document.body.append(element);
        const dialog = document.querySelector('#figure-dialog');
        window.layoutGallery = new PdfGallery(element, dialog);
        const pdf = { async drawFigure(block) {
          const c = document.createElement('canvas'); c.width=block.width; c.height=block.height;
          const ctx=c.getContext('2d'); ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);
          ctx.strokeStyle='#111';ctx.lineWidth=5;ctx.strokeRect(3,3,c.width-6,c.height-6);
          ctx.fillStyle='#111';ctx.font='30px sans-serif';ctx.fillText('Figure contents',20,50); return c;
        } };
        const specs=[['wide',900,300,'Figure 1: A short caption describing this wide figure.'],
          ['square',600,500,'Figure 2: A caption that stays below the figure.'],
          ['tall',200,800,'Table 1: A tall table with a short caption.'],
          ['long',900,300,'Figure 3: '+('A lengthy but fully accessible caption. '.repeat(100))],['none',900,300,'']];
        layoutGallery.setLayout({format:'pdf',document:{},pdf,blocks:specs.map(([id,width,height,text])=>({
          figureId:id,kind:'figure',width,height,page:1,figureCaption:{reference:id,text}}))});
      });
      result.arrangements=[];
      for (const [width,height,font] of [[390,844,16],[320,700,20],[1000,650,16]]) {
        await page.setViewportSize({width,height});
        await page.evaluate(font=>document.documentElement.style.fontSize=`${font}px`,font);
        for (const id of ['wide','square','tall','long','none']) {
          const size = await page.evaluate(async id => {
            await layoutGallery.open(id); const {width,height}=layoutGallery.items.get(id).block; return {width,height};
          },id);
          const check = await page.evaluate(inspectPdfGallery,size);
          assert(check.fits && check.separate && check.spaceOptimized && check.aspectPreserved,`${id} at ${width}px: ${JSON.stringify(check)}`);
          if(width===390) {
            if(id==='wide') assert(check.captionRotated);
            if(id==='square') assert.equal(check.placement,'below');
            if(id==='tall') assert.equal(check.placement,'beside');
            if(id==='long') {
              assert(check.captionScrollable);
              assert(await page.locator('.figure-caption').evaluate(el=>{el.scrollTop=el.scrollHeight;return el.scrollTop>0;}));
            }
            if(id!=='none') await page.screenshot({path:`${out}/${engine.name()}-caption-${id}.png`});
          }
          result.arrangements.push({id,viewport:width,font,...check});
        }
      }
      await page.evaluate(()=>{ layoutGallery.close();layoutGallery.setLayout(null);layoutGallery.element.remove(); });
      assert.deepEqual(result.errors, []); result.passed = true;
    } catch (error) { result.error = error.stack; await page.screenshot({ path: `${out}/${engine.name()}-failure.png` }).catch(() => {}); }
    finally { await browser.close(); console.log(JSON.stringify(result)); }
  }
} finally { await vite.close(); await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2)); }
if (results.some(result => !result.passed)) process.exitCode = 1;
