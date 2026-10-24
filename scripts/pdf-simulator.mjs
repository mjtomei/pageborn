import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';

export async function runPdfSimulator({ act, input, until, observed, settled, shot }) {
  let selection;
  const displayed = async () => {
    await until(() => {
      const events = observed().diagnostics?.events || [];
      selection = observed().diagnostics?.pdf?.selection ?? selection;
      const frame = events.findLast(event => event.type === 'pdf-frame');
      return frame?.selection === selection && frame?.position === Number(observed().slider);
    }, 'PDF text or image frame acknowledged', 20000);
    await settled();
  };
  await act({ kind: 'files', selector: '#file-picker', files: [
    { name: 'mixed.pdf', base64: pdfFixture().toString('base64') },
    { name: 'figure.pdf', base64: pdfFixture('figure').toString('base64') },
    { name: 'colors.pdf', base64: pdfFixture('colors').toString('base64') },
    { name: 'margins.pdf', base64: pdfFixture('margins').toString('base64') },
    { name: 'text.md', content: '# Native text still works\n\n' + 'Back to native Markdown reading.\n\n'.repeat(20) },
  ] });
  await until(() => observed().documents === '5' && !observed().libraryBusy, 'PDFs imported');
  await act({ kind: 'click', selector: '[data-document-id="mixed.pdf"] .document-card' });
  await until(() => observed().readerReady && observed().connection === 'Native text connected' && observed().pdfCanvases > 0, 'PDF starts in native reflow by default', 45000);
  await displayed(); await shot('01-pdf-start');
  await input('context_menu'); await input('down'); await input('click');
  await until(() => observed().previewLabel === 'Choose reading position: 0%' && observed().connection === 'Native text connected', 'PDF switches to native position selector');
  await settled(); await new Promise(resolve => setTimeout(resolve, 600));
  for (const percent of [5, 10, 15]) {
    await input('down', 600);
    await until(() => observed().previewLabel === `Choose reading position: ${percent}%`, 'PDF position slider adjusts');
  }
  assert.equal(observed().position, '0%', 'PDF stays at its old position until confirmed');
  await settled(); await shot('pdf-position-selector');
  await input('click');
  await until(() => observed().position === '15%' && observed().readerReady, 'PDF resumes at the selected position');
  await displayed(); await shot('pdf-position-selected');
  await input('double_click');
  await until(() => observed().title === 'Choose something good.' && observed().previewLabel === 'Choose document: mixed'
    && observed().connection === 'Native text connected', 'Back from PDF returns to native document library');
  await settled(); await shot('pdf-back-to-library');
  await input('click');
  await until(() => observed().position === '15%' && observed().readerReady, 'reopening PDF restores position');
  await displayed(); await shot('pdf-restored-after-back');
  assert.equal(observed().diagnostics.pdf.cached, true, 'returning from the library uses saved preparation');
  // Close the simulator's active display before creating a new WebView. A
  // raw browser reload leaves its previous native page registered.
  await input('double_click');
  await until(() => observed().title === 'Choose something good.', 'library before cold launch');
  await act({ kind: 'flush' }); await settled();
  await input('double_click'); await settled(); await act({ kind: 'reopen' });
  await until(() => observed().documents === '5' && observed().connection === 'Native text connected' && !observed().libraryBusy,
    'fresh library from SDK storage', 45000);
  await act({ kind: 'click', selector: '[data-document-id="mixed.pdf"] .document-card' });
  await until(() => observed().readerReady && observed().position === '15%' && observed().diagnostics?.pdf?.cached === true,
    'fresh WebView restores prepared PDF from SDK storage', 45000);
  await displayed(); await shot('pdf-cache-cold-restore');
  await act({ kind: 'click', selector: '#position-value' });
  await act({ kind: 'fill', selector: '#value-input', value: '37.5' });
  await act({ kind: 'click', selector: '#value-apply' });
  await until(() => observed().position === '37.5%', 'numeric PDF position');
  await displayed(); await shot('numeric-position');
  await act({ kind: 'click', selector: '#mode-auto' });
  await act({ kind: 'click', selector: '#speed-value' });
  await act({ kind: 'fill', selector: '#value-input', value: '83' });
  await act({ kind: 'click', selector: '#value-apply' });
  assert.equal(observed().speed, 83, 'numeric speed entry works in the simulator WebView');
  await input('down'); await until(() => observed().speed === 100, 'logarithmic swipe after manual rate');
  await act({ kind: 'click', selector: '#mode-page' });
  await act({ kind: 'click', selector: '#start' });
  const order = {};
  for (const query of ['IntroStart', 'LeftAStart', 'LeftBStart', 'RightAStart', 'RightBStart', 'FigureStart', 'LeftCStart', 'RightCStart', 'ConclusionStart', 'LongParagraphStart']) {
    await act({ kind: 'click', selector: '#tab-search' });
    await act({ kind: 'fill', selector: '#search', value: query });
    await until(() => observed().searchText?.includes(query), 'PDF search');
    await act({ kind: 'click', selector: '#search-results button' });
    await displayed(); order[query] = Number(observed().slider);
    assert.equal(observed().diagnostics.events.findLast(e => e.type === 'pdf-frame').renderer, query === 'FigureStart' ? 'pdf-image' : 'pdf-native', query);
    if (['LeftAStart', 'FigureStart', 'LongParagraphStart'].includes(query)) await shot(query);
  }
  const positions = Object.values(order);
  assert.ok(positions.every((value, i) => i === 0 || value > positions[i - 1]), `PDF reading order: ${JSON.stringify(order)}`);
  await act({ kind: 'fill', selector: '#search', value: 'RightBStart' });
  await until(() => observed().searchText?.includes('RightBStart'), 'text before figure search');
  await act({ kind: 'click', selector: '#search-results button' }); await displayed();
  await act({ kind: 'click', selector: '#mode-auto' });
  await act({ kind: 'range', selector: '#speed', value: 200 });
  await act({ kind: 'click', selector: '#play' });
  await until(() => observed().diagnostics?.events.findLast(e => e.type === 'pdf-frame')?.renderer === 'pdf-image', 'autoscroll enters figure', 20000);
  await shot('auto-text-to-figure');
  await act({ kind: 'range', selector: '#speed', value: 60 });
  await until(() => observed().diagnostics?.events.findLast(e => e.type === 'pdf-frame')?.renderer === 'pdf-native', 'autoscroll returns to text', 20000);
  await act({ kind: 'click', selector: '#play' }); await displayed(); await shot('auto-figure-to-text');
  const nativeFrame = () => observed().diagnostics?.events.findLast(e => e.type === 'pdf-frame');
  const entry = nativeFrame();
  assert.equal(entry.endRow - entry.firstRow, 3, 'three initial text rows');
  assert.equal(entry.padding, 6, 'first rows enter at the bottom');
  await act({ kind: 'click', selector: '#play' });
  for (let lines = 4; lines <= 9; lines++) {
    await until(() => nativeFrame()?.padding === 9 - lines, `${lines} lines revealed`);
    assert.equal(nativeFrame().y, entry.y, 'the first source row is retained while filling');
    assert.equal(nativeFrame().firstRow, entry.firstRow);
    assert.equal(nativeFrame().endRow - nativeFrame().firstRow, lines);
    if ([4, 6, 9].includes(lines)) await shot(`auto-entry-${lines}-lines`);
  }
  await until(() => nativeFrame()?.firstRow === entry.firstRow + 1, 'first line leaves only after the screen fills');
  await act({ kind: 'click', selector: '#play' }); await displayed(); await shot('auto-entry-normal-scroll');
  await act({ kind: 'click', selector: '#mode-page' });
  await act({ kind: 'click', selector: '#pdf-reflow' });
  await until(() => observed().pdfCanvases > 0 && observed().readerReady, 'scan mode ready', 30000);
  await displayed(); assert.equal(observed().diagnostics.events.findLast(e => e.type === 'pdf-frame').renderer, 'pdf-image');
  await shot('reflow-disabled-scan');
  await act({ kind: 'click', selector: '#pdf-reflow' });
  await until(() => observed().pdfCanvases > 0 && observed().readerReady, 'reflow ready', 30000);
  await act({ kind: 'click', selector: '#tab-search' });
  await act({ kind: 'fill', selector: '#search', value: 'IntroStart' });
  await until(() => observed().searchText?.includes('IntroStart'), 'reflow search');
  await act({ kind: 'click', selector: '#search-results button' });
  await displayed(); await shot('reflow-body-text');
  await act({ kind: 'fill', selector: '#search', value: 'FigureStart' });
  await until(() => observed().searchText?.includes('FigureStart'), 'retained figure search');
  await act({ kind: 'click', selector: '#search-results button' });
  await displayed(); await shot('reflow-retained-figure');
  await input('down'); await displayed(); await shot('02-pdf-long-paragraph');
  await act({ kind: 'click', selector: '[data-document-id="figure.pdf"] .document-card' });
  await until(() => observed().pdfCanvases > 0 && observed().readerReady, 'tall figure ready', 30000);
  await act({ kind: 'click', selector: '#next' }); await displayed(); await shot('03-tall-figure');
  await act({ kind: 'click', selector: '#mode-auto' });
  await act({ kind: 'range', selector: '#speed', value: 200 });
  await act({ kind: 'click', selector: '#play' });
  const initial = Number(observed().slider);
  await until(() => Number(observed().slider) > initial + 40, 'PDF image autoscroll', 20000);
  await act({ kind: 'click', selector: '#play' }); await displayed(); await shot('04-tall-figure-autoscroll');
  await act({ kind: 'click', selector: '[data-document-id="colors.pdf"] .document-card' });
  await until(() => observed().pdfCanvases > 0 && observed().readerReady, 'colored PDF ready', 30000);
  // These synthetic page headings intentionally differ only by a digit; keep
  // them for the color tests instead of filtering them as running headers.
  await act({ kind: 'click', selector: '#pdf-repeated-text' });
  await until(() => observed().readerReady && observed().diagnostics.pdf.keepRepeatedText, 'color headings retained');
  for (const query of ['ColorPage2', 'ColorPage3', 'DarkPanelStart']) {
    await act({ kind: 'click', selector: '#tab-search' });
    await act({ kind: 'fill', selector: '#search', value: query });
    await until(() => observed().searchText?.includes(query), 'colored PDF search');
    await act({ kind: 'click', selector: '#search-results button' });
    await displayed(); await shot(`colors-${query}`);
  }
  await act({ kind: 'click', selector: '[data-document-id="margins.pdf"] .document-card' });
  await until(() => observed().pdfCanvases > 0 && observed().readerReady, 'margin PDF ready', 30000);
  for (const [i, keep] of [false, true, false].entries()) {
    if (i > 0) {
      await act({ kind: 'click', selector: '#pdf-margin-notes' });
      await until(() => observed().pdfCanvases > 0 && observed().readerReady, 'margin layout ready', 30000);
    }
    await act({ kind: 'click', selector: '#start' });
    await displayed(); await shot(`margins-${i}-${keep ? 'kept' : 'removed'}`);
    await act({ kind: 'click', selector: '#tab-search' });
    await act({ kind: 'fill', selector: '#search', value: 'LeftNote' });
    await until(() => observed().searchQuery === 'LeftNote' && (keep ? observed().searchText?.includes('LeftNote')
      : observed().searchResults === 0), 'margin note search follows preference');
  }
  await act({ kind: 'click', selector: '[data-document-id="text.md"] .document-card' });
  await until(() => observed().connection === 'Native text connected', 'return to native text');
  await settled(); await shot('05-native-text');
  await act({ kind: 'files', selector: '#file-picker', files: [{ name: 'annotations.pdf', base64: pdfFixture('annotations').toString('base64') }] });
  await until(() => observed().documentIds?.includes('annotations.pdf') && !observed().libraryBusy, 'annotation PDF imported');
  await act({ kind: 'click', selector: '[data-document-id="annotations.pdf"] .document-card' });
  await until(() => observed().readerReady, 'annotation PDF prepared', 30000);
  await act({ kind: 'click', selector: '#tab-search' });
  await act({ kind: 'fill', selector: '#search', value: 'A sentence with reference' });
  await until(() => observed().searchText?.includes('A sentence with reference'), 'footnote reference search');
  await act({ kind: 'click', selector: '#search-results button' }); await displayed();
  assert.equal(observed().diagnostics.events.findLast(e => e.type === 'pdf-frame').renderer, 'pdf-native');
  await shot('bracketed-footnote-reference');
  const annotationPositions = [];
  for (const query of ['ContinuedBodyStart', 'DiagramContent', 'CaptionText', 'SecondSectionStart', 'FinalBodyStart']) {
    await act({ kind: 'click', selector: '#tab-search' });
    await act({ kind: 'fill', selector: '#search', value: query });
    await until(() => observed().searchText?.includes(query), 'annotation PDF search');
    await act({ kind: 'click', selector: '#search-results button' }); await displayed();
    annotationPositions.push(Number(observed().slider));
    assert.equal(observed().diagnostics.events.findLast(e => e.type === 'pdf-frame').renderer,
      query === 'DiagramContent' ? 'pdf-image' : 'pdf-native');
    if (query === 'CaptionText') await shot(`deferred-${query}`);
  }
  assert.ok(annotationPositions.every((value, i) => !i || value > annotationPositions[i - 1]), `deferred annotation order: ${annotationPositions}`);
  await act({ kind: 'fill', selector: '#search', value: '633' });
  await until(() => observed().searchQuery === '633' && observed().searchResults === 0, 'page number removed');
  for (const query of ['FirstNote', 'SecondNote']) {
    await act({ kind: 'fill', selector: '#search', value: query });
    await until(() => observed().searchQuery === query && observed().searchResults === 0, 'footnotes absent from body');
  }
  await act({ kind: 'click', selector: '#start' }); await displayed();
  const bodyPosition = observed().slider;
  const openNotesMenu = async () => {
    const gestures = () => observed().diagnostics?.events.filter(e => e.type === 'gesture') || [];
    const before = gestures().findLast(e => e.action === 'footnotes')?.at;
    await input('context_menu', 800);
    await until(() => gestures().at(-1)?.action === 'suspend', 'footnotes menu visible');
    for (let i = 0; i < 4; i++) await input('down', 250);
    await input('click', 800);
    await until(() => gestures().findLast(e => e.action === 'footnotes')?.at !== before
      && gestures().at(-1)?.action === 'resume', 'footnotes menu selection acknowledged');
    await settled();
  };
  await openNotesMenu();
  await until(() => observed().previewLabel?.startsWith('Footnotes:') && observed().play === 'Back to reading', 'footnotes menu opens');
  await settled(); await shot('footnotes-first-page');
  await input('down'); await settled(); await shot('footnotes-next-page');
  assert.equal(observed().slider, bodyPosition, 'footnote browsing does not move main position');
  await input('click');
  await until(() => observed().readerReady && !observed().previewLabel?.startsWith('Footnotes:'), 'one tap returns from notes');
  assert.equal(observed().slider, bodyPosition); await displayed(); await shot('footnotes-return-to-body');
  await openNotesMenu();
  await until(() => observed().previewLabel?.startsWith('Footnotes:'), 'reopen notes'); await settled();
  await openNotesMenu();
  await until(() => observed().readerReady && !observed().previewLabel?.startsWith('Footnotes:'), 'same menu option returns');
  assert.equal(observed().slider, bodyPosition); await displayed();
  await act({ kind: 'files', selector: '#file-picker', files: [{ name: 'equation.pdf', base64: pdfFixture('equation').toString('base64') }] });
  await until(() => observed().documentIds?.includes('equation.pdf') && !observed().libraryBusy, 'equation imported');
  await act({ kind: 'click', selector: '[data-document-id="equation.pdf"] .document-card' });
  await until(() => observed().readerReady, 'equation PDF ready', 30000);
  await act({ kind: 'click', selector: '#mode-page' });
  await act({ kind: 'click', selector: '#tab-search' });
  await act({ kind: 'fill', selector: '#search', value: 'x^2' });
  await until(() => observed().searchText?.includes('x^2'), 'equation found');
  await act({ kind: 'click', selector: '#search-results button' }); await displayed();
  assert.equal(observed().diagnostics.events.findLast(e => e.type === 'pdf-frame').renderer, 'pdf-image');
  await shot('centered-equation-pages');
  await act({ kind: 'click', selector: '#mode-speed' });
  await until(() => observed().mode === 'speed' && observed().play === 'Continue', 'speed reading stops at equation');
  await settled(); await new Promise(resolve => setTimeout(resolve, 350)); await shot('centered-equation-speed');
  await input('click');
  await until(() => observed().diagnostics?.events.findLast(e => e.type === 'pdf-frame')?.renderer === 'pdf-native', 'equation returns to native words');
  await input('click'); await settled(); await shot('after-centered-equation');
  if (process.env.PDF_SAMPLE) {
    await act({ kind: 'click', selector: '#mode-page' });
    await act({ kind: 'files', selector: '#file-picker', files: [{ name: 'sample.pdf', base64: (await readFile(process.env.PDF_SAMPLE)).toString('base64') }] });
    await until(() => observed().documentIds?.includes('sample.pdf') && !observed().libraryBusy, 'sample PDF imported', 45000);
    await act({ kind: 'click', selector: '[data-document-id="sample.pdf"] .document-card' });
    await until(() => observed().readerReady || observed().notice?.startsWith('Could not open PDF:'), 'sample PDF processed', 120000);
    assert.ok(observed().readerReady, observed().notice);
    for (const position of [0, 500, 1000]) {
      await act({ kind: 'range', selector: '#position', value: position });
      await displayed(); await shot(`sample-${position}`);
    }
    // Percentage samples can all land in prose. Exercise a source-page jump
    // too, then its next frame (the upright table in the Mansfield regression).
    if (observed().diagnostics.pdf.pages >= 3) {
      await act({ kind: 'headings', count: 0, finalIndex: 2 });
      await displayed(); await shot('sample-source-page-3');
      await act({ kind: 'click', selector: '#next' });
      await displayed(); await shot('sample-source-page-3-next');
    }
  }
  // Real firmware gesture routing is independent of the mock inference tests.
  // An unconfigured endpoint opens Ask with setup guidance, without recording.
  const beforeAsk = observed().slider;
  await input('long_press');
  await until(() => observed().previewLabel?.startsWith('Ask about this:'), 'long press opens Ask');
  await settled(); await shot('ask-long-press');
  await input('long_press_release');
  await until(() => observed().diagnostics.events.some(e => e.type === 'gesture' && e.action === 'ask-release'), 'paired long-press release reaches the app');
  await input('click');
  await until(() => !observed().previewLabel?.startsWith('Ask about this:'), 'tap returns from Ask');
  assert.equal(observed().slider, beforeAsk);
  for (const type of ['js-error', 'unhandled-rejection', 'bridge-error', 'bridge-timeout', 'display-paused']) assert.equal(observed().diagnostics.counts[type] || 0, 0, type);
  console.log('PASS: official simulator glasses position selector, numeric position/rate entry, native PDF text/image switching, mixed columns, figure scrolling, color normalization, margin toggle and return to native Markdown.');
  return { order, askLongPressAndRelease: true, exactAskReturn: true, centeredEquation: true, footnoteSideView: true, exactNoteReturn: true, preparedCacheColdRestore: true, backNavigation: true, positionPicker: true, numericEntry: true, logarithmicSpeed: true, images: true, reflowWithFigures: true, figureAutoscroll: true, gradualTextEntry: true, colorNormalization: true, marginToggle: true, nativeTextReturn: true };
}
