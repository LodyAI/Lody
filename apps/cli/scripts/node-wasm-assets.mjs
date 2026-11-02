import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** @returns {import('vite').Plugin} */
export function nodeWasmAssets() {
  const assets = new Set();
  return {
    name: 'lody-node-wasm-assets',
    enforce: 'pre',
    apply: 'build',
    async load(id) {
      if (!id.toLowerCase().endsWith('.wasm')) return null;

      const source = await readFile(id);
      const module = await WebAssembly.compile(source);
      const reference = this.emitFile({ type: 'asset', name: path.basename(id), source });
      assets.add(reference);

      const imports = new Map();
      for (const entry of WebAssembly.Module.imports(module)) {
        const names = imports.get(entry.module) ?? [];
        names.push(entry.name);
        imports.set(entry.module, names);
      }
      const declarations = [];
      const bindings = [];
      for (const [index, [from, names]] of [...imports].entries()) {
        const namespace = `__lody_wasm_import_${index}`;
        declarations.push(`import * as ${namespace} from ${JSON.stringify(from)};`);
        bindings.push(
          `[${JSON.stringify(from)}]: { ${names
            .map((name) => `[${JSON.stringify(name)}]: ${namespace}[${JSON.stringify(name)}]`)
            .join(', ')} }`
        );
      }
      const exports = WebAssembly.Module.exports(module).map(({ name }, index) => {
        const binding = `__lody_wasm_export_${index}`;
        return `const ${binding} = __lody_wasm_instance.exports[${JSON.stringify(name)}];
export { ${binding} as ${JSON.stringify(name)} };`;
      });
      return [
        `import { readFile as __lody_read_wasm } from 'node:fs/promises';`,
        ...declarations,
        `const __lody_wasm_imports = { ${bindings.join(', ')} };
const { instance: __lody_wasm_instance } = await WebAssembly.instantiate(
  await __lody_read_wasm(import.meta.ROLLUP_FILE_URL_${reference}),
  __lody_wasm_imports
);`,
        ...exports,
      ].join('\n');
    },
    resolveFileUrl({ referenceId, relativePath }) {
      if (!assets.has(referenceId)) return null;
      const encoded = relativePath
        .replaceAll('\\', '/')
        .split('/')
        .map(encodeURIComponent)
        .join('/');
      return `new URL(${JSON.stringify(encoded)}, import.meta.url)`;
    },
  };
}
