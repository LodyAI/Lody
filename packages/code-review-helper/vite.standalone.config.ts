import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import stylex from '@stylexjs/unplugin';
import { reviewStylexOptions } from './stylex-options';

/**
 * Build for the standalone single-file review viewer (`pnpm build:standalone`).
 *
 * Output: `dist-standalone/index.html` — one self-contained HTML file with all JS
 * and CSS inlined (via `vite-plugin-singlefile`). It carries no review data; the
 * CLIs splice a `window.__LODY_REVIEW__` snapshot into it at render time
 * (`src/standalone/inject.ts`).
 *
 * `curatedShikiLangs` is the key size control: it redirects the `bundledLanguages`
 * / `bundledThemes` modules that shiki's index re-exports to our curated shims, so
 * only ~40 grammars (instead of 383) and zero bundled themes are inlined. Without
 * it the single file would balloon past 12 MB. See `src/standalone/curated-shiki-*`.
 */
function curatedShikiLangs(): Plugin {
  const langsShim = fileURLToPath(
    new URL('./src/standalone/curated-shiki-langs.ts', import.meta.url)
  );
  const themesShim = fileURLToPath(
    new URL('./src/standalone/curated-shiki-themes.ts', import.meta.url)
  );
  return {
    name: 'lody-curated-shiki-langs',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      // Resolve the import the normal way, then redirect by its resolved target so
      // we catch shiki's `bundledLanguages` / `bundledThemes` modules however they
      // are imported (the bare-specifier importer check was too brittle).
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved == null) {
        return null;
      }
      const id = resolved.id.replace(/\\/g, '/');
      if (/\/shiki\/dist\/langs\.mjs$/.test(id)) {
        return langsShim;
      }
      if (/\/shiki\/dist\/themes\.mjs$/.test(id)) {
        return themesShim;
      }
      return null;
    },
  };
}

const { generateBundle: appendStylexCss, ...stylexTransform } = stylex.vite(
  reviewStylexOptions
) as Plugin;

// Vite emits CSS after pre plugins. Append extracted rules after that emission,
// before singlefile consumes the assets; source transforms must still run pre.
const stylexOutput: Plugin = {
  name: 'review-stylex-before-singlefile',
  enforce: 'post',
  generateBundle: appendStylexCss,
};

export default defineConfig({
  plugins: [
    curatedShikiLangs(),
    react(),
    tailwindcss(),
    stylexTransform,
    stylexOutput,
    viteSingleFile(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    outDir: 'dist-standalone',
    emptyOutDir: true,
    // Avoid hashed asset names; singlefile inlines everything into index.html anyway.
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    chunkSizeWarningLimit: 8000,
    rollupOptions: {
      input: fileURLToPath(new URL('./standalone.html', import.meta.url)),
    },
  },
});
