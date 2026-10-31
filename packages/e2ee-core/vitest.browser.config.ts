import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/browser-bundle.test.ts'],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 180_000,
  },
});
