// One binding table for the SDK, preview gestures, keyboard, menus and help.
// Event values match even_hub_sdk 0.0.14 (OsEventTypeList).
export const GESTURES = Object.freeze({
  tap: { action: 'play', eventType: 0 },
  'swipe-up': { action: 'previous', eventType: 1 },
  'swipe-down': { action: 'next', eventType: 2 },
  'double-tap': { action: 'back', eventType: 3 },
  'hold-start': { action: 'ask-hold', eventType: 9 },
  'hold-end': { action: 'ask-release', eventType: 10 },
  'hold-cancel': { action: 'ask-cancel' },
  // Even opens its own menu for tap-then-hold. The preview presents the same
  // app entries locally; OS-owned brightness/app switching are not SDK actions.
  menu: { action: 'menu' },
});
export const SWIPES = Object.freeze({ up: 'swipe-up', down: 'swipe-down', left: 'swipe-down', right: 'swipe-up' });
export const TRANSCRIPTION_HINT = 'Swipe: scroll · Tap: accept · Double tap: cancel';
export const transcriptionHint = pages => pages > 1 ? TRANSCRIPTION_HINT : 'Tap: accept · Double tap: cancel';
export const READING_MODES = Object.freeze([
  { value: 'page', label: 'Pages' },
  { value: 'auto', label: 'Autoscroll' },
  { value: 'speed', label: 'Speed read' },
]);
export const APP_MENU = Object.freeze([
  { itemID: 3, itemName: 'Change mode', action: 'mode' },
  { itemID: 8, itemName: 'Go to position', action: 'position' },
  { itemID: 5, itemName: 'Start of doc', action: 'start' },
  { itemID: 7, itemName: 'Choose document', action: 'documents' },
  { itemID: 9, itemName: 'Footnotes', action: 'footnotes' },
  { itemID: 10, itemName: 'Ask about this', action: 'ask' },
]);
const LATEST_ITEM = Object.freeze({ itemID: 11, itemName: 'Go to latest', action: 'ask-latest' });
export const appMenu = (ask = false) => ask ? APP_MENU.map(item => item.action === 'position' ? LATEST_ITEM : item) : APP_MENU;
export const KEY_BINDINGS = Object.freeze({
  Space: { gesture: 'tap', label: 'Space' }, Enter: { gesture: 'tap', label: 'Enter' },
  Escape: { gesture: 'double-tap', label: 'Esc' },
  ArrowUp: { gesture: 'swipe-up', label: '↑' }, ArrowDown: { gesture: 'swipe-down', label: '↓' },
  ArrowLeft: { gesture: 'swipe-up', label: '←' }, ArrowRight: { gesture: 'swipe-down', label: '→' },
  KeyA: { gesture: 'hold-start', release: 'hold-end', label: 'hold A' },
  KeyC: { action: 'ask-toggle', label: 'C' },
  KeyM: { gesture: 'menu', label: 'M' },
  PageUp: { action: 'previous-page', label: 'Page Up' }, PageDown: { action: 'next-page', label: 'Page Down' },
  Home: { action: 'start', label: 'Home' }, End: { action: 'end', label: 'End' },
});
export const PREVIEW_TIMING = Object.freeze({ holdMs: 550, doubleTapMs: 300, tapSlop: 12, doubleTapSlop: 36, swipeDistance: 40 });
export function actionForGesture(gesture) { return GESTURES[gesture]?.action || null; }
export function actionForMenu(id) { return [...APP_MENU, LATEST_ITEM].find(item => item.itemID === id)?.action || null; }
export function keyBinding(event) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return null;
  const code = event.code || ({ ' ': 'Space', a: 'KeyA', A: 'KeyA', m: 'KeyM', M: 'KeyM' }[event.key] || event.key);
  return KEY_BINDINGS[code] ? { code, ...KEY_BINDINGS[code] } : null;
}
export function actionForEvent(event) {
  if (event.menuItemClickEvent) return actionForMenu(event.menuItemClickEvent.itemID);
  // Proto3 omits zero-valued clicks. Real events take precedence over empty
  // placeholder objects, including long presses delivered in text/list events.
  const types = [event.sysEvent, event.textEvent, event.listEvent].filter(Boolean).map(e => e.eventType ?? 0);
  if (types.includes(7) || types.includes(6)) return 'exit';
  for (const gesture of ['hold-start', 'hold-end', 'double-tap']) if (types.includes(GESTURES[gesture].eventType)) return actionForGesture(gesture);
  if (types.includes(4)) return 'suspend';
  if (types.includes(5)) return 'resume';
  for (const gesture of ['swipe-up', 'swipe-down', 'tap']) if (types.includes(GESTURES[gesture].eventType)) return actionForGesture(gesture);
  return null;
}
const keyLabels = gesture => Object.values(KEY_BINDINGS).filter(b => b.gesture === gesture).map(b => b.label).join('/');
export function gestureHelp({ mode = 'page', view = 'reader', documentPicker = false, positionStep } = {}) {
  if (positionStep) return `Swipe ${positionStep}% · tap to read · double tap to go back · hold to switch to ${positionStep === 1 ? 5 : 1}%.`;
  if (view === 'transcription') return `${TRANSCRIPTION_HINT}.`;
  const swipe = view === 'reader' ? mode === 'page' ? 'Swipe to turn pages' : 'Swipe up to speed up, down to slow down' : view === 'picker' || view === 'menu' ? 'Swipe to choose' : 'Swipe to browse';
  const tap = view === 'reader' ? mode === 'page' ? 'switch reading / Ask' : 'pause/resume' : view === 'picker' || view === 'menu' ? 'select' : 'return to reading';
  const doubleTap = view === 'reader' ? mode === 'page' ? 'open the library' : 'switch reading / Ask' : 'go back';
  return `${swipe} · tap to ${tap} · double tap to ${doubleTap} · ${documentPicker ? 'hold to sync the library.' : 'hold to ask, release to review.'}`;
}
export function keyboardHelp() {
  return `Preview: swipe down/left for next or slower; up/right for previous or faster. Tap then hold for the app menu. Keyboard: ${keyLabels('tap')}: tap · ${keyLabels('double-tap')}: library in Pages; Ask in Autoscroll/Speed read; back in selectors or Ask · ${keyLabels('swipe-up')}/${keyLabels('swipe-down')}: swipe · ${keyLabels('hold-start')}: sync in the document picker; switch 5%/1% in Go to position; otherwise ask, release to review · ${keyLabels('menu')}: app menu · C: switch reading / Ask · Page Up/Down: turn pages · Home/End: jump.`;
}
