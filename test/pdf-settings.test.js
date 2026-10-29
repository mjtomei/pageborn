import test from 'node:test';
import assert from 'node:assert/strict';
import { PDF_DEFAULTS, pdfSettingsFor, normalizePdfSettings, usePdfDefaults, forgetPdfSettings } from '../src/pdf-settings.js';

test('PDF settings snapshot defaults independently on first open and reset only on request', () => {
  const prefs = { pauseAtTitles: true, wordSpeed: 420, wordGroup: 4, mode: 'speed' };
  const first = pdfSettingsFor(prefs, 'a');
  assert.deepEqual(first, PDF_DEFAULTS);
  first.mode = 'single'; first.keepMarginNotes = true; first.textSize = 24;
  prefs.pdfDefaults = normalizePdfSettings(first);
  const second = pdfSettingsFor(prefs, 'b');
  assert.deepEqual(second, first); assert.notEqual(second, first); assert.notEqual(second, prefs.pdfDefaults);
  second.reflow = false; second.textSize = 28;
  assert.equal(first.reflow, true); assert.equal(prefs.pdfDefaults.textSize, 24);
  prefs.pdfDefaults.mode = 'double';
  assert.equal(pdfSettingsFor(prefs, 'a').mode, 'single'); assert.equal(pdfSettingsFor(prefs, 'b').mode, 'single');
  assert.equal(pdfSettingsFor(prefs, 'c').mode, 'double');
  usePdfDefaults(prefs, 'b');
  assert.deepEqual(pdfSettingsFor(prefs, 'b'), prefs.pdfDefaults);
  assert.equal(pdfSettingsFor(prefs, 'a').mode, 'single');
  assert.equal(prefs.pauseAtTitles, true); assert.equal(prefs.wordSpeed, 420); assert.equal(prefs.wordGroup, 4); assert.equal(prefs.mode, 'speed');
});

test('legacy PDFs retain factory fallback and explicit per-file choices after defaults change', () => {
  const prefs = { positions: { a: { pdf: { page: 1 } } }, pdfReflow: { b: false }, pdfTextSizes: { b: 28 },
    pdfLayouts: { b: 'double' }, pdfDefaults: { ...PDF_DEFAULTS, textSize: 24, keepRepeatedText: true } };
  assert.deepEqual(pdfSettingsFor(prefs, 'a'), PDF_DEFAULTS);
  assert.deepEqual(pdfSettingsFor(prefs, 'b'), { ...PDF_DEFAULTS, reflow: false, textSize: 28, mode: 'double' });
  assert.deepEqual(pdfSettingsFor(prefs, 'new'), prefs.pdfDefaults);
  const saved = JSON.parse(JSON.stringify(prefs));
  assert.deepEqual(pdfSettingsFor(saved, 'b'), pdfSettingsFor(prefs, 'b'));
  usePdfDefaults(prefs, 'b'); assert.deepEqual(pdfSettingsFor(prefs, 'b'), prefs.pdfDefaults);
  forgetPdfSettings(prefs, 'b');
  assert.equal(prefs.pdfSettings.b, undefined); assert.equal(prefs.pdfReflow.b, undefined); assert.equal(prefs.pdfTextSizes.b, undefined);
  assert.deepEqual(pdfSettingsFor(prefs, 'b'), prefs.pdfDefaults);
});

test('PDF defaults contain only supported formatting fields, never shared reading behavior', () => {
  assert.deepEqual(normalizePdfSettings({ mode: 'sideways', textSize: -1, reflow: 'false', wordSpeed: 600, pauseAtTitles: true }), PDF_DEFAULTS);
});

test('retired image splitting preferences cannot override fitting on one pane', () => {
  const prefs = { pdfDefaults: { fitFigures: false }, pdfSettings: { old: { ...PDF_DEFAULTS, fitFigures: false } }, pdfFitFigures: { legacy: false } };
  for (const key of ['old', 'new', 'legacy']) assert.deepEqual(pdfSettingsFor(prefs, key), PDF_DEFAULTS);
});
