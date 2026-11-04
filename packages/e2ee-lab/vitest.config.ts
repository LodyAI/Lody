import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Harness watchdog only: correctness uses explicit events, injected clocks
    // and observed native settlement. This is not a product/performance deadline.
    // Leave cleanup time after the inner 120s native/scenario watchdog.
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
