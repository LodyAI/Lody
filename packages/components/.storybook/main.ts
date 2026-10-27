import type { StorybookConfig } from '@storybook/react-vite';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { searchForWorkspaceRoot } from 'vite';
import stylex from '@stylexjs/unplugin';
import tailwindcss from '@tailwindcss/vite';
import wasm from 'vite-plugin-wasm';
import { componentsStylexOptions as stylexOptions } from '../stylex-options';
import { emojibaseAssetsPlugin } from '../vite-emojibase-assets';
import { loroCrdtWasmUrlWorkaround } from '../vite-wasm-workarounds.ts';
import { preservePdfWorkerExports } from '../vite-pdf-worker';

// The shell can export NODE_ENV=production even while running Storybook's dev
// server. Vite's React plugin then disables its refresh runtime while the
// serve transform still emits refresh signatures. Keep only `storybook dev`
// aligned with its actual mode; `storybook build` remains production.
if (process.argv.includes('dev') && process.env.NODE_ENV === 'production') {
  process.env.NODE_ENV = 'development';
}

const require = createRequire(import.meta.url);

const config: StorybookConfig = {
  stories: ['../src/stories/**/*.mdx', '../src/stories/**/*.stories.@(js|jsx|ts|tsx)'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  async viteFinal(viteConfig) {
    // 1.0.10 declares its source web-component module as a side effect, but ships
    // dist files. Prebundling drops registration of <diffs-container> entirely.
    viteConfig.optimizeDeps = {
      ...viteConfig.optimizeDeps,
      exclude: [
        ...(viteConfig.optimizeDeps?.exclude ?? []),
        '@pierre/diffs',
        '@pierre/diffs/react',
        '@pierre/diffs/worker',
      ],
      include: [...(viteConfig.optimizeDeps?.include ?? []), '@pierre/diffs > lru_map'],
    };
    // In an embedded checkout pnpm stores these assets outside the public
    // workspace. Allow only the resolved font packages, not the private repo.
    viteConfig.server = {
      ...viteConfig.server,
      fs: {
        ...viteConfig.server?.fs,
        allow: [
          ...(viteConfig.server?.fs?.allow ?? [searchForWorkspaceRoot(process.cwd())]),
          dirname(require.resolve('@fontsource/inter/package.json')),
          dirname(require.resolve('@fontsource/jetbrains-mono/package.json')),
        ],
      },
    };
    viteConfig.plugins = (viteConfig.plugins ?? []).filter((plugin) => {
      if (!plugin) return false;
      const name = 'name' in plugin ? String(plugin.name) : '';
      if (name === 'dts' || name === 'vite:dts') return false;
      if (name.includes('tanstack')) return false;
      // Modern browser targets evaluate WASM through native top-level await.
      if (name.startsWith('vite-plugin-top-level-await')) return false;
      return true;
    });
    viteConfig.plugins.push(tailwindcss());
    viteConfig.plugins.push(stylex.vite(stylexOptions));
    viteConfig.plugins.push({
      name: 'storybook-diffs-web-component-registration',
      enforce: 'post',
      transform(code, id) {
        if (!id.includes('/@pierre/diffs/') || !id.endsWith('/components/web-components.js'))
          return undefined;
        // 1.0.10 names only its unpublished src path in package.sideEffects.
        // Keep the shipped module's real custom-element registration in builds.
        return { code, map: null, moduleSideEffects: 'no-treeshake' };
      },
    });
    // Serves `/emojibase/<locale>/{data,messages}.json` in dev so the picker's
    // bundled-dataset URL contract holds here too, not only in app builds.
    viteConfig.plugins.push(emojibaseAssetsPlugin());
    viteConfig.plugins.push({
      name: 'storybook-native-module-initialization',
      enforce: 'post',
      config(storybookViteConfig, { command }) {
        if (command !== 'build') return;
        // Keep browser-native evaluation of cyclic async module graphs.
        // Storybook 10.6 forces wrappers that can await one another; combining
        // modules into shared chunks can also introduce new async cycles.
        const bundlerOptions = storybookViteConfig.build?.rolldownOptions;
        if (!bundlerOptions) return;
        bundlerOptions.preserveEntrySignatures = 'exports-only';
        const output = bundlerOptions.output;
        for (const options of Array.isArray(output) ? output : output ? [output] : []) {
          options.strictExecutionOrder = false;
          options.preserveModules = true;
        }
      },
    });

    viteConfig.worker = {
      ...(viteConfig.worker ?? {}),
      format: 'es',
      plugins: () => [preservePdfWorkerExports(), loroCrdtWasmUrlWorkaround(), wasm()],
    };
    viteConfig.build = { ...viteConfig.build, target: 'esnext' };

    if (process.env.STORYBOOK_DEBUG_PLUGINS === '1') {
      // eslint-disable-next-line no-console
      console.log(
        'storybook vite plugins:',
        (viteConfig.plugins ?? [])
          .map((plugin) => ('name' in plugin ? String(plugin.name) : ''))
          .filter(Boolean)
          .sort()
      );
    }
    return viteConfig;
  },
};

export default config;
