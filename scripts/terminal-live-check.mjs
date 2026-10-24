// Read-only check of the configured private Terminal through real browser CORS.
// Never print credentials, document names, session IDs or conversation content.
import { chromium, webkit } from '@playwright/test';
import { createServer, loadEnv } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { buildProfile } from './build-profile.mjs';
import { debugTerminalConnection } from './debug-terminal.mjs';

const env = { ...loadEnv('debug', process.cwd(), 'PAGEBORNE_'), ...process.env };
const profile = buildProfile('debug', env);
const config = debugTerminalConnection(profile, env);
assert(config, 'Configure a private debug Terminal connection first.');
const out = 'test-results/terminal-live'; await mkdir(out, { recursive: true });
const server = await createServer({ cacheDir: '.state/vite-terminal-live', server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/dist/**', '**/dist-release/**'] } }, clearScreen: false });
server.middlewares.use('/terminal-check.html', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Terminal connection check</title>'); });
await server.listen();
const results = [];
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch(engine === chromium ? { executablePath: '/usr/bin/google-chrome', headless: true }
      : { headless: true, ...(process.env.WEBKIT_PATH ? { executablePath: process.env.WEBKIT_PATH } : {}) });
    try {
      const page = await browser.newPage();
      await page.exposeFunction('__checkStage', stage => console.log(`${engine.name()}: ${stage}`));
      await page.goto(new URL('terminal-check.html', server.resolvedUrls.local[0]).href);
      const report = await page.evaluate(async ({ config, origins }) => {
        const { EvenTerminal } = await import('/src/ask-terminal.js');
        window.__liveStream = { status: null, controller: new AbortController() };
        const client = new EvenTerminal(config, { evenHost: true, origins, fetcher: async (url, options) => {
          const response = await fetch(url, options);
          if (new URL(url).pathname === '/api/events') { window.__liveStream.status = response.status; await window.__checkStage(`event stream HTTP ${response.status}`); }
          return response;
        } });
        const info = await client.serverInfo(); await window.__checkStage('authenticated info');
        const library = await client.api('pageborne/library'); await window.__checkStage('library read');
        const sessions = await client.sessions(); await window.__checkStage('sessions read');
        let conversation;
        if (sessions.length && info.pageborne?.conversationSync === 1) {
          const binding = { sessionId: (sessions.find(s => s.status === 'idle') || sessions[0]).id };
          const started = performance.now(), first = await client.conversation(binding), second = await client.conversation(binding);
          conversation = { version: second.version, turns: second.turns.length, questions: second.turns.filter(t => t.question).length,
            uniqueIds: new Set(second.turns.map(t => t.id)).size === second.turns.length,
            retainedIds: first.turns.every(t => second.turns.some(s => s.id === t.id || s.aliases?.includes(t.id))),
            twoReadMs: Math.round(performance.now() - started) };
          await window.__checkStage('shared conversation read twice');
        }
        if (sessions.length) {
          window.__liveStream.job = client.watch((sessions.find(s => s.status === 'idle') || sessions[0]).id, window.__liveStream.controller.signal)
            .catch(() => { if (!window.__liveStream.controller.signal.aborted) window.__liveStream.failed = true; });
        }
        return { provider: info.provider, capabilities: info.pageborne,
          libraryVersion: library.version, sessionCount: sessions.length, conversation };
      }, { config, origins: profile.origins });
      assert.equal(report.provider, config.agent);
      assert.equal(report.capabilities?.librarySync, 1);
      assert.equal(report.libraryVersion, 1);
      assert(report.sessionCount > 0, 'A pre-existing session is needed for the read-only SSE check.');
      if (report.conversation) {
        assert.equal(report.conversation.version, 1); assert(report.conversation.uniqueIds); assert(report.conversation.retainedIds);
      }
      // This is a long-lived stream. Verify its headers without waiting for
      // it to finish, then close the browser context to release the subscriber.
      await page.waitForFunction(() => window.__liveStream.status !== null || window.__liveStream.failed, null, { timeout: 20000 });
      report.eventStreamStatus = await page.evaluate(() => { window.__liveStream.controller.abort(); return window.__liveStream.status; });
      assert.equal(report.eventStreamStatus, 200);
      results.push({ browser: engine.name(), passed: true, ...report });
    } finally { await browser.close(); }
  }
} finally {
  await server.close();
  await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2));
}
console.log(JSON.stringify(results));
