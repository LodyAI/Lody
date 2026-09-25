import type { StorybookConfig } from '@storybook/react-vite';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { searchForWorkspaceRoot } from 'vite';
import stylex from '@stylexjs/unplugin';
import tailwindcss from '@tailwindcss/vite';
import wasm from 'vite-plugin-wasm';
import { stylexOptions } from '../../ui/stylex-options';
import topLevelAwait from '../vite-top-level-await-fixed.cjs';
import { loroCrdtWasmUrlWorkaround } from '../vite-wasm-workarounds.ts';

const require = createRequire(import.meta.url);

const config: StorybookConfig = {
  stories: ['../src/stories/**/*.mdx', '../src/stories/**/*.stories.@(js|jsx|ts|tsx)'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  async viteFinal(viteConfig) {
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
      return true;
    });
    viteConfig.plugins.push(tailwindcss());
    viteConfig.plugins.push(stylex.vite(stylexOptions));

    viteConfig.worker = {
      ...(viteConfig.worker ?? {}),
      format: 'es',
      plugins: () => [loroCrdtWasmUrlWorkaround(), wasm(), topLevelAwait()],
    };

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
