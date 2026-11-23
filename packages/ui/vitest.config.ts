import stylex from '@stylexjs/unplugin';
import { defineConfig } from 'vitest/config';
import { stylexOptions } from './stylex-options';

export default defineConfig({
  plugins: [stylex.rollup({ ...stylexOptions, dev: false })],
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'jsdom',
    // React 19 ships `act` only in its development build, and its entry picks
    // the build from `process.env.NODE_ENV`, which is `production` here because
    // the StyleX plugin compiles with `dev: false`. Without this every test that
    // drives a control — opening a popup, walking it with the keyboard — fails
    // with `act is not a function` rather than reporting what it asserts.
    env: { NODE_ENV: 'development' },
  },
});
