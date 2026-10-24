// PDF.js 6 getTextContent uses for-await on a ReadableStream. iOS 18 has
// streams and getReader(), but no stream async iterator. Consume its public
// text stream with the older reader API; keep the same items/styles/language.
// The app disables XFA, so all supported pages use this text-stream path.
export function pdfFontAscent(style = {}) {
  // Some embedded fonts report zero ascent and descent. Zero is a missing
  // metric, not a glyph whose top sits on its baseline: using it moves every
  // box down a line and assigns the printed text to the preceding image crop.
  if (Number.isFinite(style.ascent) && style.ascent > 0) return style.ascent;
  if (Number.isFinite(style.descent) && style.descent < 0 && style.descent > -1) return 1 + style.descent;
  return .8;
}

export function pdfWordGeometryNeedsOcr(boxes) {
  const words = boxes.filter(t => /^[A-Za-z]{3,}[,.;?]?$/.test(t.text.trim()) && t.width > t.height && t.height >= 4);
  if (words.length < 100 || words.length < boxes.length * .35) return false;
  let pairs = 0; let displaced = 0;
  for (const word of words) {
    const neighbor = words.find(other => other !== word && other.x >= word.x + word.width
      && other.x - word.x - word.width < word.height * 2.5 && Math.abs(other.y - word.y) < word.height * .75);
    if (neighbor) { pairs++; if (Math.abs(neighbor.y - word.y) > word.height * .25) displaced++; }
  }
  return pairs >= 60 && displaced > pairs * .28;
}

export function pdfTextNeedsOcr(boxes) {
  const text = boxes.map(box => box.text).join('').trim();
  if (text.length < 20) return true;
  // Broken embedded encodings and invalid Type 3 font metrics are not usable
  // text layers, even when they contain many characters. Recognize the pixels
  // instead of emitting control codes or hundreds of tiny image fragments.
  const corrupt = (text.match(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/g) || []).length;
  const invalid = boxes.reduce((n, box) => n + ((!Number.isFinite(box.x) || !Number.isFinite(box.y)
    || !Number.isFinite(box.height) || box.height < 2) ? box.text.length : 0), 0);
  // Some old OCR layers contain spaces inside almost every English word.
  // Count fragmentation within substantial text items, not between font runs
  // or individual glyph boxes. Ordinary formulas and non-Latin text stay put.
  const prose = boxes.map(box => box.text).filter(value => value.length > 80).join(' ');
  const words = prose.match(/[A-Za-z]+/g) || [];
  const fragmented = words.length > 80 && words.filter(word => /^[b-hj-z]$/.test(word)).length > words.length * .3
    && (prose.match(/[=∑∫√≤≥±∞∂∏∈∇{}^]/g) || []).length < 3
    && (prose.match(/[A-Za-z]/g) || []).length > (prose.match(/\p{L}/gu) || []).length * .8;
  return corrupt >= 5 && corrupt / text.length > .02 || invalid / text.length > .5 || fragmented || pdfWordGeometryNeedsOcr(boxes);
}

// Invisible text over a page scan is an OCR transcript, not the printed
// source. Old transcripts can have plausible English but omit whole phrases
// and flatten superscript references. Re-read those pixels when reflowing.
export function pdfHasScanTranscript(ops, codes, coordinates) {
  const hidden = ops.fnArray.some((op, i) => op === codes.setTextRenderingMode && ops.argsArray[i][0] === 3);
  if (!hidden) return false;
  for (let i = 0; i < coordinates.length; i += 6) {
    const [x, y, ax, ay, bx, by] = coordinates.slice(i, i + 6);
    if (Math.abs((ax - x) * (by - y) - (ay - y) * (bx - x)) >= .8) return true;
  }
  return false;
}

export function pdfRomanHeadingHints(text, width, height) {
  return text.filter(box => /^[IVXLCDM]{1,8}$/.test(box.text.trim()) && box.width < width * .08
    && box.y > height * .1 && box.y < height * .9 && Math.abs(box.x + box.width / 2 - width / 2) < width * .12
    && text.some(body => body.text.length > 60 && body.y > box.y + box.height && body.y < box.y + box.height * 6
      && body.x < box.x && body.x + body.width > box.x + box.width));
}

export function restorePdfRomanHeadings(text, hints) {
  let result = [...text];
  for (const hint of hints) {
    const matching = result.filter(box => box.text.length < 12 && box.width < hint.height * 5
      && Math.abs(box.y - hint.y) < hint.height && Math.abs(box.x + box.width / 2 - hint.x - hint.width / 2) < hint.height * 2);
    result = result.filter(box => !matching.includes(box));
    result.push({ ...(matching[0] || hint), text: hint.text.trim(), words: undefined, confidence: 95, heading: true });
  }
  return result.sort((a, b) => a.y - b.y || a.x - b.x);
}

// OCR often reads tiny superscript note numbers as registered-trademark marks.
// Recover only a matching marker from the embedded layer, never guess its value.
export function restorePdfOcrMarkers(lines, embedded) {
  const markers = embedded.flatMap(t => {
    if (/^\d{1,3}$/.test(t.text.trim()) && t.width < t.height*1.5) return [t];
    const prefix = t.text.match(/^(\d{1,3})(?=[("“])/);
    return prefix ? [{...t,text:prefix[1],prefixMarker:true}] : [];
  });
  return lines.map(line => {
    const word = line.words?.[0];
    if (!word || word.width > line.height || /^[A-Za-z]{2}/.test(word.text)) return line;
    const marker = markers.filter(t => Math.abs(t.x-word.x) < line.height*.4
      && Math.abs(t.y+t.height/2-word.y-word.height/2) < line.height*(t.prefixMarker ? 1.1 : .65))
      .sort((a,b)=>Math.abs(a.y-word.y)-Math.abs(b.y-word.y))[0];
    if (!marker) return line;
    const rest = line.words.slice(1).map(w=>w.y+w.height).sort((a,b)=>a-b);
    const raised = rest.length && word.y+word.height < rest[Math.floor(rest.length/2)]-line.height*.2;
    return { ...line, noteMarker: marker.text.trim(), noteMarkerRaised: Boolean(raised), text: marker.text.trim()+line.text.slice(word.text.length),
      words: [{ ...word, text: marker.text.trim() }, ...line.words.slice(1)] };
  });
}

// Whole-page OCR occasionally joins two lines across an otherwise established
// column gutter. Split only at a real inter-word gap, not through a word or a
// caption/note. The raster analysis supplies the column boundary.
export function splitPdfOcrColumns(lines, gutter) {
  return lines.flatMap(line => {
    const words = line.words;
    if (!words?.length || line.noteMarker || /^(?:figure|fig\.?|table)\s*\d/i.test(line.text)) return [line];
    const index = words.findIndex((word,i) => i > 0 && words[i-1].x+words[i-1].width < gutter && word.x > gutter
      && word.x-words[i-1].x-words[i-1].width >= Math.max(8,line.height*.65));
    if (index < 0 || words.slice(0,index).map(w=>w.text).join(' ').length < 12
      || words.slice(index).map(w=>w.text).join(' ').length < 12) return [line];
    return [words.slice(0,index),words.slice(index)].map(part => {
      const x = Math.min(...part.map(w=>w.x));
      return { ...line,x,width:Math.max(...part.map(w=>w.x+w.width))-x,words:part,text:part.map(w=>w.text).join(' ') };
    });
  });
}

export async function readPdfText(page, options = {}) {
  const reader = page.streamTextContent(options).getReader();
  const content = { items: [], styles: Object.create(null), lang: null };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return content;
      content.lang ??= value.lang;
      Object.assign(content.styles, value.styles);
      content.items.push(...value.items);
    }
  } catch (error) {
    // Stop a partially consumed stream if processing fails. Keep the original
    // error even when cancellation also fails (e.g. the PDF worker closed).
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}
