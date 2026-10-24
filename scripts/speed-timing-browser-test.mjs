// Exercise real reader scheduling through the SDK with controlled transport.
// This measures browser overhead, not physical Bluetooth throughput.
import { chromium, webkit, expect } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { showLibrary, chooseMode, showDockOptions } from './ui-helpers.mjs';

const out = 'test-results/speed-timing'; await mkdir(out, { recursive: true });
const vite = await createServer({ cacheDir: '.state/vite-speed-timing', clearScreen: false,
  server: { host: '127.0.0.1', port: 0, watch: { usePolling: true } } });
await vite.listen(); const reports = [];
try {
  for (const engine of [chromium, webkit]) {
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
        window.__frames = []; window.__allFrames = []; window.__delay = 0; window.__statusDelay = null; window.__storageDelay = 0; window.__ops = []; window.__body = '';
        window.flutter_inappwebview = { async callHandler(_, payload) {
          const m = JSON.parse(payload);
          const op = { method: m.method, box: m.data?.containerName, start: performance.now() }; window.__ops.push(op);
          const delay = m.method.endsWith('LocalStorage') ? window.__storageDelay
            : m.data?.containerName === 'status' ? window.__statusDelay ?? window.__delay : window.__delay;
          if (delay) await new Promise(resolve => nativeTimeout(resolve, delay));
          op.end = performance.now();
          if (m.method.endsWith('LocalStorage')) return window.__storage(m);
          for (const box of m.method === 'textContainerUpgrade' ? [m.data] : m.data?.textObject || []) {
            if (box.containerName !== 'body') continue;
            window.__body = box.content.trim();
            window.__allFrames.push({ text: window.__body, at: performance.now() });
            if (/^w\d/.test(window.__body)) window.__frames.push({ text: window.__body, at: performance.now() });
          }
          return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
        } };
      });
      const tap = () => page.evaluate(() => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { sysEvent: { eventType: 0 } } })));
      const enter = async (kind, value) => {
        await showDockOptions(page); await page.locator(`#${kind}-value`).evaluate(el => el.click());
        await page.locator('#value-input').fill(String(value)); await page.locator('#value-form').evaluate(el => el.requestSubmit());
        await expect(page.locator('#value-dialog')).toBeHidden();
        // Native dialog close events are queued until rendering; let the old
        // editor finish closing before immediately opening the next one.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      };
      await page.goto(vite.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled({ timeout: 30000 });
      await page.locator('#file-picker').setInputFiles({ name: 'pace.txt', mimeType: 'text/plain', buffer: Buffer.from(Array.from({ length: 1200 }, (_, i) => `w${String(i).padStart(4, '0')}`).join(' ')) });
      await showLibrary(page); await page.locator('[data-document-id="pace.txt"] .document-card').click(); await chooseMode(page, 'speed');
      for (const [rate, count, delay] of [[1000, 1, 0], [1000, 3, 0], [6000, 3, 0], [6000, 10, 0], [6000, 3, 80]]) {
        await enter('word-group', count); await enter('speed', rate); await enter('position', 0);
        await expect.poll(() => page.evaluate(() => __body)).toMatch(/^w0000/);
        await page.waitForTimeout(250);
        await page.evaluate(delay => { __frames = []; __delay = delay; }, delay);
        await tap();
        await expect.poll(() => page.evaluate(() => __frames.length), { timeout: 15000, intervals: [50] }).toBeGreaterThanOrEqual(16);
        await tap(); await page.waitForTimeout(400);
        const frames = (await page.evaluate(() => __frames)).filter((f, i, all) => !i || f.text !== all[i - 1].text);
        const numbers = frames.flatMap(f => f.text.match(/w\d+/g).map(w => Number(w.slice(1))));
        for (let i = 1; i < numbers.length; i++) assert.equal(numbers[i], numbers[i - 1] + 1, 'every word displayed once, including under backpressure');
        const elapsed = frames.at(-1).at - frames[0].at;
        const first = Number(frames[0].text.match(/w(\d+)/)[1]), last = Number(frames.at(-1).text.match(/w(\d+)/)[1]);
        const measured = (last - first) * 60000 / elapsed;
        report.samples.push({ rate, count, transportDelayMs: delay, measuredWpm: Math.round(measured), frames: frames.length });
        // Allow a bounded rendering/scheduling cost per group, not the old
        // 100–200 ms quantization. Relative overhead grows at very high WPM.
        const minimumRate = count * 60000 / (count * 60000 / rate + 12);
        if (!delay) assert(measured >= minimumRate && measured <= rate * 1.1, `selected ${rate} WPM / ${count} words, measured ${Math.round(measured)}`);
        else for (let i = 1; i < frames.length; i++) assert(frames[i].at - frames[i - 1].at >= delay + count * 60000 / rate - 3, 'full dwell after acknowledgement');
        const paused = await page.evaluate(() => __body); await page.waitForTimeout(180); assert.equal(await page.evaluate(() => __body), paused);
        await page.evaluate(() => { __delay = 0; });
      }
      // Sustain equal-size groups across percent/page/footer changes and native
      // preference/checkpoint writes. Footer transfer must overlap word dwell.
      await enter('word-group', 3); await enter('speed', 1000); await enter('position', 0);
      await expect.poll(() => page.evaluate(() => __body)).toMatch(/^w0000/);
      await page.waitForTimeout(250);
      await page.evaluate(() => { __frames = []; __ops = []; __delay = 20; __statusDelay = 80; __storageDelay = 5; });
      await tap(); await page.waitForTimeout(16000); await tap(); await page.waitForTimeout(400);
      const sustained = await page.evaluate(() => ({ frames: __frames, ops: __ops }));
      const frames = sustained.frames.filter((f, i, all) => !i || f.text !== all[i - 1].text);
      const intervals = frames.slice(1).map((f, i) => f.at - frames[i].at);
      const ordered = intervals.toSorted((a, b) => a - b), percentile = p => ordered[Math.floor((ordered.length - 1) * p)];
      report.sustained = { rate: 1000, count: 3, bodyDelayMs: 20, statusDelayMs: 80, storageDelayMs: 5,
        p10: percentile(.1), p50: percentile(.5), p90: percentile(.9), max: ordered.at(-1), frames: frames.length,
        footerUpdates: sustained.ops.filter(op => op.box === 'status').length,
        storageWrites: sustained.ops.filter(op => op.method === 'setLocalStorage').length, intervals };
      await writeFile(`${out}/${engine.name()}-sustained.json`, JSON.stringify(sustained, null, 2));
      const words = frames.flatMap(f => f.text.match(/w\d+/g).map(w => Number(w.slice(1))));
      for (let i = 1; i < words.length; i++) assert.equal(words[i], words[i - 1] + 1, 'sustained playback never skips words');
      assert(report.sustained.footerUpdates >= 8 && report.sustained.storageWrites >= 8, 'exercise periodic footer updates and saving');
      assert(intervals.every(ms => ms >= 195), 'every group receives its full 180 ms dwell plus next body transfer');
      assert(percentile(.9) - percentile(.1) < 40, `footer must not add an 80 ms pause: ${JSON.stringify(report.sustained)}`);
      assert(percentile(.9) < 240, 'footer transfer occurs during the visible word interval');
      await page.evaluate(() => { __delay = 0; __statusDelay = null; __storageDelay = 0; });
      await showDockOptions(page); await page.locator('#speed').focus(); await page.keyboard.press('Home'); await expect(page.locator('#speed-value')).toHaveText('60 wpm');
      await page.keyboard.press('End'); await expect(page.locator('#speed-value')).toHaveText('6000 wpm'); await expect(page.locator('#speed-up')).toBeDisabled();
      await page.keyboard.press('ArrowLeft'); await expect(page.locator('#speed-value')).toHaveText('5000 wpm');
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { sysEvent: { eventType: 1 } } })));
      await expect(page.locator('#speed-value')).toHaveText('6000 wpm');
      await page.locator('#speed-value').evaluate(el => el.click());
      for (const invalid of ['6001', '59']) { await page.locator('#value-input').fill(invalid); await page.locator('#value-apply').click(); await expect(page.locator('#value-dialog')).toBeVisible(); }
      await page.locator('#value-cancel').click();
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await page.waitForTimeout(650);
      await page.reload(); await expect(page.locator('#import')).toBeEnabled({ timeout: 30000 });
      await expect(page.locator('#speed-value')).toHaveText('6000 wpm'); await expect(page.locator('#play')).toHaveAttribute('aria-pressed', 'false');
      report.controlsAndPersistence = true;
      await page.locator('#file-picker').setInputFiles({ name: 'punctuation.txt', mimeType: 'text/plain',
        buffer: Buffer.from('w9000 . w9001 , w9002 ! w9003 ? w9004 … w9005 . ” w9006 ; w9007 。 " w9008 w9009 " “ w9010 ” ( w9011 ) "w9012 w9013 "') });
      await showLibrary(page); await page.locator('[data-document-id="punctuation.txt"] .document-card').click();
      await chooseMode(page, 'speed'); await enter('word-group', 1); await enter('speed', 120);
      await expect.poll(() => page.evaluate(() => __body)).toBe('w9000.');
      await page.evaluate(() => { __allFrames = []; }); await tap();
      await expect.poll(() => page.evaluate(() => __body), { timeout: 12000 }).toBe('w9013"');
      await expect(page.locator('#play')).toHaveAttribute('aria-pressed', 'false');
      const punctuationFrames = (await page.evaluate(() => __allFrames)).filter((f, i, all) => !i || f.text !== all[i - 1].text);
      assert.deepEqual(punctuationFrames.map(f => f.text), ['w9001,', 'w9002!', 'w9003?', 'w9004…', 'w9005.”', 'w9006;', 'w9007。',
        '"w9008', 'w9009"', '“w9010”', '(w9011)', '"w9012', 'w9013"']);
      for (let i = 1; i < punctuationFrames.length; i++) assert(punctuationFrames[i].at - punctuationFrames[i - 1].at < 650,
        'detached punctuation does not add another word of dwell');
      report.punctuation = { passed: true, rate: 120, frames: punctuationFrames };
      assert.deepEqual(report.errors, []); report.passed = true;
    } catch (error) { report.error = error.stack; await page?.screenshot({ path: `${out}/${engine.name()}-failure.png` }).catch(() => {}); throw error; }
    finally { await browser.close(); }
  }
} finally { await vite.close(); await writeFile(`${out}/results.json`, JSON.stringify(reports, null, 2)); }
console.log(JSON.stringify(reports));
