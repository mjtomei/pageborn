import { readLocalFile } from './library.js';

// One worker per active file keeps decoding and metadata work off the UI thread.
self.onmessage = async ({ data: file }) => {
  try {
    const document = await readLocalFile(file, progress => self.postMessage({ type: 'progress', ...progress }));
    self.postMessage({ type: 'done', document });
  } catch (error) {
    self.postMessage({ type: 'error', name: error.name, message: error.message });
  }
};
