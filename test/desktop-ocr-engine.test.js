import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Engine } from '../desktop/ocr/daemon.mjs';

// Exercise actual child-process exit/pipe ordering without Python or CUDA.
function fixture(t, behavior = 'reply', options = {}) {
  let starts = 0;
  const engine = new Engine({ python: 'unused', telemetryDir: '/unused' }, '/unused', {
    startupTimeoutMs: 5_000, inferenceTimeoutMs: 5_000,
    spawnProcess() {
      starts++;
      const program = `
        const readline = require('node:readline');
        if (${JSON.stringify(behavior)} !== 'startup-stall') console.log(JSON.stringify({ready:true}));
        readline.createInterface({input:process.stdin}).on('line', line => {
          if (${JSON.stringify(behavior)} !== 'reply') return;
          const {items} = JSON.parse(line);
          console.log(JSON.stringify({items:items.map(item=>({...item,markdown:'Recognized',extracted:{text:[]}}))}));
        });
      `;
      return spawn(process.execPath, ['-e', program], { stdio: ['pipe', 'pipe', 'pipe'] });
    }, ...options,
  });
  t.after(() => engine.stop());
  return { engine, starts: () => starts };
}

test('intentional worker stop permits a subsequent document without latching a model failure', async t => {
  const { engine, starts } = fixture(t);
  await engine.infer([{ number: 1 }]);
  await engine.stop();
  assert.equal(engine.failed, undefined);
  const result = await engine.infer([{ number: 2 }]);
  assert.equal(result.items[0].number, 2);
  assert.equal(starts(), 2);
});

test('unexpected worker exits remain fatal and never automatically reload the model', async t => {
  const { engine, starts } = fixture(t);
  await engine.start();
  const closed = once(engine.child, 'close');
  engine.child.kill('SIGTERM'); await closed;
  await assert.rejects(engine.infer([{ number: 2 }]), /restart required/);
  assert.equal(starts(), 1);
});

test('inference timeout rejects the pending batch and stays fatal', async t => {
  const { engine, starts } = fixture(t, 'inference-stall', { inferenceTimeoutMs: 30 });
  await assert.rejects(engine.infer([{ number: 1 }]), /batch timed out/);
  await engine.stop();
  await assert.rejects(engine.infer([{ number: 2 }]), /batch timed out/);
  assert.equal(starts(), 1);
});

test('intentional shutdown during startup settles waiters without marking a crash', async t => {
  const { engine } = fixture(t, 'startup-stall');
  const starting = assert.rejects(engine.start(), /stopped intentionally/);
  await engine.stop(); await starting;
  assert.equal(engine.failed, undefined);
});

test('startup timeout stays fatal after child cleanup', async t => {
  const { engine } = fixture(t, 'startup-stall', { startupTimeoutMs: 30 });
  await assert.rejects(engine.start(), /startup timed out/);
  await engine.stop();
  await assert.rejects(engine.start(), /startup timed out/);
});
