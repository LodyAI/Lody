import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';
import tailwindcss from '@tailwindcss/vite';
import { loadEnv } from 'vite';
import wasm from 'vite-plugin-wasm';
import { requirePreviewPublicBaseDomain } from '../../../scripts/preview-public-base-domain.mjs';
import topLevelAwait from '../vite-top-level-await-fixed.cjs';
import { loroCrdtWasmUrlWorkaround } from '../vite-wasm-workarounds.ts';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

const config: StorybookConfig = {
  stories: ['../src/stories/**/*.mdx', '../src/stories/**/*.stories.@(js|jsx|ts|tsx)'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  async viteFinal(viteConfig) {
    const mode = viteConfig.mode ?? 'development';
    const previewPublicBaseDomain = requirePreviewPublicBaseDomain(
      { ...loadEnv(mode, packageRoot, ''), ...process.env },
      `@lody/components Storybook (${mode})`
    );
    viteConfig.define = {
      ...viteConfig.define,
      'import.meta.env.VITE_PREVIEW_PUBLIC_BASE_DOMAIN': JSON.stringify(previewPublicBaseDomain),
    };
    viteConfig.plugins = (viteConfig.plugins ?? []).filter((plugin) => {
      if (!plugin) return false;
      const name = 'name' in plugin ? String(plugin.name) : '';
      if (name === 'dts' || name === 'vite:dts') return false;
      if (name.includes('tanstack')) return false;
      return true;
    });
    viteConfig.plugins.push(tailwindcss());

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
