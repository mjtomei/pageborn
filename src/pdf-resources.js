import resources, { decoderFallbacks } from 'virtual:pdf-resources';
import { base64ToBytes } from './binary.js';

export class LocalPdfResources {
  async fetch({ kind, filename }) {
    const encoded = resources[`${kind}/${filename}`];
    if (!encoded) throw new Error(`This PDF needs an unavailable font or decoder (${filename}).`);
    return base64ToBytes(encoded);
  }
}

// PDF.js's OpenJPEG WASM requires relaxed SIMD, which older WebKit lacks.
// Keep its JS decoders local too: a scan must render even without a network.
// The pinned PDF.js appends a filename to wasmUrl. A fragment preserves the
// dispatcher Blob URL while selecting the decoder to import inside its worker.
// Binary WASM still goes through LocalPdfResources (useWorkerFetch: false).
export class PdfDecoderFallbacks {
  constructor() {
    const moduleUrl = source => URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const modules = Object.fromEntries(Object.entries(decoderFallbacks).map(([name, source]) => [name, moduleUrl(source)]));
    const dispatcher = moduleUrl(`
      const modules = ${JSON.stringify(modules)};
      const name = new URL(import.meta.url).hash.slice(2);
      if (!Object.hasOwn(modules, name)) throw new Error('Unknown PDF decoder: ' + name);
      export default (await import(modules[name])).default;
    `);
    this.urls = [...Object.values(modules), dispatcher];
    this.wasmUrl = `${dispatcher}#/`;
  }
  destroy() {
    for (const url of this.urls.splice(0)) URL.revokeObjectURL(url);
  }
}
