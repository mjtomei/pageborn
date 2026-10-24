export const importFinished = job => ['done', 'failed'].includes(job.phase);

// Reads run independently, with bounded memory use. The save callback commits
// each file atomically before exposing it in the library or marking it Added.
export class ImportQueue {
  constructor({ prepare, save, onChange = () => {}, concurrency = 2 }) {
    this.prepare = prepare; this.save = save; this.onChange = onChange;
    this.concurrency = concurrency; this.jobs = []; this.running = 0; this.nextId = 0; this.waiters = [];
  }
  enqueue(files) {
    const added = Array.from(files, file => ({ id: ++this.nextId, name: file.name, file, phase: 'queued', loaded: 0, total: file.size }));
    this.jobs.push(...added); this.onChange(this.jobs); this.pump();
    return added;
  }
  clearFinished() { this.jobs = this.jobs.filter(job => !importFinished(job)); this.onChange(this.jobs); }
  idle() { return this.running || this.jobs.some(job => job.phase === 'queued') ? new Promise(resolve => this.waiters.push(resolve)) : Promise.resolve(); }
  pump() {
    while (this.running < this.concurrency) {
      const job = this.jobs.find(job => job.phase === 'queued');
      if (!job) break;
      this.running++; job.phase = 'reading'; this.onChange(this.jobs);
      this.run(job);
    }
    if (!this.running) this.waiters.splice(0).forEach(resolve => resolve());
  }
  async run(job) {
    try {
      const document = await this.prepare(job.file, progress => {
        job.phase = progress.phase;
        if (progress.loaded != null) job.loaded = progress.loaded;
        if (progress.total != null) job.total = progress.total;
        this.onChange(this.jobs);
      });
      job.phase = 'saving'; job.loaded = 0; job.total = 0; this.onChange(this.jobs);
      job.document = await this.save(document, progress => { Object.assign(job, progress); this.onChange(this.jobs); });
      job.phase = 'done';
    } catch (error) {
      job.phase = 'failed'; job.error = error.name === 'QuotaExceededError' ? 'Phone storage is full. Delete some files and try again.' : error.message;
    } finally {
      job.file = null; this.running--; this.onChange(this.jobs); this.pump();
    }
  }
}
