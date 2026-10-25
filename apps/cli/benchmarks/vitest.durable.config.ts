import { defineConfig } from 'vitest/config';
import cliConfig from '../vitest.config';

// Explicit opt-in: default CLI/CI include patterns exclude benchmarks/.
export default defineConfig({
  ...cliConfig,
  test: {
    ...cliConfig.test,
    include: [
      process.env.LONG_BENCH_DISPATCH === '1'
        ? 'benchmarks/roost-dispatch.test.ts'
        : 'benchmarks/roost-durable.test.ts',
    ],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
