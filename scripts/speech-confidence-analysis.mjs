// Analyse public benchmark fixtures only. Scores are conditional token
// probabilities after decoding filters, not calibrated word correctness.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AutoTokenizer, env } from '@huggingface/transformers';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useBrowserCache = false;
const directory = 'test-results/speech-models';
const results = JSON.parse(await readFile(`${directory}/confidence-results.json`, 'utf8'));
const words = text => Array.from(text.matchAll(/[\p{L}\p{N}']+/gu), match => ({
  text: match[0], normalized: match[0].toLowerCase() === 'mr' ? 'mister' : match[0].toLowerCase(),
  start: match.index, end: match.index + match[0].length,
}));
function align(reference, hypothesis) {
  const cost = Array.from({ length: reference.length + 1 }, (_, i) =>
    Array.from({ length: hypothesis.length + 1 }, (_, j) => i ? j ? 0 : i : j));
  for (let i = 1; i <= reference.length; i++) for (let j = 1; j <= hypothesis.length; j++) {
    cost[i][j] = Math.min(cost[i - 1][j] + 1, cost[i][j - 1] + 1,
      cost[i - 1][j - 1] + Number(reference[i - 1].normalized !== hypothesis[j - 1].normalized));
  }
  let i = reference.length, j = hypothesis.length;
  const deleted = [];
  while (i || j) {
    if (i && j && cost[i][j] === cost[i - 1][j - 1] + Number(reference[i - 1].normalized !== hypothesis[j - 1].normalized)) {
      hypothesis[j - 1].correct = reference[i - 1].normalized === hypothesis[j - 1].normalized;
      hypothesis[j - 1].reference = reference[i - 1].text; i--; j--;
    } else if (j && cost[i][j] === cost[i][j - 1] + 1) {
      hypothesis[j - 1].correct = false; hypothesis[j - 1].reference = null; j--;
    } else { deleted.push(reference[--i].text); }
  }
  return deleted.reverse();
}
const report = { source: results.at, interpretation: 'Exploratory word error detection on the same small corpus; no held-out calibration. Deletions have no output token to highlight.',
  definitions: {
    flag: 'A word is flagged when its score is strictly below the threshold. Positive means an incorrect emitted word.',
    average: 'Arithmetic mean of constituent token probabilities; punctuation-only tokens excluded.',
    minimum: 'Minimum constituent token probability; punctuation-only tokens excluded.',
    specificity: 'TN / (TN + FP): fraction of correct words left unflagged.',
    selectivity: 'TP / (TP + FP): precision, fraction of flagged words that are incorrect. Selectivity is not a universal statistical term; this is the definition used here.',
    recallOfEmittedErrors: 'TP / (TP + FN): sensitivity, fraction of incorrect emitted words flagged.',
  }, models: [] };
for (const profile of results.profiles) {
  env.localModelPath = path.resolve(profile.directory === 'moonshine-tiny' ? '.state/stt-assets' : '.state/stt-benchmark') + '/';
  const tokenizer = await AutoTokenizer.from_pretrained(profile.directory, { local_files_only: true });
  const runs = [];
  for (const run of results.runs.filter(run => run.model === profile.name)) {
    const scores = run.confidence.tokenScores;
    const ids = [], spans = [];
    let text = '';
    for (const score of scores) {
      ids.push(score.token);
      const next = tokenizer.decode(ids, { skip_special_tokens: true, clean_up_tokenization_spaces: false });
      if (!next.startsWith(text)) throw new Error(`Non-monotonic token decoding in ${run.sample}; needs byte-boundary alignment`);
      spans.push({ ...score, start: text.length, end: next.length, text: next.slice(text.length) }); text = next;
    }
    const hypothesis = words(text), reference = words(results.samples.find(sample => sample.file === run.sample).reference);
    if (hypothesis.map(x => x.normalized).join(' ') !== words(run.text).map(x => x.normalized).join(' ')) {
      throw new Error(`Decoded tokens differ from transcript in ${run.model}/${run.sample}`);
    }
    for (const word of hypothesis) {
      word.tokens = spans.filter(span => span.start < word.end && span.end > word.start);
      if (!word.tokens.length) throw new Error('Missing word scores');
      word.average = word.tokens.reduce((sum, token) => sum + token.probability, 0) / word.tokens.length;
      word.minimum = Math.min(...word.tokens.map(token => token.probability));
      word.geometricMean = Math.exp(word.tokens.reduce((sum, token) => sum + token.logProbability, 0) / word.tokens.length);
    }
    const deleted = align(reference, hypothesis);
    const errors = hypothesis.filter(word => !word.correct).length + deleted.length;
    if (errors !== run.wordErrors) throw new Error(`Word error count differs for ${run.sample}: ${errors} vs ${run.wordErrors}`);
    runs.push({ sample: run.sample, noisy: run.noisy, text: run.text, words: hypothesis, deleted });
  }
  const all = runs.flatMap(run => run.words), wrong = all.filter(word => !word.correct);
  const thresholds = ['average', 'minimum', 'geometricMean'].flatMap(metric => [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99].map(threshold => {
    const flagged = all.filter(word => word[metric] < threshold), caught = flagged.filter(word => !word.correct).length;
    const tp = caught, fp = flagged.length - caught, fn = wrong.length - caught, tn = all.length - wrong.length - fp;
    return { metric, threshold, flagged: flagged.length, caught, falseAlarms: flagged.length - caught,
      tp, fp, fn, tn, specificity: tn / (tn + fp),
      selectivity: flagged.length ? tp / flagged.length : null,
      precision: flagged.length ? tp / flagged.length : null, recallOfEmittedErrors: tp / wrong.length };
  }));
  const model = { model: profile.name, words: all.length, erroneousWords: wrong.length,
    deletedWords: runs.reduce((sum, run) => sum + run.deleted.length, 0), thresholds, runs };
  report.models.push(model);
  console.log(JSON.stringify({ ...model, runs: undefined }, null, 2));
}
await writeFile(`${directory}/word-confidence.json`, JSON.stringify(report, null, 2) + '\n');
const fields = ['model', 'metric', 'threshold', 'tp', 'fp', 'fn', 'tn', 'flagged', 'specificity', 'selectivity', 'recallOfEmittedErrors'];
const csv = [fields.join(','), ...report.models.flatMap(model => model.thresholds.map(row =>
  fields.map(field => JSON.stringify(field === 'model' ? model.model : row[field])).join(',')))].join('\n');
await writeFile(`${directory}/word-confidence-thresholds.csv`, csv + '\n');
const percent = value => value == null ? '—' : `${(value * 100).toFixed(1)}%`;
const lines = ['# Word-confidence thresholds', '',
  'Flag a word when its score is **strictly below** the threshold. Average means the arithmetic mean of its token probabilities, not their geometric mean. Punctuation-only tokens are excluded.', '',
  ...Object.entries(report.definitions).filter(([key]) => !['flag', 'average', 'minimum'].includes(key)).map(([key, definition]) => `- **${key}:** ${definition}`), '',
  'Each model was tested on the same 10 recordings, clean and with synthetic noise (20 cases). This is an exploratory, small, paired corpus, not held-out calibration. Omitted words have no token score and are excluded from these classification metrics. A dash means no words were flagged.', ''];
for (const model of report.models) {
  lines.push(`## ${model.model}`, '', `${model.words} emitted words: ${model.erroneousWords} incorrect and ${model.words - model.erroneousWords} correct. ${model.deletedWords} omitted reference words excluded.`, '',
    '| Threshold | Average specificity | Average selectivity | Average error recall | Minimum specificity | Minimum selectivity | Minimum error recall |',
    '|---:|---:|---:|---:|---:|---:|---:|');
  for (const average of model.thresholds.filter(row => row.metric === 'average')) {
    const minimum = model.thresholds.find(row => row.metric === 'minimum' && row.threshold === average.threshold);
    lines.push(`| ${average.threshold.toFixed(2)} | ${[average, minimum].flatMap(row => [row.specificity, row.selectivity, row.recallOfEmittedErrors]).map(percent).join(' | ')} |`);
  }
  lines.push('');
}
await writeFile(`${directory}/word-confidence-thresholds.md`, lines.join('\n'));
