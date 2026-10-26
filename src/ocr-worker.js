// Small transport for the pinned Tesseract.js 7 worker protocol. Owning the
// Worker lets us cancel even during WASM/language initialization; the library's
// createWorker promise does not expose a worker until initialization finishes.
export class OcrWorker {
  constructor(url, progress, WorkerClass = Worker, timeout = 120000, lifecycle = globalThis.document) {
    this.worker = new WorkerClass(url); this.pending = new Map(); this.nextId = 0; this.timeout = timeout;
    this.lifecycle = lifecycle;
    // iOS can suspend both threads while the app is away. Give unfinished work
    // its normal watchdog interval on return, rather than expiring a healthy
    // worker because the phone spent two minutes in another app.
    this.visibility = () => { for (const job of this.pending.values()) this.watch(job); };
    lifecycle?.addEventListener('visibilitychange', this.visibility);
    this.worker.onmessage = ({ data: message }) => {
      if (message.status === 'progress') { progress(message.data); return; }
      const job = this.pending.get(message.jobId); if (!job) return;
      this.pending.delete(message.jobId); clearTimeout(job.timer);
      if (message.status === 'resolve') job.resolve(message.data);
      else job.reject(new Error(String(message.data)));
    };
    this.worker.onerror = event => { event.preventDefault?.(); this.close(new Error(event.message || 'OCR worker failed.')); };
  }
  watch(job) {
    clearTimeout(job.timer);
    if (!this.lifecycle?.hidden) job.timer = setTimeout(() => this.close(new Error('OCR timed out; showing the scan.')), this.timeout);
  }
  call(action, payload) {
    if (this.closed) return Promise.reject(new Error('OCR worker closed.'));
    return new Promise((resolve, reject) => {
      const jobId = String(++this.nextId);
      const job = { resolve, reject };
      this.pending.set(jobId, job); this.watch(job);
      this.worker.postMessage({ workerId: 'reader-ocr', jobId, action, payload });
    });
  }
  close(error = new Error('PDF closed.')) {
    this.lifecycle?.removeEventListener('visibilitychange', this.visibility);
    this.closed = true; this.worker.terminate();
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(error); }
    this.pending.clear();
  }
}
