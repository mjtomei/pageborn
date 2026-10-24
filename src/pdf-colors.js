// Estimate paper independently for each page/block. RGB distance, rather than
// luminance alone, keeps e.g. yellow-on-white or red-on-green text visible.
// A stable profile for the entire block avoids contrast changes while scrolling.
export function pdfColorProfile(data) {
  const counts = new Uint32Array(4096);
  const sums = new Uint32Array(4096 * 3);
  const step = Math.max(1, Math.floor(data.length / 4 / 50000)) * 4;
  let samples = 0; let best = 0;
  for (let i = 0; i < data.length; i += step) {
    if (data[i + 3] < 128) continue;
    const bin = (data[i] >> 4) * 256 + (data[i + 1] >> 4) * 16 + (data[i + 2] >> 4);
    counts[bin]++; samples++;
    for (let c = 0; c < 3; c++) sums[bin * 3 + c] += data[i + c];
    if (counts[bin] > counts[best]) best = bin;
  }
  if (!samples) return null;
  const background = [0, 1, 2].map(c => Math.round(sums[best * 3 + c] / counts[best]));
  const distances = new Uint32Array(256); let paper = 0; let foreground = 0;
  for (let i = 0; i < data.length; i += step) {
    if (data[i + 3] < 128) continue;
    const distance = Math.max(Math.abs(data[i] - background[0]), Math.abs(data[i + 1] - background[1]), Math.abs(data[i + 2] - background[2]));
    if (distance <= 12) paper++;
    else { distances[distance]++; foreground++; }
  }
  // Photographs/gradients have no reliable flat paper color. Preserve their
  // tonal detail with the existing luminance conversion instead of posterizing.
  if (paper / samples < .45) return null;
  let contrast = 255; let count = 0;
  for (let value = 13; value < 256; value++) {
    count += distances[value];
    if (foreground && count >= foreground * .95) { contrast = Math.max(24, value); break; }
  }
  return { background, contrast };
}

// Canonical black ink on white paper for layout/phone preview. Transmission
// inverts this to bright pixels (green on G2) and zero pixels (display off).
export function normalizePdfColors(data, profile) {
  const lookup = new Uint8Array(256);
  if (profile) for (let value = 0; value < 256; value++) {
    const ink = Math.min(1, Math.max(0, (value - 12) / (profile.contrast - 12)));
    lookup[value] = 255 - Math.round(255 * Math.pow(ink, .8));
  }
  for (let i = 0; i < data.length; i += 4) {
    const value = profile ? lookup[Math.max(Math.abs(data[i] - profile.background[0]),
      Math.abs(data[i + 1] - profile.background[1]), Math.abs(data[i + 2] - profile.background[2]))]
      : Math.round(data[i] * .2126 + data[i + 1] * .7152 + data[i + 2] * .0722);
    const opaque = Math.round(255 + (value - 255) * data[i + 3] / 255);
    data[i] = data[i + 1] = data[i + 2] = opaque; data[i + 3] = 255;
  }
  return data;
}
