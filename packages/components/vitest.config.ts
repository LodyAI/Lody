import stylex from '@stylexjs/unplugin';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import topLevelAwait from 'vite-plugin-top-level-await';
import wasm from 'vite-plugin-wasm';
import { loroCrdtWasmUrlWorkaround, VITEST_INLINE_WASM_DEPS } from './vite-wasm-workarounds';
import { stylexOptions } from '../ui/stylex-options';

export default defineConfig({
  define: {
    'import.meta.env.VITE_PREVIEW_PUBLIC_BASE_DOMAIN': JSON.stringify('mylody.app'),
  },
  plugins: [
    loroCrdtWasmUrlWorkaround(),
    tsconfigPaths(),
    wasm(),
    topLevelAwait(),
    stylex.rollup({ ...stylexOptions, dev: false }),
  ],
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
