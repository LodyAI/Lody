import { configDefaults, defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'test/*.browser.test.ts'],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
