import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import { createApp } from '../server/app.js';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { scannedPdfFixture } from '../test/fixtures/pdfs.mjs';

const dir = path.resolve(process.env.PDF_RESULTS || 'test-results/pdf-orientation');
await mkdir(dir, { recursive: true });
const bundle = path.join(dir,'bundle');
const entry = path.join(dir,'entry.js');
await writeFile(entry,`export { PdfDocument } from ${JSON.stringify(path.resolve('src/pdf.js'))}; export { pdfAnchor, restorePdfAnchor } from ${JSON.stringify(path.resolve('src/pdf-layout.js'))};`);
await build({ build:{outDir:bundle,emptyOutDir:true,lib:{entry,formats:['es'],fileName:()=> 'orientation.js'}} });
const server = createApp({distDir:bundle}).listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const cache = path.join(os.homedir(), '.cache/ms-playwright');
const candidates = [process.env.CHROME_PATH, chromium.executablePath(), ...(await readdir(cache))
  .filter(name => /^chromium-\d+$/.test(name)).map(name => path.join(cache, name, 'chrome-linux/chrome'))].filter(Boolean);
const executablePath = (await Promise.all(candidates.map(async file => { try { await access(file); return file; } catch { return null; } }))).find(Boolean);
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext(); const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__pdf-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>PDF orientation regression</title>' }));
  await page.goto(`http://127.0.0.1:${server.address().port}/__pdf-test`);
  const rgb = await page.evaluate(async () => {
    window.pdfAnchors = await import('/orientation.js');
    window.PdfDocument = pdfAnchors.PdfDocument;
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 800;
    const c = canvas.getContext('2d'); c.fillStyle = 'white'; c.fillRect(0, 0, 600, 800);
    c.fillStyle = 'black'; c.font = '16px serif'; c.fillText('218', 50, 40);
    c.save(); c.translate(0, 800); c.rotate(-Math.PI/2); c.font = '20px serif';
    c.fillText('Table 1: Estimated industrial production by sector', 65, 140);
    c.font = '18px serif'; c.fillText('Industry sector', 65, 205); c.fillText('First year', 400, 205); c.fillText('Second year', 570, 205);
    ['Chemical products', 'Petroleum refining', 'Electrical equipment', 'Transport equipment', 'Machinery production', 'Textile manufacturing']
      .forEach((text, i) => { c.fillText(text, 65, 250+i*32); c.fillText(`${40+i}`, 430, 250+i*32); c.fillText(`${50+i}`, 610, 250+i*32); });
    for (const y of [165, 218, 430]) { c.beginPath(); c.moveTo(65, y); c.lineTo(740, y); c.stroke(); }
    c.restore();
    const rgba = c.getImageData(0,0,600,800).data; const rgb = new Uint8Array(600*800*3);
    for(let i=0;i<600*800;i++) rgb.set(rgba.subarray(i*4,i*4+3),i*3);
    let str='';for(let i=0;i<rgb.length;i+=8192)str+=String.fromCharCode(...rgb.subarray(i,i+8192));
    return btoa(str);
  });
  const bytes = scannedPdfFixture(600,800,Buffer.from(rgb,'base64')).toString('base64');
  await context.setOffline(true);
  const result = await page.evaluate(async bytes => {
    let saved; const cache = { read: async () => saved, write: async (_key,value) => { saved=JSON.parse(JSON.stringify(value)); return true; } };
    const first = new PdfDocument({ preparationCache: cache }); const layout = await first.open(bytes,'auto');
    const table = layout.blocks.find(b => b.kind === 'figure' && b.turn);
    if (!table) throw new Error('Sideways scan did not become an upright table.');
    const { pdfAnchor, restorePdfAnchor } = pdfAnchors;
    const anchor = pdfAnchor(layout,table.y); const expected = restorePdfAnchor(layout,anchor);
    const image = (await first.draw(table.y,table.drawHeight)).toDataURL();
    const masks = [...first.marginMasks.values()].flat().length;
    await first.destroy();
    const second = new PdfDocument({ preparationCache: cache }); const restored = await second.open(bytes,'auto');
    const restoredY = restorePdfAnchor(restored,anchor); const restoredTable=restored.blocks.find(b=>b.kind==='figure'&&b.turn);
    const restoredImage = (await second.draw(restoredTable.y,restoredTable.drawHeight)).toDataURL();
    const result = { cached: second.progress.cached, turn: table.turn, width: table.width, height: table.height,
      sourceText:table.text, images:layout.blocks.filter(b=>!b.reflow).length,masks,expected,restoredY,image,restoredImage };
    await second.destroy();return result;
  }, bytes);
  assert.equal(result.turn,90); assert.ok(result.width>result.height*1.5);
  assert.match(result.sourceText,/Chemical products/); assert.ok(result.masks>0,'upright folio is removed before rotating the page');
  assert.equal(result.images,1,'the complete grid stays together'); assert.equal(result.cached,true);
  assert.equal(result.expected,result.restoredY); assert.equal(result.image,result.restoredImage,'cached rotated tiles render identically');
  assert.deepEqual(errors,[]);
  await writeFile(path.join(dir,'upright-table.png'),Buffer.from(result.image.split(',')[1],'base64'));
  const { image,restoredImage,...stats }=result;
  await writeFile(path.join(dir,'result.json'),JSON.stringify({passed:true,...stats},null,2));
  console.log('PASS: offline scanned table rotates, stays together, removes folio, and restores cached pixels/bookmarks.');
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
