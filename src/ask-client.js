export function endpointUrl(value) {
  let url; try { url = new URL(String(value || '').trim()); } catch { throw new Error('Enter the full endpoint URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP(S) URL without a password, query or fragment.');
  return url.href.replace(/\/$/, '');
}
export function checkAskConnection(config, { evenHost = false, origins = [] } = {}) {
  const endpoint = endpointUrl(config.endpoint);
  if (evenHost && !origins.includes(new URL(endpoint).origin)) throw new Error('This endpoint is not enabled in this app build. Add its origin when packaging Pageborne.');
  if (!String(config.token || '').trim()) throw new Error('Enter the bridge access token in Settings → Ask about this.');
  return { endpoint, token: String(config.token).trim() };
}
export async function askFetch(config, route, { body, signal, evenHost = false, origins = [] } = {}) {
  const { endpoint, token } = checkAskConnection(config, { evenHost, origins });
  const timeout = new AbortController(); const timer = setTimeout(() => timeout.abort(), 120000);
  const cancel = () => timeout.abort(); signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) timeout.abort();
  try {
    const response = await fetch(`${endpoint}/${route}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': body instanceof Blob ? 'audio/wav' : 'application/json' }) },
      body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body), signal: timeout.signal,
      credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    if (!response.ok) {
      // Do not include arbitrary server errors: they may contain credentials,
      // the prompt, or HTML. Known status codes give useful bounded guidance.
      const messages = { 401: 'Bridge access token rejected. Check Settings.', 403: 'This request is not allowed by the bridge.',
        413: 'The question or recording is too large.', 429: 'The provider is busy or your usage limit was reached. Try again later.',
        503: route === 'transcribe' ? 'Voice transcription is not configured. Type your question on the phone, or configure a transcription endpoint on the bridge.' : 'The AI provider is not configured or signed in. Check the bridge.' };
      throw new Error(messages[response.status] || `The bridge could not complete the request (HTTP ${response.status}).`);
    }
    const value = await response.json();
    return value;
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error(signal?.aborted ? 'Question cancelled.' : 'The request timed out. Try again.'), { connectionFailure: signal?.aborted ? 'cancelled' : 'timeout' });
    if (error instanceof TypeError) throw new Error('Could not reach the bridge. Check its address, HTTPS, and CORS configuration.');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
