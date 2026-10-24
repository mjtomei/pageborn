// Decode photos locally. Native capture/album images arrive as SDK base64;
// browsers supply a file. A bounded canvas avoids processing full camera pixels.
const MAX_BYTES = 20 * 1024 * 1024;
export class QrImageError extends Error {}
export async function readQrImage(source, signal) {
  let url; let revoke = false;
  if (source instanceof Blob) {
    if (!source.size || source.size > MAX_BYTES || source.type === 'image/svg+xml') throw new QrImageError('Choose a photo or screenshot under 20 MB.');
    url = URL.createObjectURL(source); revoke = true;
  } else {
    const base64 = source?.base64;
    if (typeof base64 !== 'string' || !base64 || base64.length > MAX_BYTES * 4 / 3 + 200) throw new QrImageError('No usable camera image was returned. Choose a QR image or paste the pairing URL.');
    if (base64.startsWith('data:')) {
      if (!/^data:image\/(?:png|jpeg|webp|gif|bmp|avif|heic|heif);base64,/i.test(base64)) throw new QrImageError('Choose a photo or screenshot of the QR code.');
      url = base64;
    } else {
      const mime = source.mimeType || 'image/jpeg';
      if (!/^image\/(?:png|jpeg|webp|gif|bmp|avif|heic|heif)$/i.test(mime)) throw new QrImageError('Choose a photo or screenshot of the QR code.');
      url = `data:${mime};base64,${base64}`;
    }
  }
  const image = new Image(); const canvas = document.createElement('canvas');
  const checkpoint = () => { if (signal?.aborted) throw new QrImageError('QR import cancelled.'); };
  try {
    checkpoint();
    await new Promise((resolve, reject) => {
      const done = error => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); error ? reject(error) : resolve(); };
      const cancel = () => done(new QrImageError('QR import cancelled.'));
      const timer = setTimeout(() => done(new QrImageError('Could not open that image. Try a screenshot or paste the URL.')), 15000);
      signal?.addEventListener('abort', cancel, { once: true });
      image.onload = () => done(); image.onerror = () => done(new QrImageError('Could not open that image. Try a PNG or JPEG screenshot.'));
      image.src = url;
    });
    checkpoint();
    const { default: jsQR } = await import('jsqr');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    for (const maximum of [960, 1800]) {
      checkpoint();
      const scale = Math.min(1, maximum / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      // Allow cancel/paint between the two decoding attempts.
      await new Promise(resolve => setTimeout(resolve, 0)); checkpoint();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' });
      checkpoint(); if (code?.data) return code.data;
      if (scale === 1) break;
    }
    throw new QrImageError('No QR code found. Include the whole code with a little border, or paste the pairing URL.');
  } finally {
    image.onload = image.onerror = null; image.removeAttribute('src'); canvas.width = canvas.height = 1;
    if (revoke) URL.revokeObjectURL(url);
  }
}
