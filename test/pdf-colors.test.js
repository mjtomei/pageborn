import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfColorProfile, normalizePdfColors } from '../src/pdf-colors.js';

const pixels = colors => new Uint8ClampedArray(colors.flatMap(color => [...color, 255]));
for (const [name, paper, ink] of [
  ['black on white', [255, 255, 255], [0, 0, 0]],
  ['white on black', [0, 0, 0], [255, 255, 255]],
  ['yellow on white', [255, 255, 255], [255, 255, 0]],
  ['red on green', [0, 100, 0], [255, 0, 0]],
  ['light blue on navy', [5, 10, 40], [140, 180, 240]],
  ['faint gray on cream', [245, 238, 216], [195, 188, 166]],
]) test(`PDF colors normalize ${name} to dark ink and clean paper`, () => {
  const data = pixels([...Array(90).fill(paper), ...Array(10).fill(ink)]);
  const profile = pdfColorProfile(data); assert.ok(profile);
  normalizePdfColors(data, profile);
  assert.deepEqual([...data.slice(0, 4)], [255, 255, 255, 255]);
  assert.deepEqual([...data.slice(-4)], [0, 0, 0, 255]);
});

test('paper texture is suppressed and antialiased edges retain intermediate intensities', () => {
  const data = pixels([[255, 255, 255], [248, 250, 249], [180, 180, 180], [80, 80, 80], [0, 0, 0]]);
  normalizePdfColors(data, { background: [255, 255, 255], contrast: 255 });
  assert.equal(data[4], 255);
  assert.ok(data[8] > data[12] && data[8] < 255 && data[12] > 0);
});

test('a stable block profile gives identical pixels when scrolling through separate pieces', () => {
  const input = pixels([...Array(30).fill([12, 20, 40]), ...Array(5).fill([180, 220, 255]), ...Array(25).fill([12, 20, 40])]);
  const profile = pdfColorProfile(input);
  const complete = normalizePdfColors(input.slice(), profile);
  const first = normalizePdfColors(input.slice(0, 120), profile);
  const last = normalizePdfColors(input.slice(120), profile);
  assert.deepEqual(complete, new Uint8ClampedArray([...first, ...last]));
});

test('images without a flat paper color retain grayscale detail and transparent pixels stay paper', () => {
  const gradient = pixels(Array.from({ length: 256 }, (_, i) => [i, 255 - i, i]));
  assert.equal(pdfColorProfile(gradient), null);
  normalizePdfColors(gradient, null);
  assert.ok(new Set(gradient.filter((_, i) => i % 4 === 0)).size > 32);
  const transparent = new Uint8ClampedArray([0, 0, 0, 0]);
  assert.equal(pdfColorProfile(transparent), null);
  normalizePdfColors(transparent, { background: [255, 255, 255], contrast: 255 });
  assert.deepEqual([...transparent], [255, 255, 255, 255]);
});
