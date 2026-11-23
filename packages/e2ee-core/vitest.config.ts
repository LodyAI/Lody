import { fileURLToPath } from 'node:url';
import { withFileIsolation } from '../../scripts/vitest-file-isolation.mjs';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: withFileIsolation(fileURLToPath(new URL('.', import.meta.url)), {
    // Harness watchdog only: correctness is decided by explicit signals and state,
    // never by how quickly real crypto, SQLite or an OS child finishes.
    // Leave cleanup time after the inner 120s native/scenario watchdog.
    exclude: [...configDefaults.exclude, 'test/browser-bundle.test.ts', 'test/*.browser.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 120_000,
  }),
});
