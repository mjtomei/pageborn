import { pdfTextRows } from './pdf-reflow.js';

const core = text => text.match(/[\p{L}\d]+(?:['’][\p{L}]+)*/u)?.[0] || '';
const folded = text => core(text).toLowerCase();
const shape = text => folded(text).replace(/[1il]/g, 'i').replace(/0/g, 'o');
const alphabetic = text => /^[\p{L}]+(?:['’][\p{L}]+)*$/u.test(text);
const confusable = (a, b) => shape(a) === shape(b) && /\p{L}/u.test(a) && /\d/u.test(a) && alphabetic(b);

// Align within a physical source line. A second text layer is evidence only
// where its surrounding words agree; it never supplies new prose or numbers.
function align(words, source) {
  const a = words.map(word => word.text), b = source;
  const cost = Array.from({ length: a.length + 1 }, () => new Float32Array(b.length + 1));
  for (let i = 0; i <= a.length; i++) cost[i][0] = i;
  for (let j = 0; j <= b.length; j++) cost[0][j] = j;
  const substitution = (x, y) => folded(x) === folded(y) ? 0 : confusable(core(x), core(y)) ? .25 : 1;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    cost[i][j] = Math.min(cost[i - 1][j] + 1, cost[i][j - 1] + 1, cost[i - 1][j - 1] + substitution(a[i - 1], b[j - 1]));
  }
  const pairs = []; let i = a.length, j = b.length;
  while (i && j) {
    if (Math.abs(cost[i][j] - cost[i - 1][j - 1] - substitution(a[i - 1], b[j - 1])) < .01) pairs.push([--i, --j]);
    else if (cost[i][j] === cost[i - 1][j] + 1) i--; else j--;
  }
  const agreements = pairs.filter(([i, j]) => folded(a[i]) === folded(b[j]) && folded(a[i])).length;
  return { pairs, agreements, score: agreements / Math.max(a.length, b.length, 1) };
}

export function reconcilePdfOcr(lines, embedded) {
  const rows = pdfTextRows(embedded).map(row => ({ ...row,
    height: Math.max(...row.items.map(item => item.height)),
    words: row.text.split(/\s+/).filter(Boolean) }));
  return lines.map(line => {
    if (!line.words?.length) return line;
    const candidates = rows.filter(row => Math.abs(row.y + row.height / 2 - line.y - line.height / 2) < Math.max(row.height, line.height) * .85)
      .map(row => ({ row, ...align(line.words, row.words) })).sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best || best.agreements < 3 || best.score < .65) return line;
    const replacements = new Map();
    for (const [i, j] of best.pairs) {
      const word = line.words[i], before = core(word.text), after = core(best.row.words[j]);
      if (!before || before === after || word.references?.length) continue;
      const digit = confusable(before, after);
      const casing = before.toLowerCase() === after.toLowerCase() && alphabetic(before) && before.length > 1
        && word.confidence < 90 && before !== before.toUpperCase() && after !== after.toUpperCase();
      if (!digit && !casing) continue;
      replacements.set(i, { ...word, text: word.text.replace(before, after), ocrOriginal: word.text, ocrConsensus: true });
    }
    if (!replacements.size) return line;
    let offset = 0, text = line.text;
    const words = line.words.map((word, i) => {
      const replacement = replacements.get(i) || word;
      const at = text.indexOf(word.text, offset);
      if (at >= 0) { text = text.slice(0, at) + replacement.text + text.slice(at + word.text.length); offset = at + replacement.text.length; }
      return replacement;
    });
    return { ...line, text, words };
  });
}
