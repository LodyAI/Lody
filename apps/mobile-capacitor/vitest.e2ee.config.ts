import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['tests/e2ee/*.test.ts'], maxWorkers: 1, fileParallelism: false },
});
