import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'tests/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
