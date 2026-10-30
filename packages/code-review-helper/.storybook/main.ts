import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';
import tailwindcss from '@tailwindcss/vite';
import { mergeConfig } from 'vite';
import stylex from '@stylexjs/unplugin';
import { reviewStylexOptions } from '../stylex-options';

const require = createRequire(import.meta.url);

function getAbsolutePath(packageName: string): string {
  return dirname(require.resolve(join(packageName, 'package.json')));
}

const config: StorybookConfig = {
  stories: ['../src/stories/**/*.stories.@(js|jsx|ts|tsx|mdx)'],
  framework: {
    name: getAbsolutePath('@storybook/react-vite'),
    options: {},
  },
  async viteFinal(viteConfig) {
    return mergeConfig(viteConfig, {
      assetsInclude: ['**/*.review.json.gz'],
      plugins: [tailwindcss(), stylex.vite(reviewStylexOptions)],
      resolve: {
        alias: {
          '@': fileURLToPath(new URL('../src', import.meta.url)),
        },
      },
      worker: {
        format: 'es',
      },
    });
  },
};

export default config;
