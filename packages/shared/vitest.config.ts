import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    server: { deps: { inline: ['@effect/vitest'] } },
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // `local-project.test.ts` spawns real `git` subprocesses and each
    // case already takes 4–7s in isolation. Under repo-wide concurrent
    // vitest load these tests routinely exceed the 5s default. 30s
    // is generous enough to absorb the load-induced variance while still
    // surfacing real hangs.
    testTimeout: 30_000,
  },
});
