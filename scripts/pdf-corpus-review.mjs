// Local, private corpus review. Usage: node scripts/pdf-corpus-review.mjs manifest.json output-dir
// The manifest is [{id,file}]; documents and extracted content stay in the ignored output directory.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir, readFile, writeFile, access, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chooseMode } from './ui-helpers.mjs';
import { reviewPdfGallery } from './pdf-gallery-review.mjs';
const [manifest, output = 'test-results/pdf-corpus-review'] = process.argv.slice(2);
if (!manifest) throw new Error('Provide a local PDF manifest JSON file.');
const samples = JSON.parse(await readFile(manifest, 'utf8')).filter(s => !process.env.SAMPLE || process.env.SAMPLE.split(',').includes(s.id));
const root = path.resolve(output); await mkdir(root, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false }, clearScreen: false }); await server.listen();
const cache = path.join(os.homedir(), '.cache/ms-playwright');
const cached = (await readdir(cache)).filter(name => /^chromium-\d+$/.test(name));
const candidates = [process.env.CHROME_PATH, chromium.executablePath(), ...cached.flatMap(name => [path.join(cache, name, 'chrome-linux/chrome'), path.join(cache, name, 'chrome-linux64/chrome')])].filter(Boolean);
const executablePath = (await Promise.all(candidates.map(async p => { try { await access(p); return p; } catch { return null; } }))).find(Boolean);
const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] }); const results = [];
try {
  for (const sample of samples) {
    const dir = path.join(root, sample.id); await mkdir(dir, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    const start = Date.now(); const result = { ...sample, errors };
    console.log(`START ${sample.id}`);
    try {
      await page.goto(server.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled();
      await page.locator('#file-picker').setInputFiles(sample.file);
      await expect(page.locator('#doc-count')).toHaveText('1', { timeout: 60000 });
      await page.locator('.document-card').first().click();
      await page.waitForFunction(() => (!document.querySelector('#bookmark').disabled && JSON.parse(localStorage.getItem('even-reader:diagnostics:v1') || '{}').pdf?.stage === 'ready') || /Could not open PDF:|remaining PDF pages could not/.test(document.querySelector('#notice-text').textContent), null, { timeout: 900000 });
      if (await page.locator('#bookmark').isDisabled()) throw new Error(await page.locator('#notice-text').textContent());
      result.openMs = Date.now() - start;
      await page.locator('#preview').screenshot({ path: path.join(dir, 'app-opening.png') });
      // Open the prepared result through the same durable cache the phone UI wrote.
      const audit = await page.evaluate(async () => {
        const { PdfDocument } = await import('/src/pdf.js');
        const { LocalLibrary } = await import('/src/library.js');
        const { PdfPreparationCache, browserPdfStorage } = await import('/src/pdf-cache.js');
        const { pdfNativeWindow } = await import('/src/pdf-native.js');
        const { pdfReadingViews } = await import('/src/pdf-notes.js');
        const { pdfPageTurn } = await import('/src/pdf-layout.js');
        const { SpeedReading } = await import('/src/speed-reading.js');
        const { byteLength, TEXT_BYTES, measureNativeText } = await import('/src/native-text.js');
        const library = new LocalLibrary(); const item = (await library.read()).documents[0];
        window.reviewPdf = new PdfDocument({ preparationCache: new PdfPreparationCache(browserPdfStorage(library)).forDocument(item.id) });
        const full = await reviewPdf.open(item.content, 'auto');
        const { body: layout, notes } = pdfReadingViews(full); window.reviewLayout = layout;
        const blocks = layout.blocks.map(({ reflow, ...b }) => ({ ...b, reflow: reflow ? { ...reflow, rows: reflow.rows.map(({ items, ...r }) => r) } : null }));
        const covered = new Set(); let y = 0; let screens = 0; const navigationIssues = [];
        for (; screens < 100000; screens++) {
          const run = layout.nativeRuns.findIndex(r => y >= r.start && y < r.end);
          const frame = pdfNativeWindow(layout, y);
          if (frame) {
            if (byteLength(frame.content) > TEXT_BYTES) navigationIssues.push({ kind: 'byte-limit', y });
            for (let row = frame.start; row < frame.end; row++) covered.add(`${run}:${row}`);
          }
          if (y >= layout.maxY) break;
          const next = pdfPageTurn(layout, y, 1);
          if (next <= y) { navigationIssues.push({ kind: 'stuck-page', y }); break; }
          y = next;
        }
        for (const [run, r] of layout.nativeRuns.entries()) for (const [row, line] of r.rows.entries()) {
          if (line.text.trim() && !covered.has(`${run}:${row}`)) navigationIssues.push({ kind: 'unreachable-row', run, row, y: line.y, text: line.text });
          if (measureNativeText(line.text) > 553) navigationIssues.push({ kind: 'wide-native-row', y: line.y, text: line.text });
        }
        const speed = new SpeedReading(); speed.load(layout); const headings = [];
        for (const entry of speed.entries) if (entry.heading && !headings.includes(entry.heading)) headings.push(entry.heading);
        const suspects = [];
        for (const [i,b] of blocks.entries()) {
          if (!b.reflow && /\p{L}/u.test(b.text) && b.text.length > 180) suspects.push({ i, kind: 'image-with-prose', page: b.page, text: b.text.slice(0, 160) });
          if (!b.reflow && (b.height < 25 || /^\s*\d{1,4}\s*$/.test(b.text))) suspects.push({ i, kind: 'small-image', page: b.page, text: b.text });
          if (b.annotation?.kind === 'footnote' && b.text.length > 1800) suspects.push({ i, kind: 'long-footnote', page: b.page, text: b.text.slice(0, 180) });
          if (b.reflow && (b.text.match(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/g) || []).length > 2) suspects.push({ i, kind: 'broken-text', page: b.page, text: b.text.slice(0, 200) });
        }
        return { layout: { blocks, maxY: layout.maxY, height: layout.height }, pages: reviewPdf.pdf.numPages,
          cached: reviewPdf.progress.cached, warnings: reviewPdf.warnings, navigationIssues, screens,
          headings: headings.map(({content,...h})=>h), suspects,
          native: blocks.filter(b=>b.reflow).length, images: blocks.filter(b=>!b.reflow).length,
          notes: notes?.blocks.filter(b=>!b.annotationLabel).length || 0,
          bracketedReferences: blocks.flatMap(b=>b.reflow?.rows||[]).reduce((n,row)=>n+(row.text.match(/\[\d{1,3}\]/g)||[]).length,0),
          noteText: notes?.blocks.flatMap(b=>b.reflow?.rows.map(row=>row.text)||[]).join('\n') || '' };
      });
      const { layout, ...stats } = audit; Object.assign(result, stats);
      await writeFile(path.join(dir, 'layout.json'), JSON.stringify(layout));
      await writeFile(path.join(dir, 'flow.txt'), layout.blocks.map((b,i) => `[${i} | PDF ${b.page} | ${b.reflow ? 'TEXT' : 'IMAGE'}${b.annotation ? ' | '+b.annotation.label+' | section '+b.annotation.section : ''} | source ${Math.round(b.x)},${Math.round(b.sourceY)}]\n${b.reflow?.text || b.text}\n`).join('\n'));
      if (process.env.PDF_REVIEW_GALLERY) result.gallery = await reviewPdfGallery(page, dir, sample.gallery);
      const images = layout.blocks.flatMap((b,i)=>!b.reflow?[i]:[]);
      const sampledImages = process.env.PDF_REVIEW_ALL_IMAGES ? images : [...new Set([...images.filter((_,i)=> i<3 || i>=images.length-2 || i%Math.max(1,Math.floor(images.length/10))===0), ...audit.suspects.filter(s=>s.kind==='small-image'||s.kind==='broken-text').slice(0,8).map(s=>s.i)])].slice(0,24);
      const picks = [...new Set([0,Math.floor(layout.blocks.length*.25),Math.floor(layout.blocks.length*.5),Math.floor(layout.blocks.length*.75),layout.blocks.length-1,
        ...sampledImages.slice(0,4).flatMap(i=>[Math.max(0,i-1),i,Math.min(layout.blocks.length-1,i+1)]),
        ...layout.blocks.flatMap((b,i)=>b.annotation&&!b.annotationLabel?[i]:[]).slice(0,2)])];
      result.sampleBlocks=picks; result.imageBlocks=sampledImages;
      for (const [kind,ids] of [['flow',picks],['images',sampledImages]]) {
        if (!ids.length) continue;
        for(let start=0;start<ids.length;start+=12){
          const data=await page.evaluate(async ({ids,kind})=>{
            const { pdfNativeWindow, pdfImageEnd }=await import('/src/pdf-native.js'); const { paintFrame }=await import('/src/glasses.js');
            const out=document.createElement('canvas');out.width=1200;out.height=Math.ceil(ids.length/2)*330;const c=out.getContext('2d');c.fillStyle='#ddd';c.fillRect(0,0,out.width,out.height);
            for(const [n,i] of ids.entries()){
              const b=reviewLayout.blocks[i];const y=Math.min(b.y,reviewLayout.maxY);let image;
              if(kind==='images')image=await reviewLayout.pdf.draw(b.y,Math.min(1000,b.drawHeight),false,{layout:reviewLayout});
              else {
                const native=pdfNativeWindow(reviewLayout,y);const bitmap=native?null:await reviewLayout.pdf.draw(y,258,true,{layout:reviewLayout,paging:true,endAt:pdfImageEnd(reviewLayout,y)});
                image=document.createElement('canvas');image.width=576;image.height=288;
                paintFrame(image.getContext('2d'),{layout:reviewLayout,y,mode:'page',nativePdf:native,bitmap});
              }
              const x=n%2*600,top=Math.floor(n/2)*330;const scale=Math.min(576/image.width,288/image.height);
              c.fillStyle='#111';c.font='14px sans-serif';c.fillText(`block ${i} / PDF ${b.page} / ${b.reflow?'native':'image'} / source y=${Math.round(b.sourceY)}`,x+10,top+20);c.drawImage(image,x+10,top+32,image.width*scale,image.height*scale);
            }return out.toDataURL();
          },{ids:ids.slice(start,start+12),kind});
          await writeFile(path.join(dir,`${kind}-${start}.png`),Buffer.from(data.split(',')[1],'base64'));
        }
      }
      const sourcePages = process.env.PDF_REVIEW_ALL_IMAGES
        ? [...new Set([...picks.map(i=>layout.blocks[i].page), ...audit.suspects.map(s=>s.page)])]
        : [...new Set(picks.map(i=>layout.blocks[i].page))].slice(0,7);
      for(const number of sourcePages){
        const image=await page.evaluate(async n=>(await reviewPdf.renderPage(n)).canvas.toDataURL(),number);
        await writeFile(path.join(dir,`source-${number}.png`),Buffer.from(image.split(',')[1],'base64'));
      }
      // Exercise actual phone navigation and speed mode for the same imported file.
      await page.locator('#position').evaluate(el => { el.value = '500'; el.dispatchEvent(new Event('input')); });
      await page.locator('#preview').screenshot({path:path.join(dir,'app-middle.png')});
      await chooseMode(page,'speed'); await page.locator('#start').click();
      await page.locator('#preview').screenshot({path:path.join(dir,'app-speed-opening.png')});
      result.passed = errors.length===0 && result.navigationIssues.length===0 && result.cached===true && !result.gallery?.issues.length;
      await page.evaluate(()=>reviewPdf.destroy());
    } catch(error){result.passed=false;result.error=error.stack;}
    finally{
      result.totalMs=Date.now()-start;results.push(result);
      await writeFile(path.join(dir,'result.json'),JSON.stringify(result,null,2));
      await writeFile(path.join(root,'results.json'),JSON.stringify(results,null,2));
      console.log(JSON.stringify({id:sample.id,pages:result.pages,native:result.native,images:result.images,notes:result.notes,issues:result.navigationIssues?.length,suspects:result.suspects?.length,ms:result.totalMs,error:result.error}));
      await context.close();
    }
  }
} finally{await browser.close();await server.close();}
if (results.some(result => !result.passed)) process.exitCode = 1;
