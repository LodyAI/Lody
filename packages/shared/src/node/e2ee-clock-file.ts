import { Clock, Effect } from 'effect';
import { openSync, fstatSync, closeSync, lstatSync, constants } from 'node:fs';
import { isAbsolute, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const unavailable = () => new Error('e2ee_test_clock_unavailable');

/** File-backed E2E Clock. Only timestamps change; sleep/ownership timers retain
 * the original clock. File replacement, clock rollback and unsafe custody fail. */
export function makeFileE2eeClock(file: string, base: Clock.Clock): Clock.Clock {
  const uid = process.getuid?.();
  if (!isAbsolute(file) || uid === undefined) throw unavailable();
  let identity: string | undefined;
  let last = -1;
  const read = () => {
    let fd: number | undefined;
    try {
      const parent = lstatSync(dirname(file));
      if (!parent.isDirectory() || parent.uid !== uid || parent.mode & 0o077) throw unavailable();
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      const id = `${info.dev}:${info.ino}`;
      const value = Math.round(info.mtimeMs);
      if (
        !info.isFile() ||
        info.uid !== uid ||
        info.mode & 0o077 ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value < last ||
        (identity && identity !== id)
      )
        throw unavailable();
      identity ??= id;
      last = value;
      return value;
    } catch {
      throw unavailable();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  const initial = read();
  const monotonic = base.monotonicTimeNanosUnsafe();
  const mono = () => monotonic + BigInt(read() - initial) * 1_000_000n;
  const nanos = () => BigInt(read()) * 1_000_000n;
  return {
    currentTimeMillisUnsafe: read,
    currentTimeMillis: Effect.sync(read),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: mono,
    monotonicTimeNanos: Effect.sync(mono),
    sleep: (duration) => base.sleep(duration),
  };
}

let retained: { file: string; clock: Clock.Clock } | undefined;

/** One clock domain for this E2E process; changing the binding cannot reset a
 * persisted grace budget. The inspector is read-only and never initializes it. */
export function e2eeTestClock(base: Clock.Clock): Clock.Clock {
  const file = process.env.LODY_E2E_CLOCK_FILE;
  if (process.env.LODY_E2E !== '1' || !file) throw unavailable();
  if (retained) {
    if (retained.file !== file) throw unavailable();
    return retained.clock;
  }
  const clock = makeFileE2eeClock(file, base);
  const instance = randomUUID();
  Object.defineProperty(globalThis, Symbol.for('lody.e2ee.test-clock'), {
    configurable: false,
    writable: false,
    value: Object.freeze({
      read: () => ({
        version: 1,
        pid: process.pid,
        instance,
        wallMillis: clock.currentTimeMillisUnsafe(),
        monotonicNanos: clock.monotonicTimeNanosUnsafe().toString(),
      }),
    }),
  });
  retained = { file, clock };
  return clock;
}
