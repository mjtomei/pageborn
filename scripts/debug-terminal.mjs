import { readFileSync } from 'node:fs';
import { checkConnection } from '../src/ask-connections.js';
import { endpointUrl } from '../src/ask-client.js';

// Private, opt-in build input. Keep credentials separate from public build
// metadata; release must not even read the pairing file. An explicit origin
// override also disables this shortcut so connection tests stay isolated.
export function debugTerminalConnection(profile, env = {}, read = readFileSync) {
  if (profile.channel !== 'debug' || Object.hasOwn(env, 'PAGEBORNE_ASK_ORIGINS') || !env.PAGEBORNE_DEBUG_TERMINAL_STATE) return null;
  try {
    const state = JSON.parse(read(env.PAGEBORNE_DEBUG_TERMINAL_STATE, 'utf8'));
    const endpoint = env.PAGEBORNE_DEBUG_TERMINAL_URL || (profile.origins.length === 1 ? profile.origins[0] : '');
    if (typeof state.token !== 'string' || !state.token.trim() || state.token.length > 4096 || /[\x00-\x20\x7f]/.test(state.token)) throw new Error();
    const config = checkConnection({ mode: 'terminal', endpoint, token: state.token,
      agent: env.PAGEBORNE_DEBUG_TERMINAL_AGENT || state.defaultProvider || 'codex', cwd: '', paperDirectories: false,
    }, { evenHost: true, origins: profile.origins });
    // Only the desktop's loopback preview uses this. The Even phone WebView
    // also has a loopback URL, so runtime selection must explicitly exclude it.
    if (['', 'localhost', '127.0.0.1', '0.0.0.0', '::', '::1'].includes(state.host || '') && Number.isInteger(state.port) && state.port > 0 && state.port <= 65535) config.previewEndpoint = `http://127.0.0.1:${state.port}`;
    // Explicit aliases identify the SAME desktop after an address change.
    // They migrate local history only, never enable network access or fallback.
    if (env.PAGEBORNE_DEBUG_TERMINAL_PREVIOUS_URLS) config.previousEndpoints = [...new Set(env.PAGEBORNE_DEBUG_TERMINAL_PREVIOUS_URLS.split(',').filter(s => s.trim()).map(value => endpointUrl(value).replace(/\/api$/, '')))];
    return config;
  } catch {
    // Do not echo JSON parse errors or file contents: they can contain the key.
    throw new Error('Could not configure automatic debug pairing. Check PAGEBORNE_DEBUG_TERMINAL_STATE, the allowed server origin and agent.');
  }
}
