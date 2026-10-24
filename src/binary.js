export function bytesToBase64(bytes) {
  const parts = [];
  for (let i = 0; i < bytes.length; i += 49152) parts.push(btoa(String.fromCharCode(...bytes.subarray(i, i + 49152))));
  return parts.join('');
}
export function base64ToBytes(value) {
  const binary = atob(value); const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
