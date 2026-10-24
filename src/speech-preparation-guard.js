// A WebView memory termination cannot be caught in JavaScript. Commit a small
// marker before starting optional GPU preparation, through durable phone prefs.
// A subsequent launch keeps CPU voice available until the user explicitly retries.
export function speechPreparationGuard({ read = () => null, save = async () => {}, version } = {}) {
  return async (entry, options) => {
    if (entry.model !== 'refine') return entry.local.prepare(entry.backend, options);
    if (read()?.pending && !options.retry) throw new Error('GPU corrections paused after an interrupted preparation. CPU voice still works. Use Prepare / retry voice in Settings.');
    const generation = entry.generation, id = crypto.randomUUID();
    try {
      await save({ pending: true, id, version, startedAt: new Date().toISOString() });
      if (entry.generation !== generation) throw new DOMException('Cancelled', 'AbortError');
      return await entry.local.prepare(entry.backend, options);
    } finally {
      // A cancelled older attempt cannot clear the marker for a new retry.
      if (read()?.id === id) await save({ pending: false });
    }
  };
}
