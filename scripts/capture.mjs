import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));

export async function captureTools() {
  const local = path.join(root, '.tools/bin');
  const choose = async (name, variable) => {
    if (process.env[variable]) return process.env[variable];
    const candidate = path.join(local, name);
    try { await access(candidate); return candidate; } catch { return name; }
  };
  return { ffmpeg: await choose('ffmpeg', 'FFMPEG') };
}
