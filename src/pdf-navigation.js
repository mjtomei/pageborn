import { pdfTextRows } from './pdf-reflow.js';

const marker = /^(chapter|part|book|section)\s+([ivxlcdm\d]+|one|two|three|four|five|six|seven|eight|nine|ten)\b[.\s:—-]*(.*)$/i;
const compact = text => text.replace(/\s+/g, ' ').trim();
const capitals = text => {
  const letters = text.replace(/[^\p{L}]/gu, '');
  return letters.length >= 4 && letters === letters.toUpperCase();
};

// Work with OCR/native word geometry before reflow strips running furniture or
// keeps an uncertain page as an image. No additional recognizer or model load.
export function pdfNavigationCandidates({ text, width, height }, page) {
  const rows = pdfTextRows(text || []).map(row => ({ ...row,
    left: Math.min(...row.items.map(i => i.x)), right: Math.max(...row.items.map(i => i.x + i.width)),
    height: Math.max(...row.items.map(i => i.height)), text: compact(row.text) }));
  if (rows.some(row => row.y < height * .4 && /^(?:table of )?contents\b/i.test(row.text))) return [];
  const body = rows.filter(r => r.text.length > 65);
  const bounds = body.length ? body : rows.filter(r => r.text.length > 5);
  const left = bounds.length ? Math.min(...bounds.map(r => r.left)) : width * .1;
  const right = bounds.length ? Math.max(...bounds.map(r => r.right)) : width * .9;
  const center = (left + right) / 2;
  const centered = row => Math.abs((row.left + row.right) / 2 - center) < width * .09;
  const spaced = i => (!rows[i - 1] || rows[i].y - rows[i - 1].y > rows[i].height * 1.7)
    && (!rows[i + 1] || rows[i + 1].y - rows[i].y > rows[i].height * 1.7);
  const found = []; let consumed = -1;
  for (let i = 0; i < rows.length; i++) {
    if (i <= consumed) continue;
    const row = rows[i];
    if (row.y < height * .07 || row.y > height * .9 || row.text.length > 180) continue;
    let title = row.text.replace(/^[|¦]\s*(?=chapter\b)/i, ''), end = i;
    if (/^(chapter|part|book|section)$/i.test(title) && rows[i + 1] && rows[i + 1].y - row.y < row.height * 3)
      title += ' ' + rows[++end].text;
    const match = title.match(marker);
    if (match && centered(row)) {
      // Chapter numbers and their (often smaller, all-capital) titles occupy
      // different rows in old books. Keep them together as one destination.
      while (end + 1 < rows.length && end < i + 3 && capitals(rows[end + 1].text)
        && centered(rows[end + 1]) && rows[end + 1].y - rows[end].y < row.height * 4
        && !marker.test(rows[end + 1].text)) title += (end === i ? ' — ' : ' ') + rows[++end].text;
      const role = /^(part|book)$/i.test(match[1]) ? 'part' : match[1].toLowerCase() === 'chapter' ? 'chapter' : 'heading';
      found.push({ title, role, page, point: { x: row.left, y: row.y } }); consumed = end; continue;
    }
    if (/^(?:[IVXLC]{1,7}|[1-9]\d?)\.?$/.test(row.text) && centered(row) && row.right - row.left < width * .12
      && rows[i + 1]?.text.length > 30 && rows[i + 1].y - row.y > row.height * 1.15
      && (!rows[i - 1] || row.y - rows[i - 1].y > row.height * 1.5)) {
      found.push({ title: `Section ${row.text.replace(/\.$/, '')}`, role: 'section', page, point: { x: row.left, y: row.y } }); continue;
    }
    // Capitals alone are insufficient: a sentence or a running title must not
    // become a section. Require a short centered line and surrounding space.
    const frontMatter = /^(?:preface|prefatory note|foreword|acknowledg[e]?ments|introduction|appendix|appendices|bibliography|index|notes)$/i.test(row.text);
    if (capitals(row.text) && centered(row) && (spaced(i) || frontMatter && (!rows[i + 1] || rows[i + 1].y - row.y > row.height * 1.3)) && row.text.split(' ').length <= 12
      && !/[.!?;,]$/.test(row.text) && !/^\d+\s|\s\d+$/.test(row.text)) {
      found.push({ title: row.text, role: 'heading', page, point: { x: row.left, y: row.y } });
    }
  }
  // Old part dividers often repeat the upcoming chapters as a local contents
  // list. Navigate to the actual chapter openings on subsequent prose pages.
  if (found.some(entry => entry.role === 'part') && !rows.some(row => row.text.length > 80
    && (row.text.match(/[a-z]/g) || []).length > (row.text.match(/[A-Z]/g) || []).length * 2))
    return found.filter(entry => entry.role === 'part');
  return found;
}

export function pdfNavigationSections(candidates) {
  const counts = new Map();
  for (const entry of candidates) if (entry.role === 'heading') counts.set(entry.title, (counts.get(entry.title) || 0) + 1);
  const hasParts = candidates.some(e => e.role === 'part');
  const hasChapters = candidates.some(e => e.role === 'chapter');
  const firstPart = candidates.find(e => e.role === 'part' && /^(part|book)\s+(I|1|one)\b/i.test(e.title));
  return candidates.filter(e => (e.role !== 'part' || !firstPart || e.page >= firstPart.page)
    && (e.role !== 'heading' || counts.get(e.title) < 3 && (!hasChapters
      || /^(?:preface|prefatory note|foreword|acknowledg[e]?ments|introduction|appendix|appendices|bibliography|index|notes)$/i.test(e.title))))
    .map(entry => ({ ...entry,
    level: entry.role === 'part' ? 1 : entry.role === 'chapter' ? hasParts ? 2 : 1 : hasChapters ? hasParts ? 3 : 2 : 1 }));
}
