import buckets from '../vendor/wordfreq/en.json' with { type: 'json' };
import { vocabularyWords } from './speech-vocabulary.js';
import { filenamesInText, filenameVocabulary } from '@pageborne/browser-stt';

// Keep the offline frequency table out of both speech workers. Build the
// lookup only when dictation first needs it, not while opening a document.
let frequencies;
const normalize = term => term.normalize('NFKC').toLowerCase().replace(/’/g, "'");
export function wordCommonness(term) {
  frequencies ||= new Map(buckets.flatMap(([zipf, words]) => words.split(' ').map(word => [word, zipf / 100])));
  const key = normalize(term);
  const exact = frequencies.get(key);
  if (exact !== undefined) return exact;
  if (key.endsWith("'s")) return wordCommonness(key.slice(0, -2));
  // An unfamiliar spelling of a common compound should not look maximally
  // rare just because the corpus stores its components separately.
  const parts = key.split(/[-.]/).filter(Boolean);
  return parts.length > 1 ? Math.min(...parts.map(wordCommonness)) : 2.5;
}

export function vocabularyScore(term, distanceWords = 0) {
  const rarity = Math.max(0, Math.min(3, 5.5 - wordCommonness(term)));
  return rarity * 2 ** (-Math.abs(distanceWords) / 120);
}

function words(text) {
  // Replace URLs without shifting offsets. Do not turn a URL or an overlong
  // OCR fragment into several plausible-looking vocabulary candidates.
  return [...String(text || '').replace(/(?:https?:\/\/|www\.)\S+/gi, value => ' '.repeat(value.length))
    .matchAll(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu)];
}

export function speechFilenames(custom, context = null, history = []) {
  const names = filenamesInText(custom);
  if (context) {
    // Preserve complete recent replies, including a reply still arriving.
    // A filename at the start of a long answer must not disappear at 800 chars.
    for (const turn of history.slice(-24).reverse()) names.push(...filenamesInText(String(turn.content || '').slice(0, 16000)).reverse());
    names.push(...filenamesInText(context.title), ...filenamesInText(context.focus));
  }
  return [...new Set(names)].slice(0, 24);
}

export function speechVocabulary(custom, context = null, history = []) {
  const manual = vocabularyWords(custom);
  const files = filenameVocabulary(speechFilenames(custom, context, history));
  if (!context) return [...new Set([...manual, ...files])];
  const seen = new Set([...manual, ...files].map(normalize)), candidates = new Map();
  const add = (term, distance, weight = 1) => {
    if (term.length < 3 || term.length > 40 || !/^\p{L}/u.test(term) || /(.)\1{3}/u.test(term)) return;
    const key = normalize(term);
    if (seen.has(key)) return;
    const score = vocabularyScore(term, distance) * weight;
    if (score < .2) return; // Exclude weak/far-away hints, even on Tiny's uncapped path.
    if (!candidates.has(key) || score > candidates.get(key).score) candidates.set(key, { term, score });
  };
  const source = String(context.passage || '');
  const focus = String(context.focus || '').slice(0, 1000);
  const offset = Math.max(0, Math.min(source.length, Number.isFinite(context.focusOffset)
    ? context.focusOffset : Math.max(0, source.indexOf(focus))));
  const start = Math.max(0, Math.min(offset - 2000, source.length - 4000));
  const passage = source.slice(start, start + 4000), tokens = words(passage);
  let focusWord = tokens.findIndex(match => match.index + match[0].length > offset - start);
  if (focusWord < 0) focusWord = tokens.length;
  tokens.forEach((match, index) => add(match[0], index - focusWord));
  // Only use the separate focus if there is no source window. Duplicating it
  // at distance zero can favor the wrong occurrence of a repeated phrase.
  if (!passage) words(focus).forEach((match, index) => add(match[0], index));
  words(String(context.title || '').slice(0, 300)).forEach(match => add(match[0], 0, .65));
  history.slice(-4).reverse().forEach((turn, index) => {
    words(String(turn.content || '').slice(-800)).forEach(match => add(match[0], 0, .5 * .7 ** index));
  });
  // No fixed automatic term count: Tiny can bias every eligible candidate;
  // Whisper packs these in priority order into its actual tokenizer budget.
  return [...new Set([...manual, ...files, ...[...candidates.values()].sort((a, b) => b.score - a.score).map(item => item.term)])];
}
