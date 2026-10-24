import { uncertainWords as engineUncertainWords } from '@pageborne/browser-stt/confidence';
export * from '@pageborne/browser-stt/confidence';
// A display cutoff, not a calibrated probability of a word being correct.
export const SPEECH_CONFIDENCE_THRESHOLD = .7;
export const uncertainWords = (text, words, threshold = SPEECH_CONFIDENCE_THRESHOLD) => engineUncertainWords(text, words, threshold);

// DOM text nodes keep transcript content inert. The mirror is decorative; the
// actual editable textarea remains the accessible source of the question.
export function renderSpeechConfidence(element, text, words) {
  const spans = uncertainWords(text, words).sort((a, b) => a.start - b.start), nodes = []; let offset = 0;
  for (const span of spans) {
    if (span.start < offset) continue;
    nodes.push(document.createTextNode(text.slice(offset, span.start)));
    const node = document.createElement('span'); node.className = 'speech-uncertain'; node.textContent = text.slice(span.start, span.end); nodes.push(node); offset = span.end;
  }
  nodes.push(document.createTextNode(text.slice(offset))); element.replaceChildren(...nodes);
}
