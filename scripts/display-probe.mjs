// Test-only observation after the real SDK dispatch completes. The UI tests
// inspect accepted dialogs and the native SDK text containers.
export const displayProbe = () => ({ name: 'display-probe', transform(code, id) {
  if (id.endsWith('/src/ask-ui.js')) return code.replace('this.session = new AskSession', 'globalThis.__askUI = this; this.session = new AskSession');
  if (!id.endsWith('/src/glasses.js')) return;
  return code.replace('this.onAccepted = onAccepted;', 'globalThis.__glasses = this; this.onAccepted = onAccepted;').replace('this.acceptedFrame = frame;', `
    globalThis.__displayDialog = dialog || null;
    globalThis.__displayFrame = frame;
    globalThis.__displayGeometry = dialog ? transcriptionGeometry(dialog) : null;
    globalThis.__reviewText = dialog?.text || '';
    globalThis.__status = content.status;
    this.acceptedFrame = frame;`);
} });
