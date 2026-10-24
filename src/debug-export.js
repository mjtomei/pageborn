import { VERSION } from './diagnostics.js';

export function debugReport(diagnostics) {
  if (!diagnostics.enabled) throw new Error('Diagnostic logging is disabled in this build.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return { filename: `pageborne-${VERSION}-debug-${stamp}.json`,
    text: JSON.stringify({ exportedAt: new Date().toISOString(), ...diagnostics.summary(100) }, null, 2) };
}

export function installDebugExport(diagnostics) {
  const $ = id => document.getElementById(id);
  const dialog = $('debug-dialog'); let report; let file;
  const status = message => { $('debug-status').textContent = message; };
  const open = () => {
    report = debugReport(diagnostics); file = null;
    $('debug-text').value = report.text;
    // Some phone WebViews support sharing plain text files but not JSON files.
    for (const [name, type] of [[report.filename, 'application/json'], [report.filename.replace(/\.json$/, '.txt'), 'text/plain']]) {
      try {
        const candidate = new File([report.text], name, { type });
        if (navigator.share && navigator.canShare?.({ files: [candidate] })) { file = candidate; break; }
      } catch {}
    }
    $('debug-share').hidden = !file;
    status(`${diagnostics.unfinishedSetups?.length ? 'Includes saved setup attempts from earlier runs. ' : ''}Share or save this log and attach it to our conversation. If saving does nothing, use Copy log.`);
    dialog.showModal();
  };
  $('debug-export').onclick = open;
  $('error-export').onclick = open;
  if ($('speech-setup-export')) $('speech-setup-export').onclick = open;
  $('debug-close').onclick = () => dialog.close();
  $('debug-share').onclick = async () => {
    try { await navigator.share({ files: [file], title: 'Pageborne debug log' }); status('Log shared.'); }
    catch (error) { status(error?.name === 'AbortError' ? 'Sharing cancelled. Your log is still available.' : 'Sharing is unavailable here. Try Save file or Copy log.'); }
  };
  $('debug-download').onclick = () => {
    try {
      const url = URL.createObjectURL(new Blob([report.text], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = report.filename;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      status('If no file appears in Downloads or Files, use Copy log below.');
    } catch { status('Saving is unavailable here. Use Copy log below.'); }
  };
  $('debug-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(report.text); status('Log copied. Paste it into our conversation or a text file.'); }
    catch {
      $('debug-contents').open = true;
      $('debug-text').focus(); $('debug-text').select(); $('debug-text').setSelectionRange(0, report.text.length);
      status('Automatic copying is unavailable. The log is selected below; use your phone’s Copy command.');
    }
  };
}
