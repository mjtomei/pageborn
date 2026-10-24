import test from 'node:test';
import assert from 'node:assert/strict';
import { OcrWorker } from '../src/ocr-worker.js';

class FakeWorker {
  postMessage(message) { this.sent = message; }
  terminate() { this.terminated = true; }
  reply(status, data) { this.onmessage({ data: { jobId: this.sent.jobId, status, data } }); }
}
test('OCR initialization errors reject promptly and closing cancels outstanding recognition', async () => {
  const client = new OcrWorker('local', () => {}, FakeWorker);
  const loading = client.call('initialize', {});
  client.worker.reply('reject', 'Invalid language'); await assert.rejects(loading, /Invalid language/);
  const recognizing = client.call('recognize', {}); client.close();
  await assert.rejects(recognizing, /PDF closed/); assert.equal(client.worker.terminated, true);
  await assert.rejects(client.call('recognize', {}), /closed/);
});
test('OCR worker crashes and timeouts terminate the worker without leaving a pending job', async () => {
  const crashed = new OcrWorker('local', () => {}, FakeWorker);
  const job = crashed.call('load', {}); crashed.worker.onerror({ message: 'WASM failed' });
  await assert.rejects(job, /WASM failed/); assert.equal(crashed.pending.size, 0);
  const timeout = new OcrWorker('local', () => {}, FakeWorker, 5);
  await assert.rejects(timeout.call('recognize', {}), /timed out/);
  assert.equal(timeout.worker.terminated, true);
});
