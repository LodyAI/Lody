import { afterEach, describe, expect, it, vi } from 'vitest';
import { Clock, Effect } from 'effect';
import { chmodSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeFileE2eeClock } from '../src/node/e2ee-clock-file';

const roots: string[] = [];
const start = 1_800_000_000_000;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lody-clock-'));
  roots.push(root);
  chmodSync(root, 0o700);
  const file = join(root, 'clock');
  writeFileSync(file, '', { mode: 0o600 });
  const advance = (ms: number) => utimesSync(file, ms / 1000, ms / 1000);
  advance(start);
  return { root, file, advance };
}
const base = Effect.runSync(Clock.Clock);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('E2EE file clock', () => {

  it.each([
    'rollback',
    'replacement',
    'symlink',
    'public-file',
    'public-directory',
    'missing',
  ] as const)('fails closed on %s instead of returning a fresh clock domain', (fault) => {
    const f = fixture();
    const clock = makeFileE2eeClock(f.file, base);
    if (fault === 'rollback') f.advance(start - 1);
    if (fault === 'replacement' || fault === 'symlink') {
      renameSync(f.file, join(f.root, 'old'));
      if (fault === 'replacement') writeFileSync(f.file, '', { mode: 0o600 });
      else symlinkSync(join(f.root, 'old'), f.file);
    }
    if (fault === 'public-file') chmodSync(f.file, 0o644);
    if (fault === 'public-directory') chmodSync(f.root, 0o755);
    if (fault === 'missing') rmSync(f.file);
    expect(() => clock.currentTimeMillisUnsafe()).toThrow('e2ee_test_clock_unavailable');
    expect(() => clock.monotonicTimeNanosUnsafe()).toThrow('e2ee_test_clock_unavailable');
  });

  it.each([
    { build: false, runtime: '1' },
    { build: true, runtime: '0' },
    { build: undefined, runtime: '1' },
  ])('requires both build and runtime gates: $build/$runtime', async ({ build, runtime }) => {
    vi.stubGlobal('__LODY_E2E_CLOCK_BUILD__', build);
    vi.stubEnv('LODY_E2E', runtime);
    vi.stubEnv('LODY_E2E_CLOCK_FILE', '/does-not-exist');
    const { withE2eeTestClock } = await import('../src/node/e2ee-clock');
    const clock = await Effect.runPromise(withE2eeTestClock(Effect.succeed(base)));
    expect(clock).toBe(base);
  });
});
