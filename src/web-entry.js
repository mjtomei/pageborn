document.documentElement.dataset.platform = 'web';
// An async function avoids holding the entry module's evaluation open while it
// dynamically imports its graph, a fragile path in older Safari module loaders.
async function startReader() {
  const response = await fetch('/web/config', { credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
  if (!response.ok) throw new Error('Connect this device to your Tailscale account, then reload.');
  window.pageborneConnection = await response.json();
  await import('./main.js');
}
startReader().catch(error => {
  const interrupted = /(?:importing a module|failed to fetch dynamically imported|load failed|loading chunk)/i.test(error.message);
  const retryKey = `pageborne:startup-retry:${import.meta.url}`;
  let retry = false;
  try {
    const last = Number(sessionStorage.getItem(retryKey) || 0);
    retry = interrupted && Date.now() - last > 60000;
    if (retry) sessionStorage.setItem(retryKey, String(Date.now()));
  } catch { /* Manual retry still works when session storage is unavailable. */ }
  document.body.replaceChildren();
  const main = document.createElement('main'); main.style.cssText = 'max-width:520px;margin:15vh auto;padding:24px;font:18px/1.6 system-ui';
  const title = document.createElement('h1'); title.textContent = 'Pageborne';
  const message = document.createElement('p');
  message.textContent = retry ? 'The reader download was interrupted. Reconnecting…'
    : interrupted ? 'The reader could not finish downloading. Check your connection and try again.' : error.message;
  const button = document.createElement('button'); button.textContent = 'Try again'; button.onclick = () => location.reload();
  main.append(title, message, button); document.body.append(main);
  if (!retry) {
    const details = document.createElement('details'), summary = document.createElement('summary'), text = document.createElement('p');
    summary.textContent = 'Technical details';
    text.textContent = `${error.message} (${new URL(import.meta.url).pathname.split('/').pop()})`;
    details.append(summary, text); main.append(details);
  }
  if (retry) setTimeout(() => location.reload(), 1000);
});
