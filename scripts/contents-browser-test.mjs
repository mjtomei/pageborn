import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { displayProbe } from './display-probe.mjs';
import { showLibrary, hideSettings, chooseMode, waitForPdfReady } from './ui-helpers.mjs';
import { contentsPdf } from '../test/fixtures/contents-pdf.mjs';
const out = 'test-results/contents'; await mkdir(out, {recursive:true});
const server = await createServer({mode:'release',cacheDir:'.state/vite-contents-test',server:{host:'127.0.0.1',port:0,hmr:false,watch:null},plugins:[displayProbe(),{name:'contents-fixtures',transform(code,id){
  if(id.endsWith('/src/main.js'))return code.replace('enabled: DEBUG','enabled: true');
  if(id.endsWith('/src/speech-setup.js'))return code.replace('start(initialize) {','start(initialize) { this.blocked = false; return Promise.resolve();');
  if(id.endsWith('/src/pdf.js'))return code.replace('preparePage(number, settings) {','preparePage(number, settings) { if (number >= 4 && globalThis.__holdPdf) return new Promise(resolve => { globalThis.__releasePdf = () => { globalThis.__holdPdf = false; resolve(this.preparePage(number, settings)); }; });');
}}]});
await server.listen();const result={passed:false,errors:[]};
const engine=process.env.CONTENTS_BROWSER==='webkit'?webkit:chromium;
const browser=await engine.launch({headless:true,executablePath:engine===chromium?(process.env.CHROME_PATH||'/usr/bin/google-chrome'):process.env.WEBKIT_PATH});
const page=await browser.newPage({viewport:{width:440,height:806}});
page.on('pageerror',e=>result.errors.push(e.message));
try {
 const storage=new Map();
 await page.exposeFunction('__storage',m=>m.method==='getLocalStorage'?storage.get(m.data.key)||'':(storage.set(m.data.key,m.data.value),true));
 await page.addInitScript(()=>{window.__boxes={};window.flutter_inappwebview={async callHandler(_,payload){const m=JSON.parse(payload);if(m.method.endsWith('LocalStorage'))return window.__storage(m);if(['createStartUpPageContainer','rebuildPageContainer'].includes(m.method)){window.__boxes={};window.__menu=m.data.menuObject?.menuItems;}for(const t of(m.method==='textContainerUpgrade'?[m.data]:m.data?.textObject||[]))window.__boxes[t.containerName]={...window.__boxes[t.containerName],...t};return ['createStartUpPageContainer','updateImageRawData'].includes(m.method)?0:true;}};});
 const event=type=>page.evaluate(eventType=>window.dispatchEvent(new CustomEvent('evenHubEvent',{detail:{sysEvent:{eventType}}})),type);
 const menu=id=>page.evaluate(itemID=>window.dispatchEvent(new CustomEvent('evenHubEvent',{detail:{menuItemClickEvent:{itemID}}})),id);
 const frame=()=>page.evaluate(()=>{const f=window.__displayFrame;return {kind:f?.positionPicker?.kind,index:f?.positionPicker?.index,entries:f?.positionPicker?.entries,y:f?.y,body:window.__boxes.body?.content||'',menu:window.__menu};});
 const open=async name=>{await showLibrary(page);await page.locator(`[data-document-id="${name}"] .document-card`).click();await hideSettings(page);};
 await page.goto(server.resolvedUrls.local[0]);await expect(page.locator('#import')).toBeEnabled();
 const prose='Ordinary prose with enough words to read in several panels. '.repeat(50);
 await page.locator('#file-picker').setInputFiles([
  {name:'headings.md',mimeType:'text/markdown',buffer:Buffer.from(`# Book\n\n${prose}\n\n## Chapter\n\n${prose}\n\n### Subheading\n\n${prose}\n\n###### Deep heading\n\n${prose}`)},
  {name:'plain.txt',mimeType:'text/plain',buffer:Buffer.from(prose)},
  {name:'chapters.pdf',mimeType:'application/pdf',buffer:contentsPdf()},
 ]);
 await open('headings.md');await expect.poll(async()=>(await frame()).menu?.find(i=>i.itemID===8)?.itemName).toBe('Contents');
 for(const mode of ['page','auto','speed']){
  await chooseMode(page,mode);await menu(5);await menu(8);
  await expect.poll(async()=>(await frame()).kind).toBe('contents');
  const before=(await frame()).y;await event(2);await event(2);
  await expect.poll(async()=>(await frame()).index).toBe(2);
  assert.equal((await frame()).y,before);
  const target=(await frame()).entries[2].y;
  await event(9);await event(10);await expect(page.locator('#ask-panel')).toBeHidden();
  await event(3);await expect.poll(async()=>(await frame()).kind).toBeUndefined();assert.equal((await frame()).y,before);
  await menu(8);await event(2);await event(2);await event(0);
  await expect.poll(async()=>(await frame()).kind).toBeUndefined();
  await expect.poll(async()=>(await frame()).y).toBe(target);
 }
 result.markdownModes=true;
 await chooseMode(page,'page');await menu(8);await expect.poll(async()=>(await frame()).kind).toBe('contents');await page.locator('#preview').screenshot({path:out+'/markdown.png'});await event(3);
 await open('plain.txt');await expect.poll(async()=>(await frame()).menu?.find(i=>i.itemID===8)?.itemName).toBe('Go to position');await menu(8);await expect.poll(async()=>(await frame()).body).toContain('% of document');await event(3);result.percentageFallback=true;
 await page.evaluate(()=>{window.__holdPdf=true;});await open('chapters.pdf');
 await expect.poll(()=>page.evaluate(()=>typeof window.__releasePdf),{timeout:30000}).toBe('function');
 await menu(8);await expect.poll(async()=>(await frame()).kind).toBe('contents');
 assert.equal((await frame()).entries.length,2);
 await event(2);await expect.poll(async()=>(await frame()).index).toBe(1);
 await page.evaluate(()=>window.__releasePdf());await waitForPdfReady(page);
 await expect.poll(async()=>(await frame()).entries?.length).toBe(3);
 assert.equal((await frame()).entries[1].title,'Detailed subsection');assert.equal((await frame()).index,1);
 await event(0);await expect.poll(async()=>(await frame()).kind).toBeUndefined();
 await expect.poll(()=>page.evaluate(()=>{const f=window.__displayFrame;return f.layout.blocks.findLast(b=>b.y<=f.y)?.page;})).toBe(2);
 result.partialLoadingAndPreciseDestination=true;
 await menu(8);await event(2);await event(0);
 await expect.poll(()=>page.evaluate(()=>{const f=window.__displayFrame;return f.layout.blocks.findLast(b=>b.y<=f.y)?.page;})).toBe(4);
 await open('plain.txt');await open('chapters.pdf');await waitForPdfReady(page);
 assert.ok(await page.evaluate(()=>JSON.parse(localStorage.getItem('even-reader:diagnostics:v1')).counts['pdf-cache-hit']));
 await menu(8);await expect.poll(async()=>(await frame()).kind).toBe('contents');
 assert.deepEqual((await frame()).entries.map(e=>e.level),[1,2,1]);
 await page.locator('#preview').screenshot({path:out+'/pdf.png'});result.cachedPdf=true;
 assert.deepEqual(result.errors,[]);result.passed=true;
} catch(error){result.error=error.stack;await page.screenshot({path:out+'/failure.png'});throw error;}
finally{await writeFile(out+'/results.json',JSON.stringify(result,null,2));await browser.close();await server.close();}
console.log(JSON.stringify(result));
