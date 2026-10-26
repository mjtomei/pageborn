// PDF.js shares decoded images and page resources across render tasks. Keep
// preparation, OCR, display tiles and cleanup on one lane per document.
export class PdfWork {
  constructor() { this.jobs = []; this.running = false; this.closed = false; }
  run(work, signal) {
    if (this.closed) return Promise.reject(new Error('PDF closed.'));
    if (signal?.aborted) return Promise.reject(new Error('PDF preview closed.'));
    return new Promise((resolve, reject) => {
      const job = { work, resolve, reject, signal, started: false };
      job.abort = () => {
        if (job.started) return;
        this.jobs = this.jobs.filter(item => item !== job);
        signal?.removeEventListener('abort', job.abort);
        reject(new Error('PDF preview closed.'));
      };
      signal?.addEventListener('abort', job.abort, { once: true });
      this.jobs.push(job); this.pump();
    });
  }
  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length) {
        const job = this.jobs.shift(); job.started = true;
        try { job.resolve(await job.work()); }
        catch (error) { job.reject(error); }
        finally { job.signal?.removeEventListener('abort', job.abort); }
      }
    } finally { this.running = false; }
  }
  close() {
    this.closed = true;
    for (const job of this.jobs.splice(0)) {
      job.signal?.removeEventListener('abort', job.abort);
      job.reject(new Error('PDF closed.'));
    }
  }
}
