import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('AI bridge defaults to API keys and account login requires explicit experimental opt-in', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pageborne-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  const env = { ...process.env, PAGEBORNE_EXPERIMENTAL_CHATGPT: '' };
  const args = ['ai/cli.js', '--config', file];
  execFileSync(process.execPath, [...args, 'init'], { env });
  const config = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(config.provider, 'openai-compatible'); assert.ok(config.token.length > 20);
  await writeFile(file, JSON.stringify({ ...config, provider: 'chatgpt' }));
  for (const command of ['login', 'models', 'serve']) {
    const result = spawnSync(process.execPath, [...args, command], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1); assert.match(result.stderr, /PAGEBORNE_EXPERIMENTAL_CHATGPT/);
    assert.ok(!result.stderr.includes(config.token));
  }
});
