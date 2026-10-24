import FileWorker from './file-worker.js?worker&inline';

export function readFileInBackground(file, onProgress) {
  return new Promise((resolve, reject) => {
    // Inline the worker so an already-loaded app can import while offline.
    const worker = new FileWorker();
    const finish = (error, document) => {
      worker.terminate();
      if (error) reject(error); else resolve(document);
    };
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') onProgress(data);
      if (data.type === 'done') finish(null, data.document);
      if (data.type === 'error') finish(Object.assign(new Error(data.message), { name: data.name }));
    };
    worker.onerror = event => { event.preventDefault(); finish(new Error('Could not read this file. Try adding it again.')); };
    worker.onmessageerror = () => finish(new Error('Could not read this file. Try adding it again.'));
    try { worker.postMessage(file); } catch (error) { finish(error); }
  });
}
