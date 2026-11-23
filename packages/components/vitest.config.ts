import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import stylex from '@stylexjs/unplugin';
import { defineConfig } from 'vitest/config';
import wasm from 'vite-plugin-wasm';
import type { Plugin } from 'vite';
import { componentsStylexOptions as stylexOptions } from './stylex-options';
import { loroCrdtWasmUrlWorkaround, VITEST_INLINE_WASM_DEPS } from './vite-wasm-workarounds';

// Inline Vitest projects do not carry the root plugin named `vitest` in v3.
// vite-plugin-wasm uses that name to detect Node execution; force its SSR path
// here so real WASM bytes load in Node instead of fetching a browser /@fs/ URL.
function wasmForTests(): Plugin {
  const plugin = wasm() as Plugin;
  const load = typeof plugin.load === 'function' ? plugin.load : plugin.load?.handler;
  return {
    ...plugin,
    load(id, options) {
      return load?.call(this, id, { ...options, ssr: true });
    },
  };
}

const root = fileURLToPath(new URL('.', import.meta.url));
const testFiles = ['tests', 'src'].flatMap((directory) =>
  readdirSync(new URL(`./${directory}`, import.meta.url), { recursive: true })
    .filter((file) => /\.test\.tsx?$/.test(file))
    .map((file) => `${directory}/${file.replaceAll('\\', '/')}`)
);

// These suites install long-lived browser listeners or change process-wide APIs.
// Module mocks also need a fresh registry; all other files can reuse their graph.
const isolatedFiles = new Set([
  'tests/avatar-cache.test.ts',
  'tests/client-log.test.tsx',
  'tests/boot-shell.test.tsx',
  'tests/cached-avatar-img.test.ts',
  'tests/session-side-panel-tab-bar.test.tsx',
  'tests/session-tab-bar.test.tsx',
  'tests/dropdown-menu.test.tsx',
]);
const reusable = { node: [] as string[], jsdom: [] as string[] };
for (const file of testFiles) {
  const source = readFileSync(`${root}/${file}`, 'utf8');
  if (
    isolatedFiles.has(file) ||
    /\bvi\s*\.\s*(?:mock|doMock|unmock|doUnmock|resetModules|hoisted)\s*\(/.test(source)
  )
    continue;
  const environment = /@vitest-environment\s+jsdom/.test(source) ? 'jsdom' : 'node';
  reusable[environment].push(file);
}

export default defineConfig({
  define: {},
  plugins: [
    stylex.rollup({ ...stylexOptions, dev: false }),
    loroCrdtWasmUrlWorkaround(),
    wasmForTests(),
  ],
  resolve: {
    alias: [
      // Must precede the general `@/` rule: Vite matches aliases in order
      // against the raw specifier. 324 icon SVGs no test asserts on; see the
      // stub's own comment for why they are worth aliasing away.
      {
        find: '@/components/icons/file-icons/asset-url',
        replacement: fileURLToPath(
          new URL('./tests/stubs/file-icon-asset-url.ts', import.meta.url)
        ),
      },
      {
        find: '@pierre/diffs/worker/worker.js?worker',
        replacement: fileURLToPath(new URL('./tests/stubs/browser-worker.ts', import.meta.url)),
      },
      { find: /^@\//, replacement: `${fileURLToPath(new URL('./src', import.meta.url))}/` },
      { find: '@pkg', replacement: fileURLToPath(new URL('../../package.json', import.meta.url)) },
    ],
  },
  test: {
    fsModuleCache: true,
    projects: [
      ...(['node', 'jsdom'] as const).map((environment) => ({
        extends: true as const,
        test: {
          name: `shared-${environment}`,
          include: reusable[environment],
          environment,
          isolate: false,
          // Do not let isolated files evict this worker's reusable module graph.
          sequence: { groupOrder: environment === 'node' ? 1 : 2 },
          setupFiles: ['tests/setup-shared.ts'],
        },
      })),
      {
        extends: true,
        test: {
          name: 'isolated',
          include: [
            'tests/**/*.test.ts',
            'tests/**/*.test.tsx',
            'src/**/*.test.ts',
            'src/**/*.test.tsx',
          ],
          exclude: [...reusable.node, ...reusable.jsdom],
          environment: 'node',
          isolate: true,
          sequence: { groupOrder: 0 },
        },
      },
    ],
    setupFiles: ['tests/setup.ts'],
    // Keep diagnostics from failing tests while avoiding the substantial I/O
    // produced by expected logs from hundreds of passing files.
    silent: 'passed-only',
    // Root local/CI runners override this default with their machine-wide budget.
    // Keep separate registries for module-mocked suites while reusing safe graphs.
    pool: 'threads',
    maxWorkers: 8,
    server: {
      deps: {
        inline: VITEST_INLINE_WASM_DEPS,
      },
    },
  },
});
