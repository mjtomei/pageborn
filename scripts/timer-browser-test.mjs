import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';

const vite = await createServer({ optimizeDeps: { noDiscovery: true }, server: { host: '127.0.0.1', port: 0, watch: { usePolling: true } }, clearScreen: false }); await vite.listen();
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const results = {};
try {
  const page = await browser.newPage();
  await page.route('**/timer-probe', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>SDK timer regression</title>' }));
  await page.goto(new URL('timer-probe', vite.resolvedUrls.local[0]).href);
  await page.evaluate(async () => {
    window.nativeDelay = ms => new Promise(resolve => setTimeout(resolve, ms));
    // Capture real timers before the SDK replaces them.
    const nativeTimeout = setTimeout.bind(window);
    window.nativeDelay = ms => new Promise(resolve => nativeTimeout(resolve, ms));
    window.flutter_inappwebview = { callHandler: async () => true };
    await import('/node_modules/@evenrealities/even_hub_sdk/dist/index.js');
  });
  await expect.poll(() => page.evaluate(() => typeof window.__tickShadowTimers)).toBe('function');
  results.sdkBaseline = await page.evaluate(async () => {
    let count = 0;
    setTimeout(() => count++, 40);
    window.__tickShadowTimers(50);
    const shadowCount = count;
    await window.nativeDelay(80);
    let recursive = 0;
    const repeat = () => { recursive++; if (recursive < 8) setTimeout(repeat, 4000); };
    setTimeout(repeat, 4000); window.__tickShadowTimers(4000);
    return { shadowCount, totalCount: count, callbacksInOneTick: recursive };
  });
  assert.deepEqual(results.sdkBaseline, { shadowCount: 1, totalCount: 2, callbacksInOneTick: 8 });
  results.protected = await page.evaluate(async () => {
    const { safeTimeout, cancelTimeout } = await import('/src/timers.js');
    let count = 0;
    safeTimeout(() => count++, 40); window.__tickShadowTimers(50);
    await window.nativeDelay(80);
    let recursive = 0, timer;
    const repeat = () => { recursive++; timer = safeTimeout(repeat, 4000); };
    timer = safeTimeout(repeat, 4000); window.__tickShadowTimers(4000);
    await Promise.resolve(); const once = recursive;
    window.__tickShadowTimers(4000); await Promise.resolve(); const twice = recursive;
    cancelTimeout(timer);
    let cancelled = 0; const pending = safeTimeout(() => cancelled++, 10);
    window.__tickShadowTimers(20); cancelTimeout(pending); await window.nativeDelay(30);
    return { totalCount: count, once, twice, cancelled };
  });
  assert.deepEqual(results.protected, { totalCount: 1, once: 1, twice: 2, cancelled: 0 });
  results.cancelExpired = await page.evaluate(async () => {
    const { safeTimeout, cancelTimeout } = await import('/src/timers.js');
    let pendingFinished = false, ticks = 0, timer;
    safeTimeout(() => { pendingFinished = true; }, 350);
    const repeat = () => {
      ticks++;
      cancelTimeout(timer); // expired handle; must not cancel a different timeout
      timer = safeTimeout(repeat, 25);
    };
    timer = safeTimeout(repeat, 25);
    await window.nativeDelay(500); cancelTimeout(timer); cancelTimeout(timer);
    return { pendingFinished, recurring: ticks >= 5 };
  });
  assert.deepEqual(results.cancelExpired, { pendingFinished: true, recurring: true });
} finally {
  await mkdir('test-results/sdk-timers', { recursive: true });
  await writeFile('test-results/sdk-timers/results.json', JSON.stringify(results, null, 2));
  await browser.close(); await vite.close();
}
console.log(JSON.stringify(results));
