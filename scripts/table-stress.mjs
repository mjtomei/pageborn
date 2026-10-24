import { showLibrary, showTool, showSettings, hideSettings } from './ui-helpers.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument, searchDocument, positionForMatch } from '../src/document.js';
import { nativeLayout, textWindow, pageTurnY } from '../src/native-text.js';
import { tableStressCases } from '../test/fixtures/table-stress.js';

const layoutFor = scenario => nativeLayout(parseDocument(scenario.markdown));
const find = (layout, query) => positionForMatch(layout, searchDocument(layout, query)[0]);

export async function runTableStressBrowser({ page, until, click, event, reopen }) {
  const dir = 'test-results/table-stress-browser'; await mkdir(dir, { recursive: true });
  const results = [];
  const pane = page.locator('#passage');
  for (const scenario of tableStressCases()) {
    const layout = layoutFor(scenario);
    const started = Date.now();
    await page.locator('#file-picker').setInputFiles({ name: `${scenario.id}.md`, mimeType: 'text/markdown', buffer: Buffer.from(scenario.markdown) });
    await showLibrary(page); await page.locator(`[data-document-id="${scenario.id}.md"] .document-card`).click();
    await until(title => document.querySelector('#title').textContent === title, scenario.id);
    await click('mode-page');
    for (const [index, query] of scenario.probes.entries()) {
      const y = find(layout, query);
      await click('tab-search'); await page.locator('#search').fill(query);
      await until(hit => document.querySelector('#search-results button')?.textContent === `${hit.text}Line ${hit.sourceLine}`, searchDocument(layout, query)[0]);
      await page.locator('#search-results button').first().click();
      await until(body => window.__storedBody === body, textWindow(layout, y).content).catch(async error => {
        console.error('Table probe', query, { expected: textWindow(layout, y).content, actual: await page.evaluate(() => window.__storedBody) }); throw error;
      });
      await click('passage-current');
      // Exercise page turns through record and cell boundaries via real events.
      await event({ textEvent: { eventType: 2 } });
      await until(body => window.__storedBody === body, textWindow(layout, pageTurnY(layout, y, 1)).content);
      await event({ textEvent: { eventType: 1 } });
      await until(body => window.__storedBody === body, textWindow(layout, y).content);
      if (index === 1) {
        for (const width of [320, 390, 430]) {
          await page.setViewportSize({ width, height: 844 });
          for (const size of ['12', '22', '26']) {
            await showSettings(page); await page.locator('#font-size').selectOption(size); await hideSettings(page); await click('passage-current');
            await page.waitForTimeout(100);
            assert.ok(await pane.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${scenario.id}: fits ${width}px at ${size}px`);
            assert.ok(await pane.locator('button').evaluateAll(rows => rows.every(row => row.scrollHeight <= row.clientHeight + 1)), 'wrapped rows fit their height');
            assert.ok(await pane.locator('button').count() < 100, 'large tables keep a bounded DOM');
          }
        }
        await pane.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(dir, `${scenario.id}-phone.png`) });
        await showTool(page, 'bookmarks'); await click('bookmark'); await click('start');
        await page.locator('#bookmarks .nav-item').last().click();
        await until(body => window.__storedBody === body, textWindow(layout, y).content);
        await reopen();
        await until(body => window.__storedBody === body, textWindow(layout, y).content);
      }
    }
    // Browse to the actual end without selecting it. Virtualization must leave
    // the complete table reachable and must not move the glasses position.
    const before = await page.evaluate(() => window.__storedBody);
    await pane.evaluate(el => { el.dispatchEvent(new Event('wheel')); el.scrollTop = el.scrollHeight; });
    await until(() => Array.from(document.querySelectorAll('#passage button')).some(row => row.textContent.includes('Following paragraph')));
    assert.equal(await page.evaluate(() => window.__storedBody), before);
    assert.ok(await pane.locator('button').count() < 100);
    await showLibrary(page); await page.getByRole('button', { name: `Delete ${scenario.id}.md`, exact: true }).click();
    await showLibrary(page); await page.locator(`[data-confirm-delete="${scenario.id}.md"]`).click();
    await until(id => !document.querySelector(`[data-document-id="${id}.md"]`), scenario.id);
    results.push({ case: scenario.id, bytes: Buffer.byteLength(scenario.markdown), records: scenario.cells.length,
      columns: scenario.headers.length, displayRows: layout.rows.length, probes: scenario.probes, elapsedMs: Date.now() - started });
    console.log(`PASS: phone stress ${scenario.id}: search, pages, bookmark/reopen, 3 widths × 3 fonts, virtualized end.`);
  }
  await writeFile(path.join(dir, 'result.json'), JSON.stringify({ passed: true, cases: results }, null, 2));
}

export async function runTableStressSimulator({ act, input, until, observed, settled, shot }) {
  const results = [];
  for (const scenario of tableStressCases()) {
    const layout = layoutFor(scenario);
    await act({ kind: 'files', selector: '#file-picker', files: [{ name: `${scenario.id}.md`, content: scenario.markdown }] });
    await until(() => !observed().libraryBusy && observed().documentIds.includes(`${scenario.id}.md`), 'stress file saved', 30000);
    await act({ kind: 'click', selector: `[data-document-id="${scenario.id}.md"] .document-card` });
    await act({ kind: 'click', selector: '#mode-page' });
    for (const [index, query] of scenario.probes.entries()) {
      const y = find(layout, query);
      const expected = textWindow(layout, y).content.split('\n').map(line => line || ' ');
      await act({ kind: 'click', selector: '#tab-search' });
      await act({ kind: 'fill', selector: '#search', value: query });
      const hit = searchDocument(layout, query)[0];
      await until(() => observed().searchQuery === query && observed().searchResults === 1 && observed().searchText === `${hit.text}Line ${hit.sourceLine}`, 'stress search result');
      await act({ kind: 'click', selector: '#search-results button' });
      await until(() => observed().currentRow === textWindow(layout, y).start, 'stress search position');
      assert.deepEqual(observed().passageLines.slice(0, expected.length), expected);
      await settled(); await shot(`${scenario.id}-${index}-${query}`);
      await input('down');
      await until(() => observed().currentRow === textWindow(layout, pageTurnY(layout, y, 1)).start, 'stress next page');
      await input('up'); await until(() => observed().currentRow === textWindow(layout, y).start, 'stress previous page');
      if (query === 'CellMiddle') {
        await act({ kind: 'click', selector: '#tab-bookmarks' });
        await act({ kind: 'click', selector: '#bookmark' }); await act({ kind: 'click', selector: '#start' });
        await act({ kind: 'click', selector: '#bookmarks .nav-item' });
        await until(() => observed().currentRow === textWindow(layout, y).start, 'huge cell bookmark');
        await act({ kind: 'click', selector: '#mode-auto' });
        await act({ kind: 'range', selector: '#speed', value: 200 });
        await act({ kind: 'click', selector: '#play' });
        const start = textWindow(layout, y).start;
        await until(() => observed().currentRow >= start + 12, 'huge cell autoscroll');
        await act({ kind: 'click', selector: '#play' }); await settled(); await shot('huge-cell-autoscroll');
        const end = observed().currentRow;
        assert.deepEqual(observed().passageLines.slice(0, 9), layout.rows.slice(end, end + 9).map(row => row.text || ' '));
        await act({ kind: 'click', selector: '#mode-page' });
      }
    }
    const counts = observed().diagnostics.counts;
    for (const type of ['js-error', 'unhandled-rejection', 'bridge-error', 'bridge-timeout', 'display-paused']) assert.equal(counts[type] || 0, 0, type);
    results.push({ case: scenario.id, records: scenario.cells.length, columns: scenario.headers.length, displayRows: layout.rows.length, probes: scenario.probes });
    console.log(`PASS: official simulator stress ${scenario.id}.`);
  }
  return results;
}
