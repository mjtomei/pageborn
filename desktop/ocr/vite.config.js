import { defineConfig } from 'vite';
import { pdfResources, ocrResources } from '../../vite.config.js';
import { bundledNotices } from '../../scripts/bundled-notices.mjs';
import path from 'node:path';

export default defineConfig({
  root: path.resolve('desktop/ocr'), base: './',
  plugins: [bundledNotices(), pdfResources(), ocrResources()], worker: { format: 'es' },
  build: { target: 'esnext', outDir: '../../dist-ocr', emptyOutDir: true },
});
