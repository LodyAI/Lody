import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';
import topLevelAwait from 'vite-plugin-top-level-await';
import wasm from 'vite-plugin-wasm';
import { loroCrdtBundlerAlias, loroCrdtWasmUrlWorkaround } from './vite-wasm-workarounds.ts';
import {
  rendererBundleAliasPlugin,
  rendererBundleAliases,
} from './vite-renderer-bundle-aliases.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isStorybook =
  process.env.npm_lifecycle_event?.includes('storybook') ||
  process.env.STORYBOOK === 'true' ||
  process.env.STORYBOOK === '1' ||
  process.argv.some((arg) => arg.includes('storybook'));

export default defineConfig(async () => {
  const plugins = [
    ...(isStorybook
      ? []
      : [
          dts({
            entryRoot: 'src',
            tsconfigPath: path.join(__dirname, 'tsconfig.json'),
          }),
        ]),
    loroCrdtWasmUrlWorkaround(),
    rendererBundleAliasPlugin(),
    react(),
    tsconfigPaths({ projects: ['tsconfig.vite.json'] }),
    wasm(),
    topLevelAwait(),
  ];

  if (!isStorybook) {
    const { tanstackRouter } = await import('@tanstack/router-plugin/vite');
    plugins.splice(2, 0, tanstackRouter({ target: 'react', autoCodeSplitting: true }));
  }

  return {
    plugins,
    resolve: {
      // Keep Storybook prod builds off loro-crdt's sync-WASM browser entry
      // (loroCrdtWasmUrlWorkaround fails the build if it sneaks back in).
      alias: [...loroCrdtBundlerAlias(), ...rendererBundleAliases()],
    },
    oxc: {
      keepNames: true,
    },
    build: {
      target: 'esnext',
      outDir: './dist',
      emptyOutDir: true,
    },
  };
});
