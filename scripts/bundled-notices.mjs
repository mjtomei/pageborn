import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// Record the dependencies actually included by Rollup, not every optional
// native package that npm may install for a different runtime/platform.
export function bundledNotices() {
  return {
    name: 'bundled-third-party-notices',
    generateBundle() {
      const packages = new Map();
      for (const id of this.getModuleIds()) {
        if (!id.includes('/node_modules/')) continue;
        let directory = path.dirname(id.split('?')[0]);
        while (directory.includes('/node_modules/')) {
          const file = path.join(directory, 'package.json');
          if (existsSync(file)) {
            const pkg = JSON.parse(readFileSync(file, 'utf8'));
            if (pkg.name && pkg.version) {
              packages.set(directory, pkg);
              break;
            }
          }
          directory = path.dirname(directory);
        }
      }
      const manifest = [];
      for (const [directory, pkg] of packages) {
        if (pkg.name === 'sharp' || pkg.name.startsWith('@img/sharp')) {
          this.error(`Unexpected native image dependency in browser build: ${pkg.name}`);
        }
        const prefix = `licenses/bundled/${pkg.name}/`;
        const notices = readdirSync(directory, { withFileTypes: true })
          .filter(entry => entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:[._-]|$)/i.test(entry.name))
          .map(entry => entry.name);
        for (const file of notices) this.emitFile({ type: 'asset', fileName: prefix + file, source: readFileSync(path.join(directory, file)) });
        // Preserve declarations even if an upstream npm package omitted its
        // license text. Such omissions remain explicit in the review record.
        const record = { name: pkg.name, version: pkg.version, license: pkg.license ?? null, notices };
        this.emitFile({ type: 'asset', fileName: prefix + 'package-notice.json', source: JSON.stringify(record, null, 2) + '\n' });
        manifest.push(record);
      }
      manifest.sort((a, b) => a.name.localeCompare(b.name));
      this.emitFile({ type: 'asset', fileName: 'licenses/bundled/manifest.json', source: JSON.stringify(manifest, null, 2) + '\n' });
    },
  };
}
