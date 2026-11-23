import { fileURLToPath } from 'node:url';
import { withFileIsolation } from '../../scripts/vitest-file-isolation.mjs';
import { configDefaults, defineConfig } from 'vitest/config';
export default defineConfig({
  test: withFileIsolation(fileURLToPath(new URL('.', import.meta.url)), {
    exclude: [...configDefaults.exclude, 'test/*.browser.test.ts'],
    maxWorkers: 1,
    fileParallelism: false,
  }),
});
