import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { VISIBLE_LINES } from '../src/native-text.js';

// Collect evidence from the current app before changing its scrolling behavior.
// Completing this script does not establish that either visual bug reproduced.
export async function runScrollReproduction({ act, input, shot, until, observed, recording, resultDir,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const start = performance.now();
  const state = () => {
    const value = observed();
    return { atMs: performance.now() - start, position: value.position, slider: value.slider,
      page: value.page, mode: value.mode, connection: value.connection,
      passageLines: value.passageLines,
      passage: value.passage?.slice(0, 180), bridgeActive: value.diagnostics?.active,
      counts: { ...value.diagnostics?.counts } };
  };
  const report = { startedAt: new Date().toISOString(), appVersion: observed().diagnostics?.version,
    review: 'pending', bugsReproduced: { pageRubberbanding: null },
    note: 'Video review is required to check for text movement during page swipes.', stages: [] };
  let stage;
  const mark = (type, details = {}) => recording?.mark(type, details);
  const select = async (mode, value) => {
    await act({ kind: 'click', selector: `#mode-${mode}` });
    await act({ kind: 'range', selector: '#position', value });
    await until(() => observed().mode === mode && Number(observed().slider) === value, `${mode} at slider ${value}`);
    await sleep(700);
  };
  const sweep = async (action, count, intervalMs) => {
    for (let i = 0; i < count; i++) {
      const before = state();
      mark('scroll-repro-input', { stage: stage.name, index: stage.samples.length, action, slider: before.slider });
      await input(action, 0); // Record the animation immediately; do not wait 200 ms first.
      await sleep(Math.max(0, intervalMs - (state().atMs - before.atMs)));
      const after = state();
      stage.samples.push({ action, before, after });
      if (after.connection !== 'Native text connected') throw new Error(`Display disconnected during ${stage.name}`);
    }
  };
  const runStage = async (name, mode, slider, gestures) => {
    stage = { name, mode, slider, samples: [] }; report.stages.push(stage);
    mark('scroll-repro-stage-setup', { name });
    await select(mode, slider);
    stage.before = state();
    mark('scroll-repro-stage-start', { name, slider });
    await shot(`${name}-before`);
    for (const [action, count, interval] of gestures) await sweep(action, count, interval);
    await sleep(700);
    stage.after = state();
    await shot(`${name}-after`);
    mark('scroll-repro-stage-end', { name });
  };
  try {
    // Static pages must not slide during a swipe, including at the doc's ends.
    await runStage('scroll-01-pages-middle', 'page', 400, [['down', 5, 700], ['up', 5, 700]]);
    await runStage('scroll-02-pages-start', 'page', 0, [['up', 3, 700], ['down', 3, 700]]);
    await runStage('scroll-03-pages-end', 'page', 1000, [['down', 3, 700], ['up', 3, 700]]);
    await act({ kind: 'click', selector: '#mode-auto' });
    await runStage('scroll-07-pages-after-auto', 'page', 620, [['down', 3, 700]]);
    await runStage('scroll-09-pages-zero-overlap', 'page', 403, [['down', 1, 700], ['up', 1, 700]]);
    const before = stage.before.passageLines;
    const advanced = stage.samples[0].after.passageLines;
    assert.deepEqual(advanced.slice(0, 4), before.slice(VISIBLE_LINES, VISIBLE_LINES + 4), 'full page turn after a phone jump');
    assert.deepEqual(stage.after.passageLines.slice(0, 8), before.slice(0, 8), 'backward swipe restores the page');
    stage.zeroOverlapVerified = true;
    report.completed = true;
  } catch (error) {
    report.completed = false; report.error = error.message;
    throw error;
  } finally {
    report.durationMs = performance.now() - start;
    await writeFile(path.join(resultDir, 'scroll-reproduction.json'), JSON.stringify(report, null, 2));
  }
  return { completed: report.completed, review: report.review, bugsReproduced: report.bugsReproduced,
    stages: report.stages.length, report: 'scroll-reproduction.json' };
}
