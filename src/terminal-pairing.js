import { endpointUrl } from './ask-client.js';

export function automaticTerminalConfig(connection, { evenHost, hostname }) {
  if (!connection) return null;
  const localPreview = !evenHost && ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  return { ...connection, endpoint: localPreview && connection.previewEndpoint ? connection.previewEndpoint : connection.endpoint };
}

export function migrateTerminalPreferences(preferences, connection) {
  if (!connection?.endpoint || !connection.previousEndpoints?.length) return false;
  let changed = false;
  for (const previous of connection.previousEndpoints) {
    if (previous === connection.endpoint) continue;
    const migration = JSON.stringify([previous, connection.endpoint]);
    if (preferences.terminalMigrations?.[migration]) continue;
    for (const field of ['askSessions', 'askChats']) {
      const entries = preferences[field];
      for (const [key, value] of Object.entries(entries || {})) {
        let parts; try { parts = JSON.parse(key); } catch { continue; }
        if (!Array.isArray(parts) || parts.length !== 5 || parts[1] !== 'terminal' || parts[2] !== previous) continue;
        parts[2] = connection.endpoint;
        const target = JSON.stringify(parts);
        if (!Object.hasOwn(entries, target)) entries[target] = structuredClone(value);
      }
    }
    const sync = preferences.librarySync;
    if (sync?.[previous] && !Object.hasOwn(sync, connection.endpoint)) sync[connection.endpoint] = structuredClone(sync[previous]);
    // Keep old records for rollback, but never resurrect them after the user
    // clears or replaces a new session. New-address records always win.
    (preferences.terminalMigrations ||= {})[migration] = true;
    changed = true;
  }
  return changed;
}

// Stock Even Terminal 0.10.5 and the local shared-session server use the same
// HTTP(S) URL: ?token=...&defaultProvider=claude|codex&name=... . Never navigate
// to it: strip credentials from the address and keep them in the token field.
export function terminalPairing(value) {
  const raw = String(value || '').trim(); let url;
  if (!raw || raw.length > 8192 || /[\x00-\x20\x7f]/.test(raw)) throw new Error('Paste the complete Even Terminal pairing URL.');
  try { url = new URL(raw); } catch { throw new Error('Paste a full HTTP or HTTPS Even Terminal URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Use an HTTP or HTTPS pairing URL without a password or fragment.');
  for (const key of ['token', 'defaultProvider']) if (url.searchParams.getAll(key).length > 1) throw new Error('The pairing URL contains duplicate connection details. Copy it again from Even Terminal.');
  const token = url.searchParams.get('token') || '';
  if (token.length > 4096 || /[\x00-\x20\x7f]/.test(token)) throw new Error('The pairing token is invalid. Copy the URL again from Even Terminal.');
  const provider = url.searchParams.get('defaultProvider');
  url.search = '';
  return { endpoint: endpointUrl(url.href).replace(/\/api$/, ''), token,
    agent: ['claude', 'codex'].includes(provider) ? provider : undefined };
}
