import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { maxWorkers: 1, fileParallelism: false } });
