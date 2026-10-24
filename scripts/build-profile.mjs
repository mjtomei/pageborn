import { askOrigins } from '../ai/build.js';

// Only named debug/development modes may use private developer configuration.
// A release never inherits the generic origin override used by browser tests.
export function buildProfile(mode, env = {}) {
  const debug = ['debug', 'development'].includes(mode);
  const origins = askOrigins(debug
    ? env.PAGEBORNE_ASK_ORIGINS ?? env.PAGEBORNE_DEBUG_ASK_ORIGINS ?? ''
    : env.PAGEBORNE_RELEASE_ASK_ORIGINS ?? '');
  return { channel: debug ? 'debug' : 'release', diagnostics: debug, origins };
}

export function profilePaths(channel) {
  if (!['debug', 'release'].includes(channel)) throw new Error('Choose --debug or --release.');
  return channel === 'debug'
    ? { dist: 'dist', package: 'even-reader-debug.ehpk' }
    : { dist: 'dist-release', package: 'even-reader.ehpk' };
}

export function validateBuild(profile, channel, version, origins) {
  if (profile.channel !== channel || profile.diagnostics !== (channel === 'debug') || profile.version !== version
    || JSON.stringify(profile.origins) !== JSON.stringify(origins)) {
    throw new Error(`Build metadata does not match this ${channel} package. Run npm run pack:${channel} to rebuild it.`);
  }
}
