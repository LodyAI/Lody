import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import topLevelAwait from 'vite-plugin-top-level-await';
import wasm from 'vite-plugin-wasm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const inlineEnv = {
  // The public bundle is local-only. Deployment endpoints must never be baked
  // into it from a developer shell or an untracked environment file.
  'process.env.LODY_PLATFORM': JSON.stringify('local'),
  'process.env.LODY_ENV': JSON.stringify(''),
  'process.env.WS_NO_BUFFER_UTIL': JSON.stringify('true'),
  'process.env.WS_NO_UTF_8_VALIDATE': JSON.stringify('true'),
};

const bundledNodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);

const explicitlyExternal = new Set([
  'better-sqlite3',
  '@lydell/node-pty',
  '@sqlite.org/sqlite-wasm',
  'broadcast-channel',
  // TypeScript's CommonJS runtime reads __filename during sys initialization.
  // Keep it external; LSP code paths lazy-load it only for LSP requests.
  'typescript',
  // Tinypool resolves its own entry/worker.js relative to its package dir, so it
  // cannot be inlined. Kept external and staged into the Electron app like the
  // other external runtime deps (apps/electron/scripts/cli-native-deps.mjs).
  'tinypool',
  // @vscode/ripgrep resolves its binary out of a sibling per-platform package by
  // `require.resolve`. Inlining that call would resolve it against the bundle,
  // where no such package exists, so the shim must stay external and be staged.
  '@vscode/ripgrep',
]);

export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  define: inlineEnv,
  resolve: {
    alias: {
      // loro-crdt >=1.13 routes the `node` condition to its CJS nodejs entry,
      // which locates loro_wasm_bg.wasm via __dirname + fs and cannot be inlined
      // into this ESM bundle (rejected: externalizing — the electron-embedded CLI
      // ships dist/ only, with no node_modules to resolve loro-crdt from).
      // Pin the ESM bundler entry so vite-plugin-wasm embeds the wasm like 1.12.x.
      'loro-crdt': 'loro-crdt/bundler',
      '@/pkg': path.resolve(__dirname, 'package.json'),
      '@': path.resolve(__dirname, 'src'),
      src: path.resolve(__dirname, 'src'),
    },
  },
  ssr: {
    external: ['bufferutil', 'utf-8-validate', 'typescript'],
    noExternal: true,
  },
  build: {
    target: 'node22',
    outDir: './dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    ssr: true,
    ssrEmitAssets: true,
    rollupOptions: {
      // index.js is the CLI entry; the *-worker.js files are standalone Tinypool worker
      // bundles emitted as siblings so each pool can resolve it next to index.js.
      // turn-diff-store-worker bundles the TypeScript workspace package while keeping
      // better-sqlite3 external, just like the main CLI entry.
      input: {
        index: path.resolve(__dirname, 'src/index.ts'),
        'codex-acp': path.resolve(__dirname, 'src/codex-acp-entry.ts'),
        'claude-acp': path.resolve(__dirname, 'src/claude-acp-entry.ts'),
        'deepseek-acp': path.resolve(__dirname, 'src/deepseek-acp-entry.ts'),
        'grok-acp': path.resolve(__dirname, 'src/grok-acp-entry.ts'),
        'diff-worker': path.resolve(__dirname, 'src/lib/code-collab/diff-worker.ts'),
        'file-index-scan-worker': path.resolve(
          __dirname,
          'src/lib/code-collab/file-index-scan-worker.ts'
        ),
        'turn-diff-store-worker': path.resolve(
          __dirname,
          'src/lib/code-collab/turn-diff-store-worker.ts'
        ),
        'code-collab-watch-worker': path.resolve(
          __dirname,
          'src/lib/code-collab/workspace-watch-worker.ts'
        ),
      },
      external: (id) =>
        id.endsWith('.node') || bundledNodeBuiltins.has(id) || explicitlyExternal.has(id),
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
