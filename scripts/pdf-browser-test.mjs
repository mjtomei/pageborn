import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { access, readdir, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createApp } from '../server/app.js';
import { waitForPdfReady, showLibrary, showTool, showDockOptions, chooseMode } from './ui-helpers.mjs';
import { pdfFixture, scannedPdfFixture } from '../test/fixtures/pdfs.mjs';

const dir = path.resolve(process.env.PDF_RESULTS || 'test-results/pdf-browser'); await mkdir(dir, { recursive: true });
const server = createApp({ distDir: path.resolve('dist') }).listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const cache = path.join(os.homedir(), '.cache/ms-playwright');
const cached = (await readdir(cache).catch(() => [])).filter(name => /^chromium-\d+$/.test(name));
const paths = [process.env.CHROME_PATH, chromium.executablePath(), ...cached.flatMap(name => [path.join(cache, name, 'chrome-linux/chrome'), path.join(cache, name, 'chrome-linux64/chrome')])].filter(Boolean);
const executablePath = (await Promise.all(paths.map(async value => { try { await access(value); return value; } catch { return null; } }))).find(Boolean);
const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
const errors = []; const messages = []; let page;
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
  // Match older phone WebViews throughout every PDF scenario and reload.
  // iOS 18 supports getReader(), but not async iteration over streams.
  await context.addInitScript(() => {
    delete Array.prototype.toSorted;
    delete ReadableStream.prototype[Symbol.asyncIterator];
    delete ReadableStream.prototype.values;
  });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) messages.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await expect(page.locator('#import')).toBeEnabled();
  // A new PDF can render fully offline, including built-in fonts and worker.
  await context.setOffline(true);
  const open = async (name, buffer) => {
    await page.locator('#file-picker').setInputFiles({ name, mimeType: 'application/pdf', buffer });
    await showLibrary(page); await page.locator(`[data-document-id="${name}"] .document-card`).click();
    await expect(page.locator('#pdf-reflow')).toBeChecked();
    await showTool(page, 'pdf'); await page.locator('#pdf-reflow').uncheck();
    await waitForPdfReady(page, 30000);
    await expect(page.locator('#pdf-passage canvas').first()).toBeVisible({ timeout: 30000 });
  };
  await open('mixed.pdf', pdfFixture());
  const results = {};
  for (const query of ['IntroStart', 'LeftAStart', 'LeftBStart', 'RightAStart', 'RightBStart', 'FigureStart', 'LeftCStart', 'RightCStart', 'ConclusionStart', 'LongParagraphStart', 'LastParagraphStart']) {
    await page.locator('#tab-search').click(); await page.locator('#search').fill(query);
    await expect(page.locator('#search-results button').first()).toContainText(query);
    await page.locator('#search-results button').first().click();
    await page.waitForTimeout(250);
    results[query] = Number(await page.locator('#position').inputValue());
  }
  const values = Object.values(results);
  assert.ok(values.every((value, i) => i === 0 || value > values[i - 1]), `mixed PDF order: ${JSON.stringify(results)}`);
  await page.locator('#passage-current').click();
  await expect(page.locator('#pdf-passage canvas').first()).toBeVisible();
  await page.waitForTimeout(300);
  assert.ok(await page.locator('#pdf-passage canvas').count() < 10);
  assert.ok(await page.locator('#pdf-passage').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await page.locator('#pdf-passage').scrollIntoViewIfNeeded();
  // Capture the pane after scrolling it into the browser viewport. Chromium
  // can omit composited canvases below the viewport in a full-page screenshot.
  await expect.poll(() => page.locator('#pdf-passage').evaluate(el => {
    const bounds = el.getBoundingClientRect(); let ink = 0;
    for (const canvas of el.querySelectorAll('canvas')) {
      const rect = canvas.getBoundingClientRect();
      const top = Math.max(0, Math.ceil((bounds.top - rect.top) * canvas.height / rect.height));
      const bottom = Math.min(canvas.height, Math.floor((bounds.bottom - rect.top) * canvas.height / rect.height));
      if (bottom <= top) continue;
      const data = canvas.getContext('2d').getImageData(0, top, canvas.width, bottom - top).data;
      for (let i = 0; i < data.length; i += 4) if (data[i] < 200) ink++;
    }
    return ink;
  })).toBeGreaterThan(1000);
  await page.locator('#pdf-passage').screenshot({ path: path.join(dir, 'desktop-passage.png') });
  await page.screenshot({ path: path.join(dir, 'desktop-pdf.png'), fullPage: true });
  await showTool(page, 'bookmarks'); await page.locator('#bookmark').click();
  const saved = await page.locator('#position').inputValue();
  await context.setOffline(false); await page.reload();
  await waitForPdfReady(page, 30000);
  await expect(page.locator('#position')).toHaveValue(saved);
  await page.locator('#tab-bookmarks').click(); await expect(page.locator('#bookmarks .bookmark-row')).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#passage-current').click(); await page.waitForTimeout(500);
  await page.locator('#pdf-passage').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(dir, 'phone-pdf.png') });
  const old = await page.locator('#position').inputValue();
  await page.locator('#pdf-passage').evaluate(el => { el.dispatchEvent(new Event('wheel')); el.scrollTop = 0; });
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#position').inputValue(), old, 'browsing the PDF leaves glasses position alone');
  await page.locator('#pdf-passage .pdf-tile').first().click({ position: { x: 100, y: 80 } });
  await expect(page.locator('#position')).not.toHaveValue(old);
  await showTool(page, 'pdf'); await page.locator('#pdf-layout').selectOption('single');
  await waitForPdfReady(page, 30000);
  await showTool(page, 'pdf'); await page.locator('#pdf-layout').selectOption('auto');
  await waitForPdfReady(page, 30000);
  await open('magazine.pdf', pdfFixture('magazine'));
  const magazinePositions = [];
  for (const query of ['IntroStart', 'LeftAStart', 'LeftBStart', 'RightAStart', 'RightBStart', 'FigureStart', 'LeftCStart', 'RightCStart', 'ConclusionStart']) {
    await page.locator('#tab-search').click(); await page.locator('#search').fill(query);
    await expect(page.locator('#search-results button').first()).toContainText(query);
    await page.locator('#search-results button').first().click();
    await page.waitForTimeout(250);
    magazinePositions.push(Number(await page.locator('#position').inputValue()));
  }
  assert.ok(magazinePositions.every((value, i) => i === 0 || value > magazinePositions[i - 1]),
    `pale backgrounds and clipping paths preserve column order: ${magazinePositions}`);
  await open('table.pdf', pdfFixture('table'));
  const tablePositions = [];
  for (const query of ['Row0Label', 'Row0Value', 'Row7Label', 'Row7Value']) {
    await page.locator('#tab-search').click(); await page.locator('#search').fill(query);
    await expect(page.locator('#search-results button').first()).toContainText(query);
    await page.locator('#search-results button').first().click();
    await page.waitForTimeout(250);
    tablePositions.push(Number(await page.locator('#position').inputValue()));
  }
  assert.equal(tablePositions[0], tablePositions[1], 'first table row stays together');
  assert.equal(tablePositions[2], tablePositions[3], 'last table row stays together');
  assert.ok(tablePositions[2] > tablePositions[0]);
  await open('colors.pdf', pdfFixture('colors'));
  await expect(page.locator('#pdf-colors')).toBeChecked();
  const colors = [];
  for (let n = 0; n < 7; n++) {
    await page.locator('#tab-outline').click(); await page.locator('#outline button').nth(n).click();
    if (n === 6) {
      await page.locator('#tab-search').click(); await page.locator('#search').fill('DarkPanelStart');
      await expect(page.locator('#search-results button').first()).toContainText('DarkPanelStart');
      await page.locator('#search-results button').first().click();
    }
    await page.waitForTimeout(500);
    const color = await page.locator('#preview').evaluate(canvas => {
      const data = canvas.getContext('2d').getImageData(0, 0, 576, 258).data;
      let dark = 0; let bright = 0; let colored = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 1] < 12) dark++;
        if (data[i + 1] > 180) bright++;
        if (data[i] !== data[i + 1] || data[i] !== data[i + 2]) colored++;
      }
      return { dark, bright, colored, total: data.length / 4 };
    });
    assert.ok(color.dark / color.total > .55, `page ${n + 1} paper stays dark: ${JSON.stringify(color)}`);
    if (n > 0 && n < 6) assert.ok(Math.abs(color.dark - colors[0].dark) / color.total < .08,
      `page ${n + 1} has the same paper coverage regardless of source colors`);
    assert.ok(color.bright > 500, `page ${n + 1} text stays bright: ${JSON.stringify(color)}`);
    assert.equal(color.colored, 0, 'hardware receives grayscale; lit pixels appear green'); colors.push(color);
    await page.locator('#preview').screenshot({ path: path.join(dir, `colors-${n + 1}.png`) });
  }
  // Reopen after the two-page raster cache has evicted the first pages.
  await page.reload(); await waitForPdfReady(page, 30000);
  await expect(page.locator('#pdf-colors')).toBeChecked();
  await showTool(page, 'pdf'); await page.locator('#pdf-colors').uncheck(); await waitForPdfReady(page, 30000);
  await page.reload(); await waitForPdfReady(page, 30000);
  await expect(page.locator('#pdf-colors')).not.toBeChecked();
  await showLibrary(page); await page.locator('[data-document-id="mixed.pdf"] .document-card').click();
  await waitForPdfReady(page, 30000);
  await expect(page.locator('#pdf-colors')).toBeChecked();
  await showLibrary(page); await page.locator('[data-document-id="colors.pdf"] .document-card').click();
  await waitForPdfReady(page, 30000);
  await expect(page.locator('#pdf-colors')).not.toBeChecked();
  await showTool(page, 'pdf'); await page.locator('#pdf-colors').check(); await waitForPdfReady(page, 30000);
  await open('margins.pdf', pdfFixture('margins'));
  await expect(page.locator('#pdf-margin-notes')).not.toBeChecked();
  const search = async (query, expected) => {
    await page.locator('#tab-search').click(); await page.locator('#search').fill(query);
    if (expected) await expect(page.locator('#search-results button').first()).toContainText(query);
    else await expect(page.locator('#search-results')).toContainText('No searchable text found');
  };
  await search('MainBody', true); await search('BottomFootnote', true);
  await search('LeftNote', false); await search('RightNote', false);
  await showTool(page, 'pdf'); await page.locator('#pdf-margin-notes').check();
  await waitForPdfReady(page, 30000);
  await search('LeftNote', true); await search('RightNote', true);
  await page.reload(); await waitForPdfReady(page, 30000);
  await expect(page.locator('#pdf-margin-notes')).toBeChecked(); await search('LeftNote', true);
  await showLibrary(page); await page.locator('[data-document-id="mixed.pdf"] .document-card').click();
  await waitForPdfReady(page, 30000);
  await expect(page.locator('#pdf-margin-notes')).not.toBeChecked();
  await showLibrary(page); await page.locator('[data-document-id="margins.pdf"] .document-card').click();
  await waitForPdfReady(page, 30000);
  await expect(page.locator('#pdf-margin-notes')).toBeChecked();
  await showTool(page, 'pdf'); await page.locator('#pdf-margin-notes').uncheck();
  await waitForPdfReady(page, 30000);
  await search('RightNote', false); await search('MainBody', true);
  await open('annotations.pdf', pdfFixture('annotations'));
  await showTool(page, 'pdf'); await page.locator('#pdf-reflow').check();
  await waitForPdfReady(page, 30000);
  const annotationPositions = [];
  for (const query of ['ContinuedBodyStart', 'DiagramContent', 'CaptionText', 'SecondSectionStart', 'FinalBodyStart']) {
    await search(query, true); await page.locator('#search-results button').first().click();
    await page.waitForTimeout(150); annotationPositions.push(Number(await page.locator('#position').inputValue()));
  }
  assert.ok(annotationPositions.every((value, i) => !i || value > annotationPositions[i - 1]),
    `captions follow their titled section, without footnotes: ${annotationPositions}`);
  await search('633', false);
  await search('FirstNote', false); await search('SecondNote', false);
  await search('ContinuedBodyStart', true); await page.locator('#search-results button').first().click();
  await showTool(page, 'bookmarks'); await page.locator('#bookmark').click();
  const annotationPosition = await page.locator('#position').inputValue();
  await page.reload(); await waitForPdfReady(page, 30000);
  await expect(page.locator('#position')).toHaveValue(annotationPosition);
  await showTool(page, 'pdf'); await page.locator('#pdf-footnotes').click();
  await expect(page.locator('#preview')).toHaveAttribute('aria-label', /Footnotes:/);
  await page.locator('#preview').screenshot({ path: path.join(dir, 'footnotes-view.png') });
  await page.locator('#play').click(); await expect(page.locator('#position')).toHaveValue(annotationPosition);
  await showTool(page, 'pdf'); await page.locator('#pdf-repeated-text').check();
  await waitForPdfReady(page, 30000); await search('633', true);
  await open('repeated-text.pdf', pdfFixture('repeated-text'));
  await expect(page.locator('#pdf-repeated-text')).not.toBeChecked();
  await search('JournalHeader', false); await search('ArchiveDownload', false);
  await search('FootnotePage0', true); await search('BodyPage0', true);
  await showTool(page, 'pdf'); await page.locator('#pdf-reflow').check();
  await waitForPdfReady(page, 30000);
  await expect(page.locator('#pdf-text-size')).toHaveValue('20');
  await search('or explanations.', true); await page.locator('#search-results button').first().click();
  await page.locator('#preview').screenshot({ path: path.join(dir, 'short-reflow.png') });
  await showTool(page, 'pdf'); await page.locator('#pdf-repeated-text').check();
  await waitForPdfReady(page, 30000);
  await search('JournalHeader', true); await search('ArchiveDownload', true);
  await page.reload(); await waitForPdfReady(page, 30000);
  await expect(page.locator('#pdf-repeated-text')).toBeChecked(); await search('ArchiveTerms', true);
  await showTool(page, 'pdf'); await page.locator('#pdf-repeated-text').uncheck();
  await waitForPdfReady(page, 30000);
  await search('ArchiveTerms', false); await search('FootnotePage0', true);
  await open('figure.pdf', pdfFixture('figure'));
  await expect(page.locator('#pdf-repeated-text')).not.toBeChecked();
  await expect(page.locator('#pdf-margin-notes')).not.toBeChecked();
  await page.locator('#next').click(); await page.waitForTimeout(250);
  await page.locator('#passage-current').click(); await page.locator('#pdf-passage').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(dir, 'tall-figure.png') });
  await chooseMode(page, 'auto'); await page.locator('#play').click();
  const before = await page.locator('#position').inputValue();
  await expect(page.locator('#position')).not.toHaveValue(before, { timeout: 5000 });
  await page.locator('#play').click();
  // Reflow remains local, keeps navigation stable and remembers per-PDF size.
  await showLibrary(page); await page.locator('[data-document-id="mixed.pdf"] .document-card').click();
  await waitForPdfReady(page, 30000);
  await chooseMode(page, 'page');
  await showTool(page, 'pdf'); await page.locator('#pdf-reflow').check(); await waitForPdfReady(page, 30000);
  await search('LongParagraphStart', true); await page.locator('#search-results button').first().click();
  await showTool(page, 'pdf'); await page.locator('#pdf-text-size').selectOption('28'); await waitForPdfReady(page, 30000);
  const reflowPosition = await page.locator('#position').inputValue();
  await page.reload(); await waitForPdfReady(page, 30000);
  await expect(page.locator('#pdf-reflow')).toBeChecked(); await expect(page.locator('#pdf-text-size')).toHaveValue('28');
  await expect(page.locator('#position')).toHaveValue(reflowPosition);
  await page.locator('#preview').screenshot({ path: path.join(dir, 'reflow-large.png') });
  // A real raster-only PDF: Tesseract has never run in this context. Network
  // access is disabled before recognition, including language initialization.
  const scanBytes = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 800;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 600, 800);
    ctx.fillStyle = 'black'; ctx.font = '24px sans-serif';
    ['Offline recognition works on this scanned page.', 'Readable words remain available without a server.',
      'A paragraph keeps its text and follows the figure.', 'The original document stays saved on this device.'].forEach((s, i) => ctx.fillText(s, 30, 70 + i * 34));
    ctx.strokeRect(100, 250, 400, 160); ctx.beginPath(); ctx.moveTo(100, 400); ctx.lineTo(220, 280); ctx.lineTo(400, 360); ctx.stroke();
    ctx.fillText('Figure labels stay in the image.', 120, 440);
    const rgba = ctx.getImageData(0, 0, 600, 800).data; const rgb = new Uint8Array(600 * 800 * 3);
    for (let i = 0; i < 600 * 800; i++) rgb.set(rgba.subarray(i * 4, i * 4 + 3), i * 3);
    let result = ''; for (let i = 0; i < rgb.length; i += 8192) result += String.fromCharCode(...rgb.subarray(i, i + 8192));
    return btoa(result);
  });
  await context.setOffline(true);
  const ocrRequests = []; page.on('request', request => { if (/^https?:/.test(request.url())) ocrRequests.push(request.url()); });
  await open('scan.pdf', scannedPdfFixture(600, 800, Buffer.from(scanBytes, 'base64')));
  await search('Offline recognition', false);
  await showTool(page, 'pdf'); await page.locator('#pdf-reflow').check(); await waitForPdfReady(page, 120000);
  await expect(page.locator('#notice')).not.toContainText('OCR could not finish');
  await search('Offline recognition', true); await page.locator('#search-results button').first().click();
  await page.locator('#preview').screenshot({ path: path.join(dir, 'offline-ocr.png') });
  assert.deepEqual(ocrRequests, [], 'OCR needs no HTTP requests');
  // A scan with an existing but corrupted hidden text layer must recognize
  // its pixels, using valid embedded geometry without leaking bad strings.
  await open('damaged-text-scan.pdf', scannedPdfFixture(600, 800, Buffer.from(scanBytes, 'base64'), {
    textLayer: Array.from({ length: 4 }, (_, i) => ({ x: 30, y: 70 + i * 34, size: 14,
      text: 'T h e pri n ci pl es t h at g o v er n t h e s ur vi v al of si g n als i n m ar k ets c a n b e a p pli e d t o ot h er c o nt e xts.' })),
  }));
  await showTool(page, 'pdf'); await page.locator('#pdf-reflow').check();
  await waitForPdfReady(page, 60000);
  await expect(page.locator('#notice')).not.toContainText('OCR could not finish');
  await search('Offline recognition', true); await search('T h e pri n', false);
  await page.locator('#preview').screenshot({ path: path.join(dir, 'damaged-text-ocr.png') });
  assert.deepEqual(ocrRequests, [], 'damaged-text OCR remains offline');
  // Fluent but incomplete hidden OCR must not win over the printed scan.
  await open('incomplete-transcript.pdf', scannedPdfFixture(600, 800, Buffer.from(scanBytes, 'base64'), {
    textLayer: [{ x: 30, y: 70, size: 24, text: 'A plausible transcript silently omits the printed sentence.' }],
  }));
  await showTool(page, 'pdf'); await page.locator('#pdf-reflow').check();
  await waitForPdfReady(page, 60000);
  await search('Offline recognition', true); await search('plausible transcript', false);
  await context.setOffline(false);
  await page.reload(); await waitForPdfReady(page, 30000);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('even-reader:diagnostics:v1')).pdf.cached), true);
  await search('Offline recognition', true);
  await context.setOffline(true);
  // A fresh scan starts a worker; switching files cancels it during startup.
  const changed = Buffer.from(scanBytes, 'base64'); changed[0] = 0;
  await page.locator('#file-picker').setInputFiles({ name: 'cancel-scan.pdf', mimeType: 'application/pdf', buffer: scannedPdfFixture(600, 800, changed) });
  await showLibrary(page); await page.locator('[data-document-id="cancel-scan.pdf"] .document-card').click();
  await expect(page.locator('#notice')).toContainText('Reading scanned page', { timeout: 10000 });
  await showLibrary(page); await page.locator('[data-document-id="mixed.pdf"] .document-card').click();
  await waitForPdfReady(page, 30000);
  await expect(page.locator('#pdf-text-size')).toHaveValue('28');
  await page.waitForTimeout(500);
  await context.setOffline(false);
  if (process.env.PDF_SAMPLE) {
    await open('sample.pdf', await readFile(process.env.PDF_SAMPLE));
    await expect(page.locator('#pdf-passage canvas').first()).toBeVisible();
    await page.waitForTimeout(500);
    await page.locator('#pdf-passage').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(dir, 'sample-pdf.png') });
    results.samplePages = await page.locator('#outline button').count();
    assert.ok(results.samplePages > 0);
    // Sample page navigation must reach article content, not just a cover.
    const sampleFrames = new Map();
    const checkpoints = [...new Set([Math.min(1, results.samplePages - 1), Math.floor(results.samplePages / 2), results.samplePages - 1])];
    if (checkpoints.length > 1) checkpoints.push(checkpoints[0]);
    let previousPage = 0;
    for (const index of checkpoints) {
      const before = await page.locator('#preview').evaluate(el => el.toDataURL());
      const beforePosition = await page.locator('#position').inputValue();
      await showTool(page, 'outline'); await page.locator('#outline button').nth(index).click();
      if (index !== previousPage) {
        await expect(page.locator('#position')).not.toHaveValue(beforePosition);
        await expect.poll(() => page.locator('#preview').evaluate(el => el.toDataURL()), { timeout: 15000 }).not.toBe(before);
      }
      const frame = await page.locator('#preview').evaluate(el => el.toDataURL());
      if (sampleFrames.has(index)) assert.equal(frame, sampleFrames.get(index), 'revisiting a released scan restores its pixels');
      else assert.ok(![...sampleFrames.values()].includes(frame), 'source pages produce different rendered content');
      sampleFrames.set(index, frame);
      previousPage = index;
      await page.locator('#preview').screenshot({ path: path.join(dir, `sample-page-${index + 1}.png`) });
    }
  }
  // A compact original 20-megapixel bilevel scan exceeds the old 16MP
  // rejection threshold. Its image must be resized, never silently omitted.
  const scanWidth = 3600; const scanHeight = 5600; const rowBytes = scanWidth / 8;
  const largeScan = new Uint8Array(rowBytes * scanHeight).fill(255);
  for (let y = 200; y < 5400; y++) if (y % 160 < 50) largeScan.fill(0, y * rowBytes + 30, y * rowBytes + rowBytes - 30);
  await open('large-scan.pdf', scannedPdfFixture(scanWidth, scanHeight, largeScan, { bilevel: true }));
  await expect.poll(() => page.locator('#preview').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, 576, 258).data;
    let lit = 0; let dark = 0;
    for (let i = 0; i < data.length; i += 4) { if (data[i] > 180) lit++; if (data[i] < 20) dark++; }
    return lit > 1000 && dark > 1000;
  })).toBe(true);
  await page.locator('#file-picker').setInputFiles({ name: 'blank.pdf', mimeType: 'application/pdf', buffer: pdfFixture('blank') });
  await showLibrary(page); await page.locator('[data-document-id="blank.pdf"] .document-card').click();
  await expect(page.locator('#notice')).toContainText('no visible content', { timeout: 120000 });
  await expect(page.locator('#bookmark')).toBeDisabled();
  assert.deepEqual(errors, []);
  await writeFile(path.join(dir, 'result.json'), JSON.stringify({ passed: true, order: results, magazinePositions, tablePositions, colors, errors, messages }, null, 2));
  assert.equal(await page.evaluate(() => typeof Array.prototype.toSorted), 'undefined');
  assert.equal(await page.evaluate(() => typeof ReadableStream.prototype[Symbol.asyncIterator]), 'undefined');
  console.log('PASS: PDF offline import, columns/tables/colors, preview/bookmarks, reflow/size persistence, offline OCR/cancellation and figure scrolling without Array.toSorted or ReadableStream async iteration.');
} catch (error) {
  console.error('PDF failure:', error.message, await page?.locator('#notice').textContent());
  await writeFile(path.join(dir, 'errors.json'), JSON.stringify({ errors, messages }, null, 2));
  await page?.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }); throw error;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
