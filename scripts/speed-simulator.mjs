import assert from 'node:assert/strict';

export async function runSpeedSimulator({ act, input, until, observed, settled, shot }) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const lastGesture = () => observed().diagnostics?.events.filter(e => e.type === 'gesture').at(-1)?.action;
  const menu = async () => { await input('context_menu'); await until(() => lastGesture() === 'suspend', 'menu opened'); };
  const resumed = () => until(() => lastGesture() === 'resume', 'menu dismissed');
  await act({ kind: 'click', selector: '#mode-speed' });
  await until(() => observed().mode === 'speed' && observed().wordCursor === 0, 'speed mode starts at the first word');
  await settled(); await shot('01-three-centered-words');
  assert.equal(observed().wordGroup, 3); assert.equal(observed().speed, 250);
  await input('up'); await until(() => observed().speed === 300, 'swipe increases word rate');
  await input('down'); await until(() => observed().speed === 250, 'swipe decreases word rate');
  assert.equal(observed().wordCursor, 0);
  await act({ kind: 'range', selector: '#word-group', value: 1 });
  await settled(); await shot('02-whole-title-with-one-word-setting');
  await act({ kind: 'range', selector: '#speed', value: 120 });
  await input('click'); await until(() => observed().play === 'Pause', 'tap starts speed reading');
  await until(() => observed().wordCursor >= 7, 'timed native word updates');
  await input('click'); await until(() => observed().play === 'Start speed reading', 'tap pauses words');
  await act({ kind: 'flush' }); await settled(); await shot('03-paused-word');
  const paused = observed().wordCursor; await sleep(1200); assert.equal(observed().wordCursor, paused);
  await act({ kind: 'click', selector: '#next' }); await until(() => observed().wordCursor === paused + 1, 'next word');
  await act({ kind: 'click', selector: '#previous' }); await until(() => observed().wordCursor === paused, 'previous word');
  await menu(); await input('down'); await input('click'); await resumed();
  await until(() => observed().previewLabel?.startsWith('Choose reading position'), 'position picker in speed mode');
  await input('down'); await input('click');
  await until(() => !observed().previewLabel?.startsWith('Choose reading position') && observed().wordCursor > paused, 'word-position jump from glasses');
  assert.ok(parseFloat(observed().position) >= 5, 'picker moves the reading position by five percent');
  assert.equal(observed().play, 'Start speed reading');
  await act({ kind: 'range', selector: '#word-group', value: 10 });
  await settled(); await shot('04-ten-words');
  for (const mode of ['page', 'auto', 'speed']) {
    await menu(); await input('click');
    await until(() => observed().mode === mode, `glasses menu cycles to ${mode}`);
    await resumed();
  }
  assert.equal(observed().wordGroup, 10); assert.equal(observed().speed, 120);
  // Manual title stops use the same glasses tap as figure stops.
  await act({ kind: 'click', selector: '#start' });
  await act({ kind: 'click', selector: '#pause-at-titles' });
  await until(() => observed().pauseAtTitles && observed().play === 'Continue', 'title pause enabled');
  await settled(); await shot('05-title-waits-for-tap');
  await sleep(3500); assert.equal(observed().wordCursor, 0, 'whole title waits beyond its timed dwell');
  await input('click');
  await until(() => observed().wordCursor === 3 && observed().play === 'Continue', 'tap advances to the next complete heading');
  await settled(); await shot('06-next-title-waits-for-tap');
  await input('click'); await until(() => observed().play === 'Pause', 'tap starts the body after a heading');
  await input('click'); await until(() => observed().play === 'Start speed reading', 'pause body');
  await input('double_click');
  await until(() => observed().previewLabel?.startsWith('Choose document'), 'back returns to library');
  await settled(); await shot('07-library');
  // Opening another document keeps shared reading settings.
  await act({ kind: 'click', selector: '[data-document-id="zz-other.md"] .document-card' });
  await until(() => observed().title === 'Second saved document' && observed().play === 'Continue', 'shared title pause in another document');
  assert.equal(observed().pauseAtTitles, true); assert.equal(observed().wordGroup, 10); assert.equal(observed().speed, 120);
  await settled(); await shot('08-shared-settings-next-document');
  return { wholeTitles: true, manualTitleStops: true, sharedReadingSettings: true, centeredNativeWords: true, variableGroupAndRate: true, timedPlayback: true, pauseResume: true,
    wordNavigation: true, glassesPositionPicker: true, threeModeMenu: true, backToLibrary: true };
}
