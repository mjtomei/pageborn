// Real desktop PDF preparation/checkpoint/phone-cache round trip. Inference is
// a fixture here; this test does not initialize CUDA or load model weights.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdtemp, writeFile, readFile, rm, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { scannedPdfFixture } from '../test/fixtures/pdfs.mjs';
import { runDaemon } from '../desktop/ocr/daemon.mjs';
import { libraryManifest, libraryPreparation, libraryOcrDirectory } from '../integrations/even-terminal/pageborne-library.js';
import { desktopPdfCache } from '../src/desktop-pdf-cache.js';
import { unpackPdfPreparation } from '../src/pdf-cache.js';

const root = await mkdtemp(path.join(tmpdir(), 'pageborne-ocr-browser-'));
const out = path.resolve('test-results/desktop-ocr'); await mkdir(out, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let browser;
try {
  const chromePath = process.env.CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(chromePath ? { executablePath: chromePath } : {}), args: ['--disable-gpu'] });
  const tab = await browser.newPage();
  const pixels = await tab.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 600; c.height = 800;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 600, 800);
    ctx.fillStyle = '#111'; ctx.font = '22px serif';
    const lines = ['The public reads this printed paragraph carefully.',
      'A reader turns the page and considers another idea.', 'Several arguments are presented in the chapter.',
      'Some concern the state and its public institutions.', 'Others describe the place of science in society.',
      'The author asks us to examine ordinary experience.', 'Every observation provides a different perspective.',
      'These examples make the argument easier to follow.', 'A careful explanation connects evidence to claims.',
      'The discussion continues with further examples.', 'Readers can compare the conclusions for themselves.',
      'The final paragraph brings the discussion together.'];
    for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], 40, 130+i*28);
    return Array.from(ctx.getImageData(0,0,600,800).data).filter((_, i) => i%4 !== 3);
  });
  await browser.close(); browser = null;
  const libraryDir = path.join(root, 'library'), modelPath = path.join(root, 'model');
  await mkdir(libraryDir); await mkdir(modelPath);
  const original = scannedPdfFixture(600, 800, Buffer.from(pixels), { pages: 3 });
  await writeFile(path.join(libraryDir, 'scan.pdf'), original);
  await writeFile(path.join(modelPath, 'model.safetensors'), 'fixture');
  const config = path.join(root, 'ocr.json');
  await writeFile(config, JSON.stringify({ libraryDir, modelPath, python: '/unused', weightsSha256: hash('fixture'), batchSize: 1, chromePath }));
  const calls = [];
  // CPU-only fixture can run on small CI workers; no real inference process
  // is created. Production always reads the real /proc/meminfo values.
  const readMemory = async () => ({ used: .30, free: 30*1024**3 });
  const engineFactory = () => ({
    async infer(items) {
      calls.push(...items.map(item => item.number));
      if (calls.length === 2) throw new Error('Simulated inference interruption');
      return { items: items.map(item => ({ number: item.number, extracted: item.extracted, turn: item.turn,
        markdown: 'Fixture model output; not a live quality evaluation.' })) };
    }, async stop() {},
  });
  await runDaemon(config, { once: true, engineFactory, readMemory });
  assert.deepEqual(calls, [1, 2]);
  const ocr = await libraryOcrDirectory({ libraryDir });
  const state = JSON.parse(await readFile(path.join(ocr, 'daemon.json')));
  const engineFolder = path.join(ocr, state.engine);
  const manifest = await libraryManifest({}, { libraryDir });
  const pageFolder = path.join(engineFolder, 'pages', manifest.files[0].sha256);
  assert.deepEqual(await readdir(pageFolder), ['1.json']);
  assert.deepEqual(await readdir(path.join(engineFolder, 'prepared')), []);
  for (const failure of await readdir(path.join(engineFolder, 'failures'))) await rm(path.join(engineFolder, 'failures', failure));
  await runDaemon(config, { once: true, engineFactory, readMemory });
  assert.deepEqual(calls, [1, 2, 2, 3], 'restart reuses page 1 and retries only unfinished pages');
  const artifacts = await readdir(path.join(engineFolder, 'prepared')); assert.equal(artifacts.length, 1);
  const artifact = JSON.parse(await readFile(path.join(engineFolder, 'prepared', artifacts[0])));
  await writeFile(path.join(out, 'preparation.json'), JSON.stringify(artifact));
  let saved;
  const phone = desktopPdfCache({ read: async () => saved, write: async (_, value) => { saved = value; } },
    { api: (_, { body }) => libraryPreparation(body, { libraryDir }) }, 'scan.pdf');
  const received = await phone.read(artifact.key);
  const layout = unpackPdfPreparation(structuredClone(received)).layout;
  assert.ok(layout.blocks.some(b => b.reflow?.text.includes('public')));
  assert.equal(new Set(layout.blocks.map(b => b.page)).size, 3);
  assert.equal(hash(await readFile(path.join(libraryDir, 'scan.pdf'))), hash(original));
  await runDaemon(config, { once: true, engineFactory, readMemory });
  assert.equal(calls.length, 4, 'completed document is skipped on daemon restart');
  await writeFile(path.join(out, 'result.json'), JSON.stringify({ passed: true, inference: 'fixture; no GPU',
    calls, pages: 3, sourceUnchanged: true, checkpointResume: true, phoneCacheRoundTrip: true }, null, 2));
  console.log('Desktop OCR restart, original preservation and phone cache round trip passed.');
} finally { await browser?.close(); await rm(root, { recursive: true, force: true }); }
