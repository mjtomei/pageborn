import test from 'node:test';
import assert from 'node:assert/strict';
import { actionForEvent, actionForGesture, actionForMenu, APP_MENU, keyBinding, gestureHelp } from '../src/controls.js';
import { PreviewGestures } from '../src/preview-input.js';
import { pageDefinition } from '../src/glasses.js';

function gestures(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = []; const input = new PreviewGestures(event => events.push(event));
  const tap = (x = 0, y = 0) => { input.down(x, y); input.up(x, y); };
  return { events, input, tap, tick: async ms => { t.mock.timers.tick(ms); await Promise.resolve(); } };
}
test('glasses gestures from every SDK envelope and preview gestures share actions', () => {
  for (const [gesture, type] of [['tap', 0], ['swipe-up', 1], ['swipe-down', 2], ['double-tap', 3], ['hold-start', 9], ['hold-end', 10]]) {
    for (const envelope of ['sysEvent', 'textEvent', 'listEvent']) assert.equal(actionForEvent({ sysEvent: {}, [envelope]: { eventType: type } }), actionForGesture(gesture));
  }
  assert.equal(actionForEvent({ sysEvent: { eventType: 8 } }), null);
  assert.equal(actionForEvent({ audioEvent: {} }), null);
  assert.equal(actionForEvent({ sysEvent: { eventType: 7 }, textEvent: { eventType: 0 } }), 'exit');
  assert.deepEqual(pageDefinition().menuObject.menuItems, APP_MENU.map(({ itemID, itemName }) => ({ itemID, itemName })));
  for (const item of APP_MENU) assert.equal(actionForEvent({ menuItemClickEvent: { itemID: item.itemID } }), actionForMenu(item.itemID));
});
test('single tap waits; double tap and tap-then-hold never leak an initial page turn', async t => {
  const { input, events, tap, tick } = gestures(t);
  tap(); assert.deepEqual(events, []); await tick(300); assert.deepEqual(events, ['tap']); events.length = 0;
  tap(); await tick(100); tap(); await tick(700); assert.deepEqual(events, ['double-tap']); events.length = 0;
  tap(); await tick(100); input.down(0, 0); await tick(550); input.up(0, 0); await tick(500); assert.deepEqual(events, ['menu']);
});
test('hold starts before release, movement and cancellation stop it without submitting', async t => {
  const { input, events, tick } = gestures(t);
  input.down(0, 0); await tick(550); assert.deepEqual(events, ['hold-start']); input.up(0, 0); assert.deepEqual(events, ['hold-start', 'hold-end']);
  events.length = 0; input.down(0, 0); await tick(550); input.cancel(); input.up(0, 0); await tick(500); assert.deepEqual(events, ['hold-start', 'hold-cancel']);
  events.length = 0; input.down(0, 0); await tick(550); input.move(100, 0); input.up(100, 0); assert.deepEqual(events, ['hold-start', 'hold-cancel']);
});
test('four swipe directions share up/down bindings; movement cancels hold and stray taps', async t => {
  const { input, events, tick } = gestures(t);
  for (const [x, y] of [[0, -80], [0, 80], [-80, 0], [80, 0]]) { input.down(0, 0); input.move(x, y); await tick(650); input.up(x, y); }
  assert.deepEqual(events, ['swipe-up', 'swipe-down', 'swipe-down', 'swipe-up']);
  events.length = 0; input.down(0, 0); input.move(20, 0); input.up(0, 0); await tick(800); assert.deepEqual(events, []);
});
test('navigation cancellation drops pending taps; a new sequence starts cleanly', async t => {
  const { input, events, tap, tick } = gestures(t);
  tap(); input.cancel(); await tick(1000); assert.deepEqual(events, []);
  input.down(0, 0); input.cancel(); await tick(1000); input.up(0, 0); assert.deepEqual(events, []);
  tap(); await tick(300); assert.deepEqual(events, ['tap']);
});
test('keyboard mappings use gestures while browser shortcuts and composition are ignored', () => {
  assert.equal(actionForGesture(keyBinding({ key: 'ArrowDown' }).gesture), 'next');
  assert.equal(actionForGesture(keyBinding({ key: 'Escape' }).gesture), 'back');
  assert.equal(actionForGesture(keyBinding({ code: 'KeyA' }).release), 'ask-release');
  assert.equal(keyBinding({ code: 'KeyA', ctrlKey: true }), null);
  assert.equal(keyBinding({ key: 'Enter', isComposing: true }), null);
});

test('gesture help describes mode-specific taps and contextual Back', () => {
  assert.match(gestureHelp(), /tap to switch reading \/ Ask · double tap to open the library/);
  for (const mode of ['auto', 'speed']) assert.match(gestureHelp({ mode }), /tap to pause\/resume · double tap to switch reading \/ Ask/);
  assert.match(gestureHelp({ view: 'answer' }), /tap to return to reading · double tap to go back/);
  assert.match(gestureHelp({ view: 'picker' }), /tap to select · double tap to go back/);
  for (const step of [5, 1]) {
    const help = gestureHelp({ view: 'picker', positionStep: step });
    assert.match(help, new RegExp(`Swipe ${step}%`));
    assert.match(help, new RegExp(`hold to switch to ${step === 1 ? 5 : 1}%`));
    assert.doesNotMatch(help, /hold to ask/);
  }
  assert.match(gestureHelp({ view: 'transcription' }), /Swipe: scroll · Tap: accept · Double tap: cancel/);
  assert.equal(keyBinding({ code: 'KeyC' }).action, 'ask-toggle');
});
