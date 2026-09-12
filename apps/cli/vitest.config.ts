import path from 'node:path';
import { defineConfig } from 'vitest/config';
import topLevelAwait from 'vite-plugin-top-level-await';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  resolve: {
    alias: {
      // Mirror vite.config.ts: the analytics poster imports package.json via `@/pkg`.
      '@/pkg': path.resolve(__dirname, 'package.json'),
      '@': path.resolve(__dirname, 'src'),
      src: path.resolve(__dirname, 'src'),
    },
  },
  test: {
    clearMocks: false,
    execArgv: ['--experimental-wasm-modules'],
    include:
      process.env.LODY_E2E === '1'
        ? ['tests/**/*.e2e.test.ts']
        : ['src/__tests__/**/*.ts', 'src/**/*.{test,spec}.ts', 'tests/**/*.test.ts'],
    exclude: process.env.LODY_E2E === '1' ? [] : ['tests/**/*.e2e.test.ts'],
    // Passing tests intentionally exercise noisy runtime paths. Preserve their
    // output on failure without streaming it during every successful run.
    silent: 'passed-only',
    server: {
      deps: {
        inline: ['loro-mirror', '@loro-dev/flock-wasm'],
      },
    },
    environment: 'node',
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/*.test.ts', 'src/**/*.spec.ts', 'src/index.ts'],
    },
  },
});
