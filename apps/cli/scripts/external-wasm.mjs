import path from 'node:path';

const INLINE_URL =
  /^const (__vite__wasmUrl[\w$]*) = "data:application\/wasm;base64,([A-Za-z0-9+/=]+)";$/gm;
const INIT_DATA_BRANCH =
  /^(const __vite__initWasm[\w$]* = async \(opts = \{\}, url\) => \{\n[ \t]+let result;\n[ \t]+)if \(url\.startsWith\("data:"\)\) \{$/gm;

/**
 * vite-plugin-wasm inlines every module as a base64 data URL in SSR builds. V8 keeps a
 * loaded module's source text, so each process that imports Loro or Flock retained
 * ~9 MB of base64 beside the instance it had already compiled. This emits the bytes as
 * an asset and reads them from disk instead, the packaging contract `zstd.wasm` already
 * relies on: every distribution copies `dist/` except sourcemaps.
 */
export function externalWasmPlugin() {
  let urls = 0;
  let loaders = 0;
  return {
    name: 'lody-external-wasm',
    renderStart() {
      urls = 0;
      loaders = 0;
    },
    renderChunk(code, chunk) {
      let chunkLoaders = 0;
      const output = code
        .replace(INLINE_URL, (_line, binding, base64) => {
          const fileName = this.getFileName(
            this.emitFile({
              type: 'asset',
              name: `${chunk.name.replace(/^vendor-/, '')}.wasm`,
              source: Buffer.from(base64, 'base64'),
            })
          );
          const relative = path.posix.relative(path.posix.dirname(chunk.fileName), fileName);
          urls += 1;
          return `const ${binding} = new URL(${JSON.stringify(`./${relative}`)}, import.meta.url).href;`;
        })
        .replace(INIT_DATA_BRANCH, (_line, head) => {
          chunkLoaders += 1;
          return `${head}if (url.startsWith("file:")) { result = await WebAssembly.instantiate(__lody__readWasmFile(new URL(url)), opts); } else if (url.startsWith("data:")) {`;
        });
      if (output.includes('"data:application/wasm;base64,'))
        this.error(`${chunk.fileName}: unrecognized inline wasm; update the external wasm transform.`);
      if (output === code) return null;
      loaders += chunkLoaders;
      return {
        code: chunkLoaders
          ? `${output}\nimport { readFileSync as __lody__readWasmFile } from "node:fs";\n`
          : output,
        map: null,
      };
    },
    generateBundle() {
      if (urls > 0 && loaders === 0)
        this.error('vite-plugin-wasm loader changed; update the external wasm transform.');
    },
  };
}
