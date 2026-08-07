import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withFileLock } from '../src/node/file-lock';

const require = createRequire(import.meta.url);
const withFileLockCjs = require('../src/node/file-lock.cjs').withFileLock as typeof withFileLock;

const implementations = [
  ['esm', withFileLock],
  ['cjs', withFileLockCjs],
] as const;

describe.each(implementations)('withFileLock (%s)', (_name, lock) => {
  let locksDir: string;

  beforeEach(() => {
    locksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-file-lock-'));
  });

  afterEach(() => {
    fs.rmSync(locksDir, { recursive: true, force: true });
  });

  it('serializes same-process callers in FIFO order and does not apply the acquire timeout to them', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    // timeout: 0 makes any same-process wait through the file lock fail
    // immediately, so passing here proves the waiters never contend on the
    // file lock while a same-process holder is active.
    const options = { locksDir, timeout: 0, retryDelay: 5, maxRetryDelay: 10 };
    const first = lock(
      'alpha',
      async () => {
        order.push('first:start');
        await gate;
        order.push('first:end');
      },
      options
    );
    const second = lock(
      'alpha',
      async () => {
        order.push('second');
      },
      options
    );
    const third = lock(
      'alpha',
      async () => {
        order.push('third');
      },
      options
    );

    releaseFirst();
    await Promise.all([first, second, third]);

    expect(order).toEqual(['first:start', 'first:end', 'second', 'third']);
  });

  it('rejects when another process holds the lock beyond the timeout', async () => {
    // A fresh lock file owned by a live pid is never stale, so acquisition
    // must keep failing until the timeout fires.
    fs.writeFileSync(
      path.join(locksDir, 'beta.lock'),
      JSON.stringify({ pid: process.pid, timestamp: Date.now() })
    );

    let ran = false;
    await expect(
      lock(
        'beta',
        async () => {
          ran = true;
        },
        { locksDir, timeout: 30, retryDelay: 5, maxRetryDelay: 10 }
      )
    ).rejects.toThrow('Failed to acquire lock "beta" within 30ms');
    expect(ran).toBe(false);
  });

  it('fails fast on same-process reentrant acquisition of the same lock', async () => {
    const results: string[] = [];
    await expect(
      lock(
        'gamma',
        async () => {
          await lock(
            'gamma',
            async () => {
              results.push('inner');
            },
            { locksDir }
          );
        },
        { locksDir }
      )
    ).rejects.toThrow(/not reentrant/);
    expect(results).toEqual([]);
  });

  it('allows nested acquisition of a different lock', async () => {
    const order: string[] = [];
    await lock(
      'outer',
      async () => {
        order.push('outer');
        await lock(
          'inner',
          async () => {
            order.push('inner');
          },
          { locksDir }
        );
      },
      { locksDir }
    );
    expect(order).toEqual(['outer', 'inner']);
  });

  it('propagates fn errors, releases the lock file, and keeps the queue moving', async () => {
    let secondRan = false;
    const first = lock(
      'delta',
      async () => {
        throw new Error('boom');
      },
      { locksDir }
    );
    const second = lock(
      'delta',
      async () => {
        secondRan = true;
      },
      { locksDir }
    );

    await expect(first).rejects.toThrow('boom');
    await second;

    expect(secondRan).toBe(true);
    expect(fs.existsSync(path.join(locksDir, 'delta.lock'))).toBe(false);
  });
});
