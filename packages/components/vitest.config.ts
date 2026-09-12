import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import wasm from 'vite-plugin-wasm';
import { loroCrdtWasmUrlWorkaround, VITEST_INLINE_WASM_DEPS } from './vite-wasm-workarounds';

export default defineConfig({
  define: {
    'import.meta.env.VITE_PREVIEW_PUBLIC_BASE_DOMAIN': JSON.stringify('mylody.app'),
  },
  plugins: [
    loroCrdtWasmUrlWorkaround(),
    // vite-plugin-wasm detects Vitest by this exact plugin name, while Vitest 5
    // exposes only `vitest:*` plugins. Keep WASM inline for the Node runner.
    { name: 'vitest' },
    wasm(),
  ],
  resolve: {
    alias: [
      {
        find: '@pierre/diffs/worker/worker.js?worker',
        replacement: fileURLToPath(new URL('./tests/stubs/diff-render-worker.ts', import.meta.url)),
      },
      // Must precede the general `@/` rule: Vite matches aliases in order
      // against the raw specifier. 324 icon SVGs no test asserts on; see the
      // stub's own comment for why they are worth aliasing away.
      {
        find: '@/components/icons/file-icons/asset-url',
        replacement: fileURLToPath(
          new URL('./tests/stubs/file-icon-asset-url.ts', import.meta.url)
        ),
      },
      { find: /^@\//, replacement: `${fileURLToPath(new URL('./src', import.meta.url))}/` },
      { find: '@pkg', replacement: fileURLToPath(new URL('../../package.json', import.meta.url)) },
    ],
  },
  test: {
    // `src/**` is included so a test written next to its module runs instead of
    // silently never running. Two such files had accumulated under `src/lib`,
    // one of them a diverged copy of a live suite — 16 passing tests that no
    // run had ever executed. Tests still belong in `tests/`; this only makes a
    // misplaced one fail loudly rather than look like coverage it is not.
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    // Keep diagnostics from failing tests while avoiding the substantial I/O
    // produced by expected logs from hundreds of passing files.
    silent: 'passed-only',
    // This suite has hundreds of small files whose transform/collection cost dominates
    // their assertions. Eight local workers cut a representative full run from 94s to
    // 37s. The root test:ci command still passes --maxWorkers=2 for CI-sized hosts.
    pool: 'threads',
    maxWorkers: 8,
    server: {
      deps: {
        inline: VITEST_INLINE_WASM_DEPS,
      },
    },
  },
});
