import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import topLevelAwait from 'vite-plugin-top-level-await';
import wasm from 'vite-plugin-wasm';

const e2e = process.env.LODY_E2E === '1';
const unitPatterns = ['src/__tests__/**/*.ts', 'src/**/*.{test,spec}.ts', 'tests/**/*.test.ts'];
// These suites deliberately change process/module state that cannot be undone by
// restoring spies and environment variables. Keep the perf entry isolated too.
const isolatedFiles = new Set([
  // Factory registration and live Flock timers outlive their importing module.
  'src/session/session-backend.test.ts',
  'tests/streams-relay-authorship.repro.test.ts',
  'tests/cli-streams-replica-checkpoints.test.ts',
  'src/lib/loro/presence.test.ts',
  // These suites replace process.env itself; Vitest retains the original object
  // for vi.stubEnv, so subsequent files must start with fresh worker state.
  'src/lib/auth.test.ts',
  'src/mcp/daemon-session-tools.test.ts',
  'tests/cli-platform.test.ts',
  'tests/local-platform-zero-cloud.test.ts',
  'tests/loro-doc-unload-data-plane-integration.test.ts',
  // Draining all fake timers must not execute another suite's retained background timers.
  'tests/session-dispatch-watcher.test.ts',
  'tests/local-loro-data-plane-bug-repro.test.ts',
]);
// Global timer-count assertions need their own native timer context.
const isolatedState =
  /\b(?:vi|vitest)\s*\.\s*(?:mock|doMock|unmock|doUnmock|resetModules|hoisted|getTimerCount)\b/;
const files = e2e
  ? []
  : [...globSync(unitPatterns, { cwd: __dirname, exclude: ['tests/**/*.e2e.test.ts'] })].sort();
const isolated = files.filter(
  (file) =>
    isolatedFiles.has(file) ||
    // Native Roost suites patch constructor prototypes and install backend factories.
    // Reusing their module graph retains methods captured while spies were active.
    file.startsWith('tests/roost-session-backend-contract') ||
    isolatedState.test(readFileSync(path.join(__dirname, file), 'utf8'))
);
const shared = files.filter((file) => !isolated.includes(file));

export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  resolve: {
    alias: {
      // Mirror vite.config.ts: the analytics poster imports package.json via `@/pkg`.
      '@/pkg': path.resolve(__dirname, 'package.json'),
      '@': path.resolve(__dirname, 'src'),
      src: path.resolve(__dirname, 'src'),
    },
  },
  test: {
    fsModuleCache: true,
    ...(e2e
      ? { include: ['tests/**/*.e2e.test.ts'], setupFiles: [] }
      : {
          projects: [
            {
              test: {
                name: 'shared modules',
                include: shared,
                isolate: false,
                setupFiles: ['tests/vitest-setup.ts', 'tests/vitest-shared-setup.ts'],
              },
            },
            {
              test: {
                name: 'isolated modules',
                include: isolated,
                isolate: true,
                setupFiles: ['tests/vitest-setup.ts'],
              },
            },
          ],
        }),
    // Passing tests intentionally exercise noisy runtime paths. Preserve their
    // output on failure without streaming it during every successful run.
    silent: 'passed-only',
    server: {
      deps: {
        inline: ['@effect/vitest', 'loro-mirror', '@loro-dev/flock-wasm'],
      },
    },
    execArgv: ['--experimental-wasm-modules'],
    environment: 'node',
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/*.test.ts', 'src/**/*.spec.ts', 'src/index.ts'],
    },
  },
});
