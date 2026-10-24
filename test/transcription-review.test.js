import test from 'node:test';
import assert from 'node:assert/strict';
import { transcriptionReview, reviewDialog, liveTranscriptionDialog } from '../src/transcription-review.js';

test('swipe hint appears only when a live or review transcript spans multiple panes', () => {
  for (const text of ['', 'A short question', 'A much longer spoken question. '.repeat(30)]) {
    const pages = transcriptionReview(text);
    for (const dialog of [reviewDialog(pages), liveTranscriptionDialog('listening', text)]) {
      assert.equal(dialog.hint.includes('Swipe'), pages.pages.length > 1);
      assert(dialog.hint.endsWith('Tap: accept · Double tap: cancel'));
    }
  }
});
