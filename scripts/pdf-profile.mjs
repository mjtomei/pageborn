// Fresh Chrome contexts exclude both durable preparation and in-memory OCR caches.
// Keep complete layouts for before/after quality comparison, not just timings.
import { chromium, webkit } from '@playwright/test';
import { createServer } from 'vite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';

const dir = path.resolve(process.env.PROFILE_RESULTS || 'test-results/pdf-profile');
await mkdir(dir, { recursive: true });
const vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, clearScreen: false });
await vite.listen();
const engine = process.env.PROFILE_BROWSER || 'chromium';
const browser = await (engine === 'webkit' ? webkit.launch({ executablePath: process.env.WEBKIT_PATH })
  : chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] }));
try {
  for (const file of process.argv.slice(2)) {
    const context = await browser.newContext(); const page = await context.newPage();
    page.on('console', message => { if (message.text().startsWith('Profile:')) console.log(message.text()); });
    await page.route('**/__profile', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>PDF profile</title>' }));
    await page.goto(new URL('/__profile', vite.resolvedUrls.local[0]).href);
    // Compile modules before timing; app startup/module download is separate.
    await page.evaluate(async () => {
      window.PdfDocument = (await import('/src/pdf.js')).PdfDocument;
      window.PdfOcr = (await import('/src/pdf-ocr.js')).PdfOcr;
      window.OcrWorker = (await import('/src/ocr-worker.js')).OcrWorker;
      window.pack = (await import('/src/pdf-cache.js')).packPdfPreparation;
    });
    const profiler = process.env.PROFILE_CPU && engine === 'chromium' ? await context.newCDPSession(page) : null;
    if (profiler) { await profiler.send('Profiler.enable'); await profiler.send('Profiler.start'); }
    const result = await page.evaluate(async bytes => {
      const totals = {}; const stages = {}; const partials = []; let stage, since;
      const wrap = (proto, name, key = name) => {
        const method = proto[name];
        proto[name] = async function (...args) {
          const start = performance.now();
          try { return await method.apply(this, args); }
          finally { const k = typeof key === 'function' ? key(args) : key;
            const stat = totals[k] ||= { ms: 0, calls: 0 }; stat.ms += performance.now() - start; stat.calls++; }
        };
      };
      for (const method of ['renderPage', 'preparePage', 'yieldPreparation']) wrap(PdfDocument.prototype, method);
      for (const method of ['recognize', 'recognizeTurn', 'recognizeNumber', 'recognizeRomanHeading']) wrap(PdfOcr.prototype, method);
      wrap(OcrWorker.prototype, 'call', args => `worker:${args[0]}`);
      const start = performance.now();
      const pdf = new PdfDocument({ diagnostics: { log(type, data) {
        if (type === 'pdf-partial-ready') console.log(`Profile: ${data.pages}/${data.total} pages ready`);
        if (type !== 'pdf-stage') return;
        const now = performance.now(); if (stage) stages[stage] = (stages[stage] || 0) + now - since;
        stage = data.stage; since = now;
      }, error(type, error) { throw new Error(`${type}: ${error.message}`); } } });
      try {
        const layout = await pdf.open(bytes, 'auto', () => {}, { onPartial: layout => {
          partials.push({ pages: layout.preparation.readyPages, ms: performance.now() - start });
        } });
        return { ms: performance.now() - start, partials, totals, stages, warnings: pdf.warnings, ocrCore: pdf.ocr.core,
          prepared: pack(layout, pdf.marginMasks, pdf.pageScales) };
      } finally { await pdf.destroy(); }
    }, (file.startsWith('fixture:') ? pdfFixture(file.slice(8)) : await readFile(file)).toString('base64'));
    const name = path.basename(file, '.pdf').replace(':', '-'); const prepared = JSON.stringify(result.prepared);
    if (process.env.PROFILE_COMPARE) {
      const previous = JSON.parse(await readFile(path.join(process.env.PROFILE_COMPARE, `${name}.layout.json`), 'utf8'));
      assert.deepEqual(result.prepared, previous, `${name}: preparation changed`);
      result.identicalToBaseline = true;
    }
    if (profiler) await writeFile(path.join(dir, `${name}.cpuprofile`), JSON.stringify((await profiler.send('Profiler.stop')).profile));
    await writeFile(path.join(dir, `${name}.layout.json`), prepared);
    delete result.prepared; result.layoutHash = createHash('sha256').update(prepared).digest('hex');
    await writeFile(path.join(dir, `${name}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ file: name, ms: result.ms, first: result.partials[0]?.ms, totals: result.totals, layoutHash: result.layoutHash }));
    await context.close();
  }
} finally { await browser.close(); await vite.close(); }
