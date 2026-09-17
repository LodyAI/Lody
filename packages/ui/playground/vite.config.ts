import stylex from '@stylexjs/unplugin';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { stylexOptions } from '../stylex-options';

const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * StyleX resolves its variables against the repository root, and the playground
 * imports the package's source from outside its own root, so the dev server has
 * to be allowed to read up there.
 */
const repoRoot = path.resolve(here, '../../..');

/**
 * The icon playground: the `@lody/icons` package's consumer page, with no
 * Storybook under it.
 *
 * The board in `src/gallery` is the visual reference — one sample per token,
 * read back off the rendered node. An icon set is the other thing: 75 drawings
 * you want to search, scale, recolour, drop on a different rung and copy out.
 * That is a page with controls, not a row on a board, so it lives here and
 * runs on its own Vite server.
 */
export default defineConfig({
  root: here,
  plugins: [react(), stylex.vite(stylexOptions)],
  server: { port: 5178, fs: { allow: [repoRoot] } },
  build: { outDir: path.join(here, 'dist'), emptyOutDir: true },
});
