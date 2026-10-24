import { sha256 } from '@noble/hashes/sha2.js';

self.onmessage = async () => {
  const files = []; let total = 0;
  try {
    const response = await fetch('./ensemble-models.json');
    if (!response.ok) throw Error(`Manifest: HTTP ${response.status}`);
    const manifest = await response.json();
    for (const model of manifest.models) {
      for (const file of model.files) {
        const hash = sha256.create(); let bytes = 0, last = 0;
        for (const part of file.parts || [file]) {
          const response = await fetch(new URL(part.file, self.location.href), { cache: 'no-store' });
          if (!response.ok || !response.body) throw Error(`${model.name}: HTTP ${response.status}`);
          const reader = response.body.getReader(), partHash = sha256.create(); let partBytes = 0;
          try {
            while (true) {
              const next = await reader.read(); if (next.done) break;
              bytes += next.value.length; partBytes += next.value.length; total += next.value.length;
              if (bytes > file.bytes || partBytes > part.bytes) throw Error(`${model.name}: unexpected file size`);
              hash.update(next.value); partHash.update(next.value);
              if (performance.now() - last > 200) { last = performance.now(); self.postMessage({ progress: `${model.name} · ${(total / 1e6).toFixed(1)} / ${(manifest.totalBytes / 1e6).toFixed(1)} MB` }); }
            }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          const partDigest = Array.from(partHash.digest(), n => n.toString(16).padStart(2, '0')).join('');
          if (partBytes !== part.bytes || partDigest !== part.sha256) throw Error(`${model.name}: part integrity check failed`);
        }
        const digest = Array.from(hash.digest(), n => n.toString(16).padStart(2, '0')).join('');
        if (bytes !== file.bytes || digest !== file.sha256) throw Error(`${model.name}: file integrity check failed`);
        files.push({ ...file, verified: true });
      }
      self.postMessage({ progress: `${model.name} verified` });
    }
    self.postMessage({ result: { version: manifest.version, files, bytes: total, models: manifest.models.map(m => m.name), verified: true, inferenceTested: false } });
  } catch (error) { self.postMessage({ error: error.message, filesVerified: files.length, bytes: total }); }
};
