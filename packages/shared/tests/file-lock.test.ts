import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withFileLock } from '../src/node/file-lock';

describe('withFileLock', () => {
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
    const first = withFileLock(
      'alpha',
      async () => {
        order.push('first:start');
        await gate;
        order.push('first:end');
      },
      options
    );
    const second = withFileLock(
      'alpha',
      async () => {
        order.push('second');
      },
      options
    );
    const third = withFileLock(
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
      withFileLock(
        'beta',
        async () => {
          ran = true;
        },
        { locksDir, timeout: 30, retryDelay: 5, maxRetryDelay: 10 }
      )
    ).rejects.toThrow('Failed to acquire lock "beta" within 30ms');
    expect(ran).toBe(false);
  });

  it('reclaims a lock whose owner process no longer exists', async () => {
    // No OS assigns the largest int32 pid, so the owner is provably gone.
    fs.writeFileSync(
      path.join(locksDir, 'epsilon.lock'),
      JSON.stringify({ pid: 2_147_483_647, timestamp: Date.now() })
    );

    let ran = false;
    await withFileLock(
      'epsilon',
      async () => {
        ran = true;
      },
      { locksDir, timeout: 30, retryDelay: 5, maxRetryDelay: 10 }
    );
    expect(ran).toBe(true);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'takes over a lock whose pid now belongs to another user',
    async () => {
      // pid 1 is root's; a non-root caller gets EPERM probing it. Our own lock
      // could only carry it if its owner died and the pid was reused.
      fs.writeFileSync(
        path.join(locksDir, 'zeta.lock'),
        JSON.stringify({ pid: 1, timestamp: Date.now() })
      );

      let ran = false;
      await withFileLock(
        'zeta',
        async () => {
          ran = true;
        },
        { locksDir, timeout: 30, retryDelay: 5, maxRetryDelay: 10 }
      );
      expect(ran).toBe(true);
    }
  );

  it('keeps a lock held by a live process of ours', async () => {
    fs.writeFileSync(
      path.join(locksDir, 'eta.lock'),
      JSON.stringify({ pid: process.pid, timestamp: Date.now() })
    );

    await expect(
      withFileLock('eta', async () => {}, {
        locksDir,
        timeout: 30,
        retryDelay: 5,
        maxRetryDelay: 10,
      })
    ).rejects.toThrow('Failed to acquire lock "eta" within 30ms');
  });

  it('fails fast on same-process reentrant acquisition of the same lock', async () => {
    const results: string[] = [];
    await expect(
      withFileLock(
        'gamma',
        async () => {
          await withFileLock(
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
    await withFileLock(
      'outer',
      async () => {
        order.push('outer');
        await withFileLock(
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
    const first = withFileLock(
      'delta',
      async () => {
        throw new Error('boom');
      },
      { locksDir }
    );
    const second = withFileLock(
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
