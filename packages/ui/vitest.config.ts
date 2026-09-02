import stylex from '@stylexjs/unplugin';
import { defineConfig } from 'vitest/config';
import { stylexOptions } from './stylex-options';

export default defineConfig({
  plugins: [stylex.rollup({ ...stylexOptions, dev: false })],
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'jsdom',
  },
});
