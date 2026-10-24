// Keep setup evidence separate from previousRun: an uneventful reopen must not
// replace the last useful checkpoint from a frozen WebView. No audio/text is
// included, and repeated reopens do not grow a recursive run history.
const MAX_ATTEMPTS = 4, MAX_EVENTS = 16;
const text = (value, size = 200) => typeof value === 'string' ? value.slice(0, size) : '';
function setupFields(setup = {}) {
  const out = {};
  for (const key of ['stage', 'file', 'component']) if (typeof setup[key] === 'string') out[key] = text(setup[key]);
  for (const key of ['loadedBytes', 'totalBytes', 'fileLoadedBytes', 'fileBytes', 'startedAt', 'stageStartedAt', 'lastProgressAt']) {
    if (Number.isFinite(setup[key])) out[key] = setup[key];
  }
  return out;
}
function eventFields(event) { return { at: text(event.at, 40), state: text(event.state, 30), ...setupFields(event) }; }
function savedAttempt(entry) {
  if (!entry?.runStartedAt || !entry.model || !['loading', 'downloading'].includes(entry.state)) return null;
  return { version: text(entry.version, 30), runStartedAt: text(entry.runStartedAt, 40), model: text(entry.model, 50),
    state: entry.state, progress: text(entry.progress), setup: setupFields(entry.setup),
    ...(entry.active ? { active: { name: text(entry.active.name, 50), at: text(entry.active.at, 40) } } : {}),
    events: (Array.isArray(entry.events) ? entry.events : []).slice(-MAX_EVENTS).map(eventFields),
    ...(entry.resolvedAt ? { resolvedAt: text(entry.resolvedAt, 40) } : {}) };
}
const identity = entry => `${entry.runStartedAt}:${entry.model}:${entry.setup.startedAt || 'download'}`;

export function resolveSetupHistory(history, speech, at) {
  return history.map(entry => !entry.resolvedAt && speech?.models?.[entry.model]?.state === 'ready'
    && at >= entry.runStartedAt ? { ...entry, resolvedAt: at } : entry);
}

export function restoreSetupHistory(previous, history = []) {
  const entries = new Map();
  const add = value => {
    const entry = savedAttempt(value); if (!entry) return;
    const key = identity(entry), old = entries.get(key);
    if (!old || (entry.setup.lastProgressAt || 0) >= (old.setup.lastProgressAt || 0)) {
      if (old?.resolvedAt && !entry.resolvedAt) entry.resolvedAt = old.resolvedAt;
      entries.set(key, entry);
    } else if (entry.resolvedAt) old.resolvedAt = entry.resolvedAt;
  };
  for (const entry of history) add(entry);
  // previousRun permits migration of the useful checkpoint from 0.8.69 too.
  const runs = [previous?.previousRun, previous].filter(run => typeof run?.startedAt === 'string')
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const run of runs) {
    for (const entry of Array.isArray(run.unfinishedSetups) ? run.unfinishedSetups : []) add(entry);
    for (const [model, state] of Object.entries(run.speech?.models || {})) {
      if (!['loading', 'downloading'].includes(state?.state)) continue;
      const events = (Array.isArray(run.events) ? run.events : []).filter(event => event.type === 'speech-model-state'
        && event.models?.[model]?.setup?.startedAt === state.setup?.startedAt)
        .map(event => ({ at: event.at, state: event.models[model].state, ...setupFields(event.models[model].setup) }));
      add({ version: run.version, runStartedAt: run.startedAt, model, state: state.state,
        progress: state.progress, setup: state.setup, active: run.active, events });
    }
    for (const entry of resolveSetupHistory([...entries.values()], run.speech, run.startedAt)) entries.set(identity(entry), entry);
  }
  return [...entries.values()].sort((a, b) => a.runStartedAt.localeCompare(b.runStartedAt)
    || (a.setup.startedAt || 0) - (b.setup.startedAt || 0)).slice(-MAX_ATTEMPTS);
}
