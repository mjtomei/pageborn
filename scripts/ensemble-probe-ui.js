const settings = document.getElementById('shared-settings');
const section = document.createElement('section'); section.id = 'ensemble-package-probe';
section.innerHTML = '<h4 class="section-label">Bundled model test</h4><p class="muted">Conformer, Zipformer and Moonshine Base are included for this installation test. Dictation still uses Tiny.</p><button type="button" class="secondary" id="ensemble-verify">Verify bundled speech models</button><p id="ensemble-verification-status" class="muted" role="status">Checks local files without loading the models.</p>';
settings?.append(section);
const button = section.querySelector('button'), status = section.querySelector('[role=status]');
let worker;
button.onclick = () => {
  if (worker) { worker.terminate(); worker = null; button.textContent = 'Verify bundled speech models'; status.textContent = 'Verification cancelled.'; return; }
  status.textContent = 'Checking local model files…'; button.textContent = 'Cancel verification';
  const current = worker = new Worker(new URL('./ensemble-probe-worker.js', import.meta.url), { type: 'module' });
  const finish = text => { if (worker !== current) return; status.textContent = text; current.terminate(); worker = null; button.textContent = 'Verify bundled speech models'; };
  current.onmessage = ({ data }) => {
    if (worker !== current) return;
    if (data.progress) status.textContent = data.progress;
    if (data.error) finish(`Verification failed: ${data.error}`);
    if (data.result) { window.__ensemblePackageVerification = data.result; finish(`All three models verified · ${(data.result.bytes / 1e6).toFixed(1)} MB. Ready for the next streaming test.`); }
  };
  current.onerror = event => { event.preventDefault(); finish('Verification could not run. Try again.'); };
  current.postMessage({ verify: true });
};
