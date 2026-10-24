// Small transport for the pinned Tesseract.js 7 worker protocol. Owning the
// Worker lets us cancel even during WASM/language initialization; the library's
// createWorker promise does not expose a worker until initialization finishes.
export class OcrWorker {
  constructor(url, progress, WorkerClass = Worker, timeout = 120000) {
    this.worker = new WorkerClass(url); this.pending = new Map(); this.nextId = 0; this.timeout = timeout;
    this.worker.onmessage = ({ data: message }) => {
      if (message.status === 'progress') { progress(message.data); return; }
      const job = this.pending.get(message.jobId); if (!job) return;
      this.pending.delete(message.jobId); clearTimeout(job.timer);
      if (message.status === 'resolve') job.resolve(message.data);
      else job.reject(new Error(String(message.data)));
    };
    this.worker.onerror = event => { event.preventDefault?.(); this.close(new Error(event.message || 'OCR worker failed.')); };
  }
  call(action, payload) {
    if (this.closed) return Promise.reject(new Error('OCR worker closed.'));
    return new Promise((resolve, reject) => {
      const jobId = String(++this.nextId);
      const timer = setTimeout(() => this.close(new Error('OCR timed out; showing the scan.')), this.timeout);
      this.pending.set(jobId, { resolve, reject, timer });
      this.worker.postMessage({ workerId: 'reader-ocr', jobId, action, payload });
    });
  }
  close(error = new Error('PDF closed.')) {
    this.closed = true; this.worker.terminate();
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(error); }
    this.pending.clear();
  }
}
