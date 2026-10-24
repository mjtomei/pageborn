import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { prepareSpeechAssets } from './stt-assets.mjs';
export async function prepareBenchmarks({ gpu = false } = {}) {
  await prepareSpeechAssets();
  const root = '.state/stt-benchmark'; await mkdir(root, { recursive: true });
  const get = async url => { const response = await fetch(url, { signal: AbortSignal.timeout(120000) }); if (!response.ok) throw new Error(`HTTP ${response.status} downloading benchmark fixture`); return response; };
  const models = JSON.parse(await readFile('vendor/stt/benchmark-models.json', 'utf8'));
  if (gpu) models.push(...JSON.parse(await readFile('vendor/stt/gpu-benchmark-models.json', 'utf8')).map(model => ({ ...model, gpu: true })));
  for (const model of models) {
    for (const entry of model.files) {
      const file = path.join(root, model.directory, entry.file);
      const valid = b => b.length === entry.bytes && createHash('sha256').update(b).digest('hex') === entry.sha256;
      try { if (valid(await readFile(file))) continue; } catch {}
      const data = Buffer.from(await (await get(`https://huggingface.co/${model.repository}/resolve/${model.revision}/${entry.file}`)).arrayBuffer());
      if (!valid(data)) throw new Error(`Benchmark model checksum mismatch: ${entry.file}`);
      await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, data);
    }
    await writeFile(path.join(root, `${model.directory}${model.gpu ? '-gpu' : ''}.json`), JSON.stringify(model));
  }
  const out = 'test-results/speech'; await mkdir(out, { recursive: true });
  const samples = JSON.parse(await readFile('vendor/stt/benchmark-samples.json', 'utf8'));
  for (const sample of [{ file: 'jfk.wav', source: 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav' }, ...samples]) {
    try { await readFile(path.join(out, sample.file)); continue; } catch {}
    let url = sample.source;
    if (!url.endsWith('.wav')) {
      const endpoint = url.includes('datasets-server') ? url : 'https://datasets-server.huggingface.co/rows?dataset=hf-internal-testing/librispeech_asr_dummy&config=clean&split=validation&offset=0&length=3';
      const rows = (await (await get(endpoint)).json()).rows;
      const row = rows.find(x => `${x.row.id}.wav` === sample.file)?.row;
      if (!row || row.text !== sample.reference) throw new Error('Public fixture changed; review reference before benchmarking');
      url = row.audio[0].src;
    }
    await writeFile(path.join(out, sample.file), Buffer.from(await (await get(url)).arrayBuffer()));
  }
  await writeFile(path.join(out, 'benchmark-samples.json'), JSON.stringify(samples));
}
