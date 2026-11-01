import { afterEach, describe, expect, it, vi } from 'vitest';
import { Clock, Effect } from 'effect';
import {
  chmodSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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
  it('advances wall and monotonic readings by the same exact interval without replacing sleep', () => {
    const f = fixture();
    let slept = false;
    const upstream: Clock.Clock = Object.create(base);
    upstream.sleep = () =>
      Effect.sync(() => {
        slept = true;
      });
    const clock = makeFileE2eeClock(f.file, upstream);
    const mono = clock.monotonicTimeNanosUnsafe();
    expect(clock.currentTimeMillisUnsafe()).toBe(start);
    for (const elapsed of [899_999, 900_000]) {
      f.advance(start + elapsed);
      expect(Effect.runSync(clock.currentTimeMillis)).toBe(start + elapsed);
      expect(Effect.runSync(clock.currentTimeNanos)).toBe(BigInt(start + elapsed) * 1_000_000n);
      expect(Effect.runSync(clock.monotonicTimeNanos) - mono).toBe(BigInt(elapsed) * 1_000_000n);
    }
    const duration = 0;
    // Sleep is delegated, never completed by advancing the file.
    expect(slept).toBe(false);
    Effect.runSync(clock.sleep(duration));
    expect(slept).toBe(true);
  });

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

  it('rejects relative and missing files without exposing their paths', () => {
    expect(() => makeFileE2eeClock('relative', base)).toThrow(/^e2ee_test_clock_unavailable$/);
    const f = fixture();
    rmSync(f.file);
    expect(() => makeFileE2eeClock(f.file, base)).toThrow(/^e2ee_test_clock_unavailable$/);
  });

  it('keeps one clock across native operations and exposes only passive acknowledgement', async () => {
    const f = fixture();
    vi.stubGlobal('__LODY_E2E_CLOCK_BUILD__', true);
    vi.stubEnv('LODY_E2E', '1');
    vi.stubEnv('LODY_E2E_CLOCK_FILE', f.file);
    const { withE2eeTestClock } = await import('../src/node/e2ee-clock');
    const first = await Effect.runPromise(withE2eeTestClock(Clock.Clock));
    const mono = first.monotonicTimeNanosUnsafe();
    f.advance(start + 900_000);
    const second = await Effect.runPromise(withE2eeTestClock(Clock.Clock));
    expect(second).toBe(first);
    expect(second.currentTimeMillisUnsafe()).toBe(start + 900_000);
    expect(second.monotonicTimeNanosUnsafe() - mono).toBe(900_000_000_000n);
    const inspector: unknown = Reflect.get(globalThis, Symbol.for('lody.e2ee.test-clock'));
    expect(inspector).toHaveProperty('read');
    expect(Object.keys(inspector as object)).toEqual(['read']);
    vi.stubEnv('LODY_E2E_CLOCK_FILE', fixture().file);
    await expect(Effect.runPromise(withE2eeTestClock(Clock.Clock))).rejects.toThrow(
      'e2ee_test_clock_unavailable'
    );
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
