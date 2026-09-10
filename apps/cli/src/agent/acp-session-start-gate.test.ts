import { afterEach, describe, expect, it, vi } from 'vitest';

import { ACP_STARTUP_QUEUE_WAIT_TIMEOUT_MS } from '@lody/shared/acp-startup-budget';

import {
  ACP_SESSION_START_GATE_ENV,
  AcpSessionStartGate,
  AcpSessionStartQueueTimeoutError,
  DEFAULT_MAX_CONCURRENT_ACP_SESSION_STARTS,
  __test__,
  getAcpSessionStartGate,
  resolveAcpSessionStartLimit,
  withAcpSessionStartSlot,
} from './acp-session-start-gate';

const deferred = <T = void>() => {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};

afterEach(() => {
  __test__.resetDefaultGate();
  delete process.env[ACP_SESSION_START_GATE_ENV];
});

describe('resolveAcpSessionStartLimit', () => {
  it('uses the explicit value when provided', () => {
    process.env[ACP_SESSION_START_GATE_ENV] = '9';
    expect(resolveAcpSessionStartLimit(3)).toBe(3);
  });

  it('reads a valid env override', () => {
    process.env[ACP_SESSION_START_GATE_ENV] = '4';
    expect(resolveAcpSessionStartLimit()).toBe(4);
  });

  it('falls back to the default for missing or invalid env values', () => {
    expect(resolveAcpSessionStartLimit()).toBe(DEFAULT_MAX_CONCURRENT_ACP_SESSION_STARTS);
    process.env[ACP_SESSION_START_GATE_ENV] = '0';
    expect(resolveAcpSessionStartLimit()).toBe(DEFAULT_MAX_CONCURRENT_ACP_SESSION_STARTS);
    process.env[ACP_SESSION_START_GATE_ENV] = 'nope';
    expect(resolveAcpSessionStartLimit()).toBe(DEFAULT_MAX_CONCURRENT_ACP_SESSION_STARTS);
  });
});

describe('AcpSessionStartGate', () => {
  it('runs at most maxConcurrent starts at once and drains the queue', async () => {
    const gate = new AcpSessionStartGate({ maxConcurrent: 2 });
    const first = deferred();
    const second = deferred();
    const started: string[] = [];
    const finished: string[] = [];

    const run = (label: string, blocker: ReturnType<typeof deferred>) =>
      gate.run({ label }, async () => {
        started.push(label);
        await blocker.promise;
        finished.push(label);
      });

    const a = run('a', first);
    const b = run('b', second);
    const cStarted = deferred();
    const c = gate.run({ label: 'c' }, async () => {
      started.push('c');
      cStarted.resolve();
    });

    await Promise.resolve();
    expect(started).toEqual(['a', 'b']);
    expect(gate.inUse).toBe(2);
    expect(gate.queued).toBe(1);

    first.resolve();
    await cStarted.promise;
    expect(started).toEqual(['a', 'b', 'c']);
    expect(finished).toEqual(['a']);

    second.resolve();
    await Promise.all([a, b, c]);
    expect(finished).toEqual(['a', 'b']);
    expect(gate.inUse).toBe(0);
    expect(gate.queued).toBe(0);
  });

  it('releases the slot when the start function throws', async () => {
    const gate = new AcpSessionStartGate({ maxConcurrent: 1 });
    await expect(
      gate.run({ label: 'fail' }, async () => {
        throw new Error('spawn failed');
      })
    ).rejects.toThrow('spawn failed');

    let ran = false;
    await gate.run({ label: 'retry' }, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(gate.inUse).toBe(0);
  });

  it('waits without a deadline unless a caller sets one', async () => {
    // A session restore wave is the contention this gate exists to serialize.
    // Failing its tail on a queue deadline would undo the reason for the queue,
    // so the bound belongs to callers whose wait sits inside an RPC budget.
    expect(new AcpSessionStartGate({ maxConcurrent: 1 }).waitTimeoutMs).toBeUndefined();
    expect(ACP_STARTUP_QUEUE_WAIT_TIMEOUT_MS).toBeGreaterThan(0);

    vi.useFakeTimers();
    try {
      const gate = new AcpSessionStartGate({ maxConcurrent: 1 });
      const holder = deferred();
      const held = gate.run({ label: 'holder' }, async () => {
        await holder.promise;
      });
      let ran = false;
      const queued = gate.run({ label: 'queued' }, async () => {
        ran = true;
      });

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(gate.queued).toBe(1);

      holder.resolve();
      await Promise.all([held, queued]);
      expect(ran).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on a start that never reaches the front of the queue', async () => {
    // A queued start emits no progress frame, so an unbounded wait is silence
    // the client eventually expires — reporting its own timeout instead of the
    // machine's reason. The machine has to own this deadline like every other.
    vi.useFakeTimers();
    try {
      const gate = new AcpSessionStartGate({ maxConcurrent: 1, waitTimeoutMs: 1_000 });
      const holder = deferred();
      const held = gate.run({ label: 'holder' }, async () => {
        await holder.promise;
      });

      const queued = gate.run({ label: 'queued' }, async () => {
        throw new Error('queued start should not run');
      });
      const queuedFailure = queued.then(
        () => {
          throw new Error('queued start should reject');
        },
        (error: unknown) => error
      );

      await Promise.resolve();
      expect(gate.queued).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);

      const error = await queuedFailure;
      expect(error).toBeInstanceOf(AcpSessionStartQueueTimeoutError);
      expect((error as Error).message).toContain('busy starting other agents');
      // The wait failing must not eat the slot it never got.
      expect(gate.queued).toBe(0);
      expect(gate.inUse).toBe(1);

      holder.resolve();
      await held;
      expect(gate.inUse).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a granted start alive past its queue deadline', async () => {
    // The deadline bounds the WAIT, not the work. A start that got its slot
    // must not be cancelled while the agent is initializing.
    vi.useFakeTimers();
    try {
      const gate = new AcpSessionStartGate({ maxConcurrent: 1, waitTimeoutMs: 1_000 });
      const holder = deferred();
      const held = gate.run({ label: 'holder' }, async () => {
        await holder.promise;
      });

      const work = deferred();
      let started = false;
      const queued = gate.run({ label: 'queued' }, async () => {
        started = true;
        await work.promise;
      });

      await Promise.resolve();
      holder.resolve();
      await held;
      await vi.advanceTimersByTimeAsync(0);
      expect(started).toBe(true);

      await vi.advanceTimersByTimeAsync(5_000);
      work.resolve();
      await expect(queued).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not consume a slot when a queued start is aborted', async () => {
    const gate = new AcpSessionStartGate({ maxConcurrent: 1 });
    const holder = deferred();
    const held = gate.run({ label: 'holder' }, async () => {
      await holder.promise;
    });

    const controller = new AbortController();
    const queued = gate.run({ label: 'queued', abortSignal: controller.signal }, async () => {
      throw new Error('queued start should not run');
    });
    const queuedFailure = queued.then(
      () => {
        throw new Error('queued start should reject');
      },
      (error: unknown) => error
    );

    await Promise.resolve();
    expect(gate.queued).toBe(1);
    controller.abort();

    const queuedError = await queuedFailure;
    expect(queuedError).toBeInstanceOf(DOMException);
    expect((queuedError as DOMException).name).toBe('AbortError');
    expect(gate.queued).toBe(0);

    let ran = false;
    const next = gate.run({ label: 'next' }, async () => {
      ran = true;
    });
    holder.resolve();
    await Promise.all([held, next]);
    expect(ran).toBe(true);
    expect(gate.inUse).toBe(0);
  });
});

describe('withAcpSessionStartSlot', () => {
  it('uses the process-wide default gate', async () => {
    const gate = new AcpSessionStartGate({ maxConcurrent: 1 });
    __test__.setDefaultGate(gate);
    expect(getAcpSessionStartGate()).toBe(gate);

    const holder = deferred();
    const first = withAcpSessionStartSlot({ label: 'first' }, async () => {
      await holder.promise;
    });
    await Promise.resolve();
    expect(gate.inUse).toBe(1);

    holder.resolve();
    await first;
    expect(gate.inUse).toBe(0);
  });
});
