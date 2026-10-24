import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { createProvider } from './providers.js';

export function createAiBridge(config, dependencies = {}) {
  if (typeof config.token !== 'string' || config.token.length < 24) throw new Error('The bridge needs a random access token of at least 24 characters.');
  const app = express(); app.disable('x-powered-by'); const provider = createProvider(config, dependencies);
  let active = 0; let requests = []; const expected = Buffer.from(`Bearer ${config.token}`);
  app.use((req, res, next) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '600',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    const auth = Buffer.from(req.get('authorization') || '');
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  });
  app.get('/status', async (_req, res) => res.json({ provider: config.provider || '', model: config.model || '',
    ready: !!config.model && (config.provider !== 'chatgpt' || await dependencies.chatgpt?.isSignedIn()), voice: !!config.transcription?.model }));
  app.use((req, res, next) => {
    if (!['/ask', '/transcribe'].includes(req.path) || req.method !== 'POST') return res.sendStatus(404);
    const now = Date.now(); requests = requests.filter(t => now - t < 60000);
    if (active >= 2 || requests.length >= 30) return res.sendStatus(429);
    active++; requests.push(now); const abort = new AbortController(); req.aiSignal = abort.signal;
    const timer = setTimeout(() => abort.abort(), 115000);
    res.once('close', () => { clearTimeout(timer); active--; abort.abort(); }); next();
  });
  app.post('/ask', express.json({ limit: '8mb' }), async (req, res) => {
    const answer = await provider.answer(req.body, req.aiSignal); if (!res.destroyed) res.json({ answer });
  });
  app.post('/transcribe', express.raw({ type: 'audio/wav', limit: 60 * 32000 + 44 }), async (req, res) => {
    const b = req.body;
    if (!Buffer.isBuffer(b) || b.length < 3244 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE'
      || b.readUInt16LE(20) !== 1 || b.readUInt16LE(22) !== 1 || b.readUInt32LE(24) !== 16000 || b.readUInt16LE(34) !== 16
      || b.readUInt32LE(40) !== b.length - 44) return res.status(400).json({ error: 'Invalid recording' });
    const text = await provider.transcribe(b, req.aiSignal); if (!res.destroyed) res.json({ text });
  });
  app.use((error, _req, res, _next) => { if (!res.destroyed) res.status([400, 401, 403, 413, 429, 503].includes(error.status) ? error.status : 502).json({ error: 'Could not complete request' }); });
  return app;
}
