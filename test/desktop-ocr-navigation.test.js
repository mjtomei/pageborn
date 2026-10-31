import test from 'node:test';
import assert from 'node:assert/strict';
import { attachCheckpointNavigation } from '../desktop/ocr/navigation.mjs';

const saved = () => ({ pageScales: [[1, 1], [2, 1]], layout: { blocks: [
  { page: 1, kind: 'figure', lines: [] },
  { page: 2, kind: 'figure', lines: [], sourceTransform: [0, 1, -1, 0, 1200, 0] },
] } });
const checkpoint = number => ({ number, turn: number === 2 ? 90 : 0, extracted: { width: 900, height: 1200,
  text: [{ text: `CHAPTER ${number}`, x: 250, y: 210, width: 400, height: 24 },
    { text: 'THE CHAPTER TITLE', x: 200, y: 265, width: 500, height: 24 }] } });

test('desktop OCR checkpoints add navigation to whole-page fallbacks without changing layout or recognition', async () => {
  const artifact = saved(), before = structuredClone(artifact), reads = [];
  assert.equal(await attachCheckpointNavigation(artifact, async number => { reads.push(number); return checkpoint(number); }), true);
  assert.deepEqual(reads, [1, 2]);
  assert.deepEqual(artifact.layout.blocks, before.layout.blocks);
  assert.deepEqual(artifact.layout.navigation.sections.map(e => [e.title, e.page, e.point]), [
    ['CHAPTER 1 — THE CHAPTER TITLE', 1, { x: 250, y: 210 }],
    ['CHAPTER 2 — THE CHAPTER TITLE', 2, { x: 990, y: 250 }],
  ]);
  assert.equal(await attachCheckpointNavigation(artifact, async () => { throw Error('Already upgraded'); }), false);
});

test('missing or cancelled checkpoint metadata never commits incomplete navigation', async () => {
  for (const read of [async n => n === 1 ? checkpoint(n) : null, async n => ({ ...checkpoint(n), number: 99 })]) {
    const artifact = saved();
    assert.equal(await attachCheckpointNavigation(artifact, read), false);
    assert.equal(artifact.layout.navigation, undefined);
  }
  const artifact = saved(); let current = true;
  assert.equal(await attachCheckpointNavigation(artifact, async n => { current = false; return checkpoint(n); }, () => current), false);
  assert.equal(artifact.layout.navigation, undefined);
});
