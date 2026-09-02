const tailwindcss = require('@tailwindcss/vite').default;
const stylex = require('@stylexjs/unplugin').default;
const { stylexOptions } = require('../../ui/stylex-options.ts');
const { loadEnv } = require('vite');
const { resolve } = require('node:path');
const wasm = require('vite-plugin-wasm').default;
const topLevelAwait = require('../vite-top-level-await-fixed.cjs');
const { loroCrdtWasmUrlWorkaround } = require('../vite-wasm-workarounds.ts');
const {
  requirePreviewPublicBaseDomain,
} = require('../../../scripts/preview-public-base-domain.mjs');

/** @type {import('@storybook/react-vite').StorybookConfig} */
const config = {
  stories: ['../src/stories/**/*.mdx', '../src/stories/**/*.stories.@(js|jsx|ts|tsx)'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  async viteFinal(viteConfig) {
    const mode = viteConfig.mode ?? 'development';
    const previewPublicBaseDomain = requirePreviewPublicBaseDomain(
      { ...loadEnv(mode, resolve(__dirname, '..'), ''), ...process.env },
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

module.exports = config;
