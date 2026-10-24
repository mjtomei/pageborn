import { getTextWidth } from '@evenrealities/pretext';
import { uncertainWords } from './speech-confidence.js';
import { LINE_HEIGHT } from './native-text.js';

// Four transcript containers plus body, input/border, status and hint fit the
// native eight-text-container limit. Never shorten the pane to add highlights.
export const TRANSCRIPT_CONTAINER_LIMIT = 4;

// Map exact source offsets into wrapped visible lines, including repeated
// words, collapsed whitespace and words split across a line boundary.
export function visibleUncertainWords(source, words, lines, first, count = 3) {
  const spans = uncertainWords(source, words);
  if (!spans.length) return [];
  let normalized = ''; const offsets = [];
  for (const match of source.matchAll(/\S+/gu)) {
    if (normalized) { normalized += ' '; offsets.push(match.index - 1); }
    normalized += match[0];
    for (let i = 0; i < match[0].length; i++) offsets.push(match.index + i);
  }
  const visible = []; let cursor = 0;
  for (let row = 0; row < Math.min(lines.length, first + count); row++) {
    const start = normalized.indexOf(lines[row], cursor);
    if (start < 0) return []; // Do not guess if wrapping no longer matches.
    cursor = start + lines[row].length;
    if (row < first) continue;
    if (visible.length) visible.push(-1); // explicit display newline
    visible.push(...offsets.slice(start, cursor));
  }
  return spans.flatMap(span => {
    const start = visible.findIndex(offset => offset >= span.start && offset < span.end);
    if (start < 0) return [];
    const end = visible.findLastIndex(offset => offset >= span.start && offset < span.end) + 1;
    return [{ start, end }];
  }).sort((a, b) => a.start - b.start || a.end - b.end);
}

function runsFor(text, selected) {
  const dim = new Uint8Array(text.length);
  for (const span of selected) dim.fill(1, span.start, span.end);
  // Spaces between adjacent uncertain words have no pixels; keep that group
  // together instead of consuming a bright container just for whitespace.
  for (const match of text.matchAll(/ +/g)) {
    if (dim[match.index - 1] && dim[match.index + match[0].length]) dim.fill(1, match.index, match.index + match[0].length);
  }
  const runs = []; let offset = 0;
  for (const [row, line] of text.split('\n').entries()) {
    let start = 0;
    while (start < line.length) {
      const color = dim[offset + start] ? 1 : 4; let end = start + 1;
      while (end < line.length && (dim[offset + end] ? 1 : 4) === color) end++;
      const value = line.slice(start, end), content = value.trim();
      if (content) {
        const contentStart = start + value.length - value.trimStart().length;
        // Measure with the following glyph present so kerning at the split
        // matches the original full line, including before punctuation.
        const x = getTextWidth(line) - getTextWidth(line.slice(contentStart));
        const previous = runs.at(-1);
        if (x === 0 && previous?.x === 0 && previous.color === color && previous.row + previous.lines === row) {
          previous.content += '\n' + content; previous.lines++;
        } else runs.push({ content, x, row, lines: 1, color });
      }
      start = end;
    }
    offset += line.length + 1;
  }
  return runs.map(run => ({ ...run, y: run.row * LINE_HEIGHT, width: 528 - run.x, height: run.lines * LINE_HEIGHT }));
}

export function nativeTranscriptRuns(text, uncertain = [], limit = TRANSCRIPT_CONTAINER_LIMIT) {
  const candidates = uncertain.filter(span => Number.isInteger(span.start) && Number.isInteger(span.end)
    && span.start >= 0 && span.end > span.start && span.end <= text.length)
    .sort((a, b) => b.end - a.end || b.start - a.start);
  // One full-width native container preserves ordinary text exactly when
  // confidence is unavailable or nothing fits. A skipped highlight is bright.
  let result = { runs: [{ content: text || ' ', x: 0, y: 0, width: 528,
    height: Math.max(1, text.split('\n').length) * LINE_HEIGHT, color: 4 }], highlighted: 0, uncertain: candidates.length };
  for (let count = 1; count <= candidates.length; count++) {
    const runs = runsFor(text, candidates.slice(0, count));
    // Test all suffixes: adding adjacent older words can merge two runs.
    if (runs.length <= limit) result = { runs, highlighted: count, uncertain: candidates.length };
  }
  return result;
}
