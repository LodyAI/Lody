import fs from 'node:fs';
import path from 'node:path';

const RELATIVE_MANIFEST_READ =
  /readFileSync\(\s*new URL\(\s*(['"])(\.\.\/package\.json)\1\s*,\s*import\.meta\.url\s*\)\s*,\s*(['"])utf-?8\3\s*\)/g;
const RELATIVE_MANIFEST_READ_TEST = new RegExp(RELATIVE_MANIFEST_READ.source);

/**
 * Bundled dependencies (such as `@sorbetai/control`) can read `../package.json`
 * relative to `import.meta.url` at module top level. When Vite emits them under
 * `dist/chunks/vendor-*.js`, `../package.json` resolves to a nonexistent
 * `dist/package.json` (and does not exist on disk in Daemon SEA either).
 * Inline the dependency's own `{ name, version }` manifest at build time so the
 * chunk keeps its real package identity without reading the filesystem.
 */
export function inlinePackageManifestPlugin() {
  return {
    name: 'lody-inline-package-manifest',
    transform(code, id) {
      const normalizedId = id.replaceAll('\\', '/');
      if (!normalizedId.includes('/node_modules/') || !code.includes('package.json')) return null;
      const cleanId = id.split('?')[0];
      let replaced = false;
      const next = code.replace(RELATIVE_MANIFEST_READ, (_match, _quote, relPath) => {
        const manifestPath = path.resolve(path.dirname(cleanId), relPath);
        if (!fs.existsSync(manifestPath)) {
          this.error(`${cleanId}: cannot inline ${relPath}; ${manifestPath} does not exist.`);
        }
        const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (typeof raw?.name !== 'string' || typeof raw?.version !== 'string') {
          this.error(`${manifestPath}: expected string "name" and "version" fields.`);
        }
        replaced = true;
        return JSON.stringify(JSON.stringify({ name: raw.name, version: raw.version }));
      });
      return replaced ? { code: next, map: null } : null;
    },
    renderChunk(code, chunk) {
      if (chunk.fileName.startsWith('chunks/') && RELATIVE_MANIFEST_READ_TEST.test(code)) {
        this.error(
          `${chunk.fileName}: unresolved readFileSync(new URL("../package.json", import.meta.url)) in nested chunk.`
        );
      }
      return null;
    },
  };
}
