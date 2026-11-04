import { build } from 'esbuild';
import { Effect } from 'effect';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
afterEach(() => vi.unstubAllEnvs());

it('removes the file adapter from production and cannot enable it through runtime env', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lody-clock-build-'));
  try {
    vi.stubEnv('LODY_E2E', '1');
    vi.stubEnv('LODY_E2E_CLOCK_FILE', join(directory, 'absent-clock'));
    for (const enabled of [false, true]) {
      const result = await build({
        entryPoints: [resolve(import.meta.dirname, '../../shared/src/node/e2ee-clock.ts')],
        bundle: true,
        format: 'esm',
        platform: 'node',
        write: false,
        define: { __LODY_E2E_CLOCK_BUILD__: String(enabled) },
        plugins: [
          {
            name: 'native-effect-reference',
            setup(builder) {
              builder.onResolve({ filter: /^effect$/ }, () => ({
                path: pathToFileURL(require.resolve('effect')).href,
                external: true,
              }));
            },
          },
        ],
      });
      const output = result.outputFiles[0];
      if (!output) throw new Error('missing_bundle');
      const file = join(directory, `${enabled}.mjs`);
      await writeFile(file, output.text, { mode: 0o600 });
      const { withE2eeTestClock } = await import(/* @vite-ignore */ pathToFileURL(file).href);
      if (enabled) {
        // Reverse build control: this graph retains the adapter and really opens the file.
        expect(output.text).toContain('LODY_E2E_CLOCK_FILE');
        await expect(Effect.runPromise(withE2eeTestClock(Effect.void))).rejects.toThrow(
          'e2ee_test_clock_unavailable'
        );
      } else {
        expect(output.text).not.toContain('LODY_E2E_CLOCK_FILE');
        expect(output.text).not.toContain('node:fs');
        expect(await Effect.runPromise(withE2eeTestClock(Effect.succeed('unchanged')))).toBe(
          'unchanged'
        );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
