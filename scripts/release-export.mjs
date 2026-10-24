import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const output = process.argv[2] && path.resolve(process.argv[2]);
if (!output || !output.endsWith('.tar.gz')) throw new Error('Usage: npm run release:export -- /path/outside/repo/pageborne-source.tar.gz');
const relative = path.relative(root, output);
if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error('Choose an output outside the repository.');
if (existsSync(output)) throw new Error('Output already exists; choose another name.');
if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error('Commit or resolve source changes before exporting; ignored local config stays private.');
execFileSync(process.execPath, ['scripts/release-audit.mjs'], { stdio: 'inherit' });
execFileSync('git', ['archive', '--format=tar.gz', '--prefix=pageborne/', `--output=${output}`, 'HEAD']);
console.log(`Exported committed shared source to ${output}. No Git history, private config or build artifacts included. Nothing was pushed.`);
