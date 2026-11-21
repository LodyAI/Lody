import { fileURLToPath } from 'node:url';
import { normalizePath, type Plugin } from 'vite';

const polyfills = normalizePath(fileURLToPath(new URL('./src/polyfills.ts', import.meta.url)));
const entryPrefix = '\0lody-mobile-worker:';

/** Workers have their own globals, including dependency-owned worker entries. */
export function mobileWorkerPolyfills(workerBuild = false): Plugin {
  return {
    name: 'lody-mobile-worker-polyfills',
    enforce: 'pre',
    options(options) {
      if (!workerBuild || typeof options.input !== 'string') return null;
      // Wrap the entry explicitly: dependency packages may declare sideEffects:
      // false, and their modules need not be marked isEntry during transform.
      return { ...options, input: `${entryPrefix}${options.input}` };
    },
    async resolveId(id, importer) {
      if (id.startsWith(entryPrefix)) return id;
      if (!importer?.startsWith(entryPrefix)) return null;
      const resolved = await this.resolve(id, importer, { skipSelf: true });
      return resolved ? { ...resolved, moduleSideEffects: 'no-treeshake' } : null;
    },
    load(id) {
      if (!id.startsWith(entryPrefix)) return null;
      return {
        code: `import ${JSON.stringify(polyfills)};\nexport * from ${JSON.stringify(id.slice(entryPrefix.length))};`,
        moduleSideEffects: 'no-treeshake',
      };
    },
    transform(code, id) {
      // Vite serves worker entries through this query in development.
      const devWorker = /[?&]worker_file(?:&|$)/.test(id);
      if (!devWorker) return null;
      return { code: `import ${JSON.stringify(polyfills)};\n${code}`, map: null };
    },
  };
}
