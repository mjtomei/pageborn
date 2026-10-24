// Time real app/SDK line advances at body acknowledgement (before footer work).
// This measures browser scheduling with controlled transport, not physical BLE.
import { chromium, webkit, expect } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { showLibrary, chooseMode, showDockOptions } from './ui-helpers.mjs';

const baseline = process.argv.includes('--baseline');
const out = `test-results/autoscroll-timing${baseline ? '-baseline' : ''}`;
await mkdir(out, { recursive: true });
const probe = { name: 'autoscroll-timing-probe', transform(code, id) {
  if (!id.endsWith('/src/glasses.js')) return;
  return code.replace('this.onReadingAccepted?.(frame);', `
    this.onReadingAccepted?.(frame);
    if (frame.mode === 'auto') {
      const line = Number(bodyText(frame).match(/L(\\d+)/)?.[1]);
      globalThis.__accepted = { y: frame.y, line, at: this.readingAcceptedAt, playing: frame.playing };
      if (frame.playing && globalThis.__measure && globalThis.__frames.at(-1)?.y !== frame.y)
        globalThis.__frames.push(globalThis.__accepted);
    }`);
} };
const vite = await createServer({ cacheDir: '.state/vite-autoscroll-timing', clearScreen: false, plugins: [probe],
  server: { host: '127.0.0.1', port: 0, watch: { usePolling: true } } });
await vite.listen(); const reports = [];
try {
  for (const engine of baseline ? [chromium] : [chromium, webkit]) {
    const browser = await engine.launch({ headless: true, executablePath: engine === chromium ? '/usr/bin/google-chrome' : process.env.WEBKIT_PATH });
    const report = { engine: engine.name(), passed: false, physicalGlasses: false, errors: [], samples: [] }; reports.push(report);
    let page;
    try {
      page = await browser.newPage({ viewport: { width: 440, height: 806 } });
      page.on('pageerror', error => report.errors.push(error.message));
      const storage = new Map();
      await page.exposeFunction('__storage', ({ method, data }) => {
        if (method === 'getLocalStorage' && /^pageborne:models:v1:[a-f0-9]{64}$/.test(data.key)) return JSON.stringify({ id: 'fixture', chunks: 1, headers: {} });
        if (method === 'getLocalStorage') return storage.get(data.key) || '';
        storage.set(data.key, data.value); return true;
      });
      await page.addInitScript(() => {
        const nativeTimeout = setTimeout.bind(window), NativeWorker = Worker;
        window.Worker = class {
          constructor(url, options) { if (!String(url).includes('ensemble-worker')) return new NativeWorker(url, options); }
          postMessage(data) { if (data.operation === 'prepare') queueMicrotask(() => this.onmessage({ data: { id: data.id, result: { backend: 'wasm', verified: true } } })); }
          terminate() {}
        };
        window.__frames = []; window.__measure = false; window.__delay = 0;
        window.flutter_inappwebview = { async callHandler(_, payload) {
          const m = JSON.parse(payload);
          if (m.method.endsWith('LocalStorage')) return window.__storage(m);
          if (window.__delay) await new Promise(resolve => nativeTimeout(resolve, window.__delay));
          return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
        } };
      });
      const tap = () => page.evaluate(() => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { sysEvent: { eventType: 0 } } })));
      const enter = async (kind, value) => {
        await showDockOptions(page); await page.locator(`#${kind}-value`).evaluate(el => el.click());
        await page.locator('#value-input').fill(String(value)); await page.locator('#value-form').evaluate(el => el.requestSubmit());
        await expect(page.locator('#value-dialog')).toBeHidden();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      };
      await page.goto(vite.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled({ timeout: 30000 });
      await page.locator('#file-picker').setInputFiles({ name: 'lines.md', mimeType: 'text/markdown',
        buffer: Buffer.from('```\n' + Array.from({ length: 200 }, (_, i) => `L${String(i).padStart(4, '0')} A measured line.`).join('\n') + '\n```') });
      await showLibrary(page); await page.locator('[data-document-id="lines.md"] .document-card').click(); await chooseMode(page, 'auto');
      const samples = baseline ? [[60, 8, 0], [73, 10, 0], [200, 20, 0]]
        : [[6, 2, 0], [30, 6, 0], [60, 8, 0], [73, 10, 0], [120, 12, 0], [200, 20, 0], [200, 8, 180]];
      for (const [rate, advances, delay] of samples) {
        await enter('speed', rate); await enter('position', 0);
        await expect.poll(() => page.evaluate(() => __accepted?.line)).toBe(0);
        await page.waitForTimeout(250);
        await page.evaluate(delay => { __frames = []; __delay = delay; __measure = true; }, delay);
        await tap();
        await expect.poll(() => page.evaluate(() => __frames.length), { timeout: (advances + 2) * (60000 / rate + 600), intervals: [50] }).toBeGreaterThanOrEqual(advances + 1);
        await tap(); await page.waitForTimeout(delay * 2 + 300);
        const frames = (await page.evaluate(() => __frames)).slice(0, advances + 1);
        report.lastFrames = frames;
        let fullDwellPassed = true;
        for (let i = 1; i < frames.length; i++) {
          assert.equal(frames[i].line, frames[i - 1].line + 1, 'each displayed line advances once without skipping');
          assert.equal(frames[i].y - frames[i - 1].y, 27, 'one native line per advance');
          fullDwellPassed &&= frames[i].at - frames[i - 1].at >= 60000 / rate + delay - 3;
        }
        const elapsedMs = frames.at(-1).at - frames[0].at, measuredLpm = advances * 60000 / elapsedMs;
        const cadencePassed = delay > 0 || measuredLpm >= 60000 / (60000 / rate + 15) && measuredLpm <= rate * 1.02;
        const sample = { rate, advances, transportDelayMs: delay, elapsedSeconds: +(elapsedMs / 1000).toFixed(3),
          expectedSeconds: advances * 60 / rate, measuredLpm: +measuredLpm.toFixed(2), cadencePassed, fullDwellPassed, frames };
        report.samples.push(sample);
        delete report.lastFrames;
        console.log(JSON.stringify({ engine: engine.name(), ...sample, frames: frames.length }));
        if (!baseline) {
          assert(cadencePassed, `selected ${rate} lines/min, measured ${measuredLpm.toFixed(2)}`);
          assert(fullDwellPassed, `each line receives its full dwell after acknowledgement at ${rate} lines/min`);
        }
        await expect(page.locator('#play')).toHaveAttribute('aria-pressed', 'false');
        const paused = await page.evaluate(() => __accepted.y);
        await page.waitForTimeout(600); assert.equal(await page.evaluate(() => __accepted.y), paused, 'pause stops advancement');
        await page.evaluate(() => { __delay = 0; __measure = false; });
      }
      assert.deepEqual(report.errors, []); report.passed = report.samples.every(sample => sample.cadencePassed && sample.fullDwellPassed);
    } catch (error) { report.error = error.stack; await page?.screenshot({ path: `${out}/${engine.name()}-failure.png` }).catch(() => {}); throw error; }
    finally { await browser.close(); }
  }
} finally { await vite.close(); await writeFile(`${out}/results.json`, JSON.stringify(reports, null, 2)); }
