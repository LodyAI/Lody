import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import stylex from '@stylexjs/unplugin';
import { reviewStylexOptions } from './stylex-options';

export default defineConfig({
  plugins: [stylex.rollup({ ...reviewStylexOptions, dev: false })],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
  },
});
