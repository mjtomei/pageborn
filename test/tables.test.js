import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getTextWidth } from '@evenrealities/pretext';
import { parseDocument, layoutDocument, anchorAt, restoreAnchor, searchDocument, positionForMatch } from '../src/document.js';
import { nativeLayout, textWindow, byteLength, setPageOverlap, VISIBLE_LINES } from '../src/native-text.js';
import { tableStressCases } from './fixtures/table-stress.js';

const fixture = readFileSync(new URL('./fixtures/tables.md', import.meta.url), 'utf8');

test('tables become labeled records, preserving Markdown cells and explicit empty values', () => {
  const parsed = parseDocument(fixture);
  assert.deepEqual(parsed.headings.map(h => h.text), ['Table reading test', 'After the table']);
  const records = parsed.blocks.filter(b => b.tableFields);
  assert.equal(records.length, 3);
  assert.match(records[0].text, /^\[1\/3\] Feature: Pages\nStatus: Ready\nNotes: Read a full screen/);
  assert.match(records[1].text, /swipe\.\nPause with a tap\./);
  assert.match(records[2].text, /Status: \(empty\)\nNotes: Choose .md files/);
  assert.ok(records[2].text.includes('A|B'));
  assert.deepEqual(records.map(r => r.sourceLine), [5, 6, 7]);
  const rows = nativeLayout(parsed).rows;
  assert.ok(rows.some(r => r.text === '    Pause with a tap.'));
  assert.ok(rows.some(r => r.text === '  Status: (empty)'));
  assert.ok(rows.every(r => !r.text.includes('| :---')));
});

test('blank and duplicate column names remain identifiable, including header-only tables', () => {
  const parsed = parseDocument('| | Name | Name |\n|---|---|---|\n| | **bold** | [link](https://example.org) &amp; `code` |');
  assert.equal(parsed.blocks[1].text, '[1/1] Column 1: (empty)\nName (column 2): bold\nName (column 3): link & code');
  const empty = parseDocument('| A | B |\n|---|---|');
  assert.equal(empty.blocks[0].text, 'Table (0 rows)');
  assert.equal(empty.blocks[1].text, 'A: (no rows)\nB: (no rows)');
  const plain = parseDocument('| A | B |\n|---|---|\n| 1 | 2 |', true);
  assert.ok(plain.blocks.every(b => b.kind === 'code' && !b.table));
  assert.equal(plain.blocks[2].text, '| 1 | 2 |');
});

test('wide tables and oversized Unicode cells wrap without clipping or losing content', () => {
  const values = ['👓'.repeat(170), '这是中文文字。'.repeat(70), 'https://example.org/' + 'x'.repeat(850)];
  const headers = ['Long column heading '.repeat(10), '中文', 'URL'];
  const parsed = parseDocument(`| ${headers.join(' | ')} |\n|---|---|---|\n| ${values.join(' | ')} |`);
  const native = nativeLayout(parsed);
  const record = parsed.blocks.find(b => b.tableFields);
  const tableRows = native.rows.filter(r => r.block === record.index && r.kind !== 'space');
  assert.equal(tableRows.map(r => r.text.trim()).join('').replace(/\s/g, ''), record.text.replace(/\s/g, ''), 'no dropped or duplicated cell text');
  for (const row of native.rows) {
    assert.ok(getTextWidth(row.text) <= 544, `pixel width: ${row.text}`);
    assert.ok(byteLength(row.text) * 8 <= 544, 'missing glyph byte guard includes indentation');
    assert.ok(!/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u.test(row.text), 'no split Unicode surrogate');
  }
  for (let overlap = 0; overlap < VISIBLE_LINES; overlap++) {
    setPageOverlap(native, overlap);
    const seen = new Set();
    for (const y of native.pages) {
      const page = textWindow(native, y);
      assert.ok(byteLength(page.content) <= 900);
      assert.ok(page.end - page.start <= VISIBLE_LINES);
      for (let i = page.start; i < page.end; i++) seen.add(i);
    }
    assert.equal(seen.size, native.rows.length, `overlap ${overlap}: no omitted table rows`);
  }
});

test('table search, row selection and bookmarks preserve source lines and character offsets', () => {
  const parsed = parseDocument(fixture);
  for (const layout of [nativeLayout(parsed), layoutDocument(parsed, text => Array.from(text).length * 11)]) {
    for (const [query, sourceLine] of [['Pause with a tap.', 6], ['A|B', 7], ['Status: (empty)', 7], ['Keep one line', 5]]) {
      const hit = searchDocument(layout, query)[0];
      assert.equal(hit.sourceLine, sourceLine);
      const y = positionForMatch(layout, hit);
      const row = layout.rows.find(r => r.y === y);
      assert.equal(row.sourceLine, sourceLine);
      assert.ok(row.offset <= hit.offset);
      assert.ok(row.text.includes(query.split(' ')[0]), `search selected ${row.text}`);
      const anchor = anchorAt(layout, y);
      assert.equal(restoreAnchor(layout, anchor), y, 'reopening restores the selected cell');
    }
    const old = { text: 'Feature: Autoscroll · Status: Ready · Notes: Adjust the speed', sourceLine: 6, heading: 'Table reading test', offset: 0, percent: 0 };
    const restored = layout.rows.find(r => r.y === restoreAnchor(layout, old));
    assert.equal(restored.sourceLine, 6, '0.4.0 bookmarks return to their original table row');
    assert.match(restored.text, /^\[2\/3\]/);
  }
  const before = nativeLayout(parsed);
  const y = positionForMatch(before, searchDocument(before, 'Pause with a tap.')[0]);
  const after = nativeLayout(parseDocument('# Added\n\nNew material.\n\n' + fixture));
  assert.equal(anchorAt(after, restoreAnchor(after, anchorAt(before, y))).text, '    Pause with a tap.');
});

for (const scenario of tableStressCases()) test(`large table stress: ${scenario.id}`, t => {
  const started = performance.now();
  const parsed = parseDocument(scenario.markdown);
  const native = nativeLayout(parsed);
  const records = parsed.blocks.filter(block => block.tableFields);
  assert.equal(records.length, scenario.cells.length);
  const byBlock = Map.groupBy(native.rows.filter(row => row.table), row => row.block);
  const compact = text => text.replace(/\s/g, '');
  for (const [i, record] of records.entries()) {
    assert.equal(record.tableFields.length, scenario.headers.length);
    const expected = scenario.headers.map((header, j) => `${j ? '' : `[${i + 1}/${records.length}] `}${header}: ${scenario.cells[i][j]}`).join('\n');
    assert.equal(compact(record.text), compact(expected), `record ${i + 1}: all labels and values parsed`);
    assert.equal(compact(byBlock.get(record.index).map(row => row.text).join('')), compact(expected), `record ${i + 1}: nothing lost or duplicated by wrapping`);
  }
  for (const row of native.rows) {
    assert.ok(getTextWidth(row.text) <= 544, 'native pixel width');
    assert.ok(byteLength(row.text) <= 68, 'native byte width');
    assert.ok(!/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u.test(row.text), 'no split surrogate');
  }
  // Check every screen, including inside the huge cells, at every overlap.
  for (let overlap = 0; overlap < VISIBLE_LINES; overlap++) {
    setPageOverlap(native, overlap);
    let covered = 0;
    for (const y of native.pages) {
      const page = textWindow(native, y);
      assert.ok(page.start <= covered, 'no gap between pages');
      assert.ok(page.end > page.start && page.end - page.start <= VISIBLE_LINES);
      assert.ok(byteLength(page.content) <= 900);
      covered = Math.max(covered, page.end);
    }
    assert.equal(covered, native.rows.length);
  }
  for (const query of scenario.probes) {
    const hits = searchDocument(native, query);
    assert.equal(hits.length, 1, `unique search marker: ${query}`);
    const y = positionForMatch(native, hits[0]);
    const anchor = anchorAt(native, y);
    assert.equal(restoreAnchor(native, anchor), y, `bookmark inside ${query}`);
  }
  t.diagnostic(`${byteLength(scenario.markdown)} bytes, ${records.length} records, ${native.rows.length} display rows, ${Math.round(performance.now() - started)} ms`);
});
