const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] || 0;

// Keep only the geometry of likely raised numeric suffixes. Retaining every
// OCR character would make the durable preparation many times larger.
export function pdfOcrReference(word, row = null) {
  const symbols = word.symbols || [];
  if (symbols.map(symbol => symbol.text).join('') !== word.text) return null;
  const letters = symbols.filter(symbol => /^\p{L}$/u.test(symbol.text));
  if (letters.length < 3 && (letters.length || !row)) return null;
  const baseline = letters.length ? median(letters.map(s => s.bbox.y1)) : row.baseline;
  const size = letters.length ? median(letters.map(s => s.bbox.y1 - s.bbox.y0)) : row.size;
  let at = symbols.length;
  while (at > 0 && /^[0-9⁰¹²³⁴⁵⁶⁷⁸⁹!?®°#*'’]+$/u.test(symbols[at - 1].text)) at--;
  if (at === symbols.length || !size) return null;
  const text = symbols.slice(at).map(s => s.text).join('');
  if (text.length > 5 || !/[0-9⁰¹²³⁴⁵⁶⁷⁸⁹!?®°]/u.test(text)) return null;
  const prefix = symbols.slice(0, at).map(s => s.text).join('');
  if (prefix && !/\p{L}{2}[.,;:!?()"'“”‘’]*$/u.test(prefix)) return null;
  const suffix = [];
  for (const symbol of symbols.slice(at)) {
    // Tesseract sometimes emits a second, narrow symbol over the edge of a
    // superscript (18 becomes !®#). Do not let that duplicate's false baseline
    // prevent recognition of the actual raised glyphs.
    if (suffix.some(s => symbol.bbox.x0 >= s.bbox.x0 && symbol.bbox.x1 <= s.bbox.x1 + size * .1
      && symbol.bbox.x1 - symbol.bbox.x0 < size * .3)) continue;
    if (symbol.bbox.y1 >= baseline - size * .25 || symbol.bbox.y1 - symbol.bbox.y0 > size * 1.05) return null;
    suffix.push(symbol);
  }
  if (!suffix.length) return null;
  return { start: prefix.length, end: word.text.length, text,
    bbox: { x0: Math.min(...suffix.map(s => s.bbox.x0)), y0: Math.min(...suffix.map(s => s.bbox.y0)),
      x1: Math.max(...suffix.map(s => s.bbox.x1)), y1: Math.max(...suffix.map(s => s.bbox.y1)) } };
}
