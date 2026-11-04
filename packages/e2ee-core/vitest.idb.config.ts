import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/indexeddb.browser.test.ts'],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 180_000,
  },
});
