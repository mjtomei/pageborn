import { askChatKey, retainAskModels } from './ask-models.js';

export const readerScope = remote => `pageborne:${remote.instanceId}:${remote.libraryId}`;
export function scopedReaderConfig(config, prefs) {
  const scope = prefs.readerScopes?.[config?.endpoint];
  return scope ? { ...config, chatScope: scope } : config;
}
export class SharedReaderState {
  constructor({ client, documents, read, save, changed = () => {} }) {
    Object.assign(this, { client, documents, read, save, changed });
    this.published = new Map(); this.remote = null;
    this.unsupported = new Set();
  }
  async sync() {
    if (this.busy) return this.busy;
    this.busy = this.run().finally(() => { this.busy = null; });
    return this.busy;
  }
  async run() {
    let endpoint;
    try {
      const client = this.client(); if (!client) return;
      endpoint = client.config.endpoint;
      if (this.unsupported.has(endpoint)) return;
      const remote = await client.api('pageborne/reader-state', { timeoutMs: 10000 });
      if (remote.version !== 1 || !Array.isArray(remote.records) || !remote.instanceId || !remote.libraryId) return;
      this.remote = remote;
      const prefs = this.read(), scope = readerScope(remote);
      const previousScope = prefs.readerScopes?.[endpoint];
      const config = { ...client.config, chatScope: scope }, docs = this.documents();
      const bindings = { ...prefs.askSessions }, chats = structuredClone(prefs.askChats || {});
      let modified = previousScope !== scope;
      // One-time migration of old device-local links. Subsequent instance or
      // library changes use a fresh namespace; old histories remain intact.
      if (!previousScope) for (const key of new Set([...Object.keys(bindings), ...Object.keys(chats)])) {
        let parts; try { parts = JSON.parse(key); } catch { continue; }
        if (parts[1] !== 'terminal' || parts[2] !== endpoint) continue;
        parts[2] = scope; const target = JSON.stringify(parts);
        if (bindings[key] && !bindings[target]) bindings[target] = structuredClone(bindings[key]);
        if (chats[key] && !chats[target]) chats[target] = structuredClone(chats[key]);
      }
      for (const record of remote.records) {
        const doc = record.document === null ? null : docs.find(d => d.id === record.document);
        if (record.document !== null && !doc) continue;
        const key = askChatKey({ ...config, agent: record.agent }, doc?.positionKey ?? null);
        if (!bindings[key]?.sessionId) {
          const session = record.sessions.find(s => s.id === record.primary);
          if (session) { bindings[key] = { ...bindings[key], sessionId: session.id, cwd: session.cwd, ...(record.document === null ? { libraryId: remote.libraryId } : {}) }; modified = true; }
        }
        const session = record.sessions.find(s => s.id === bindings[key]?.sessionId);
        if (!session) continue;
        for (const turn of chats[key] || []) {
          if (turn.position != null) continue;
          const ids = new Set([turn.id, turn.remoteId, turn.marker, ...(turn.remoteAliases || [])].filter(Boolean));
          const anchor = session.anchors.find(a => [a.id, ...a.aliases].some(id => ids.has(id)));
          if (anchor) { turn.position = anchor.position; if (anchor.page) turn.page = anchor.page; modified = true; }
        }
      }
      const choices = prefs.readerModels?.[scope] || (!previousScope ? prefs.askModels : {}) || {};
      const models = retainAskModels(config, choices, bindings, chats);
      if (models !== choices) modified = true;
      if (modified) {
        this.save({ askSessions: bindings, askChats: chats,
          readerScopes: { ...prefs.readerScopes, [endpoint]: scope }, readerModels: { ...prefs.readerModels, [scope]: models } });
        this.changed({ scopeChanged: previousScope !== scope, chats });
      }
      for (const doc of [...docs, null]) for (const agent of ['claude', 'codex']) {
        const key = askChatKey({ ...config, agent }, doc?.positionKey ?? null), binding = bindings[key];
        if (!binding?.sessionId) continue;
        const anchors = (chats[key] || []).filter(t => t.position != null && Number.isFinite(Number(t.position))).slice(-40).map(t => ({
          id: t.remoteId || t.marker || t.id, aliases: [...new Set([t.id, t.marker, ...(t.remoteAliases || [])].filter(Boolean))].slice(-20),
          position: Number(t.position), ...(t.page ? { page: Number(t.page) } : {}),
        }));
        const input = { document: doc?.id ?? null, agent, sessionId: binding.sessionId, ...(binding.cwd ? { cwd: binding.cwd } : {}), anchors };
        const signature = JSON.stringify(input), publicationKey = JSON.stringify([scope, input.document, agent, input.sessionId]);
        if (this.published.get(publicationKey) === signature) continue;
        await client.api('pageborne/reader-state', { body: input, timeoutMs: 10000 });
        this.published.set(publicationKey, signature);
      }
    } catch (error) {
      // Retry transient failures; an older server needs an upgrade and reload.
      if (error.status === 404) this.unsupported.add(endpoint);
    }
  }
}
