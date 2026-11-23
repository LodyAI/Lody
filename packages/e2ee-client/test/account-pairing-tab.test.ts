import { Effect, Exit, Fiber } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeAccountPairingTabOwnership,
  withAccountPairingTabOwnership,
} from '../src/account-pairing-browser';

// One injected manager represents one origin; each ownership represents a tab.
// Only exclusive requests are needed here. Queue ordinary requests FIFO, call
// ifAvailable with null while occupied, and retain ownership until callback settlement.
function lockManager(): LockManager {
  const queues = new Map<string, (() => void)[]>();
  const request = <T>(
    name: string,
    options: LockOptions,
    callback: (lock: Lock | null) => T | PromiseLike<T>
  ): Promise<T> => {
    if (options.mode && options.mode !== 'exclusive')
      return Promise.reject(new Error('test manager supports exclusive locks only'));
    if (options.steal || options.signal)
      return Promise.reject(new Error('unsupported test lock option'));
    if (queues.has(name) && options.ifAvailable)
      return Promise.resolve().then(() => callback(null));
    return new Promise<T>((resolve, reject) => {
      const queue = queues.get(name) ?? [];
      queues.set(name, queue);
      const start = () => {
        const release = () => {
          queue.shift();
          if (queue.length) queue[0]!();
          else queues.delete(name);
        };
        void Promise.resolve()
          .then(() => callback({ name, mode: 'exclusive' }))
          .then(
            (value) => {
              release();
              resolve(value);
            },
            (error) => {
              release();
              reject(error);
            }
          );
      };
      queue.push(start);
      if (queue.length === 1) start();
    });
  };
  return { request } as LockManager;
}

afterEach(() => vi.unstubAllGlobals());

describe('injected exclusive Lock Manager', () => {
  it.each(['resolve', 'reject'] as const)(
    'retains a pending callback and releases FIFO after %s',
    async (outcome) => {
      const locks = lockManager();
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => (finish = resolve));
      const events: string[] = [];
      const failure = new Error('callback failed');
      const first = locks.request('account', { mode: 'exclusive' }, async (lock) => {
        expect(lock).toMatchObject({ name: 'account', mode: 'exclusive' });
        events.push('first');
        await gate;
        if (outcome === 'reject') throw failure;
        return 'first value';
      });
      const result = first.catch((error: unknown) => error);
      const second = locks.request('account', {}, () => {
        events.push('second');
      });
      const third = locks.request('account', {}, () => {
        events.push('third');
      });
      expect(await locks.request('account', { ifAvailable: true }, (lock) => lock)).toBeNull();
      expect(events).toEqual(['first']);
      // Other names remain usable; an unavailable request must not release the owner.
      expect(await locks.request('other', {}, (lock) => lock?.name)).toBe('other');
      expect(await locks.request('account', { ifAvailable: true }, (lock) => lock)).toBeNull();
      finish();
      expect(await result).toBe(outcome === 'reject' ? failure : 'first value');
      await Promise.all([second, third]);
      expect(events).toEqual(['first', 'second', 'third']);
      expect(await locks.request('account', { ifAvailable: true }, (lock) => lock?.name)).toBe(
        'account'
      );
    }
  );
});

describe('missing Web Locks', () => {
  it.each([undefined, {}, { locks: undefined }, { locks: {} }])(
    'refuses pairing with a typed unsupported failure for navigator=%j',
    async (navigator) => {
      vi.stubGlobal('navigator', navigator);
      const owner = makeAccountPairingTabOwnership({ name: 'unsupported' });
      let ran = false;
      const tab = withAccountPairingTabOwnership(
        { op: () => Effect.sync(() => (ran = true)) },
        owner
      );
      // flip catches typed failures only: a TypeError defect still fails this test.
      const error = await Effect.runPromise(Effect.flip(tab.op()));
      expect(error).toMatchObject({ code: 'unsupported', message: 'e2ee_unsupported' });
      expect(ran).toBe(false);
      await Effect.runPromise(owner.release());
    }
  );
});
describe('account pairing tab ownership', () => {
  it('lets one tab own the account pairing; others are told it runs elsewhere', async () => {
    const locks = lockManager();
    const name = `lody-e2ee-account-pairing:test-${crypto.randomUUID()}`;
    const first = makeAccountPairingTabOwnership({ name, locks });
    const second = makeAccountPairingTabOwnership({ name, locks });
    let calls = 0;
    const pairing = {
      requestAccountPairing: () => Effect.sync(() => ++calls),
      accountPairingCode: () => Effect.sync(() => ++calls),
    };
    const firstTab = withAccountPairingTabOwnership(pairing, first);
    const secondTab = withAccountPairingTabOwnership(pairing, second);
    expect(await Effect.runPromise(firstTab.requestAccountPairing())).toBe(1);
    const refused = await Effect.runPromiseExit(secondTab.requestAccountPairing());
    expect(Exit.isFailure(refused)).toBe(true);
    expect(JSON.stringify(refused)).toContain('pairing-elsewhere');
    expect(calls).toBe(1);
    // The owning tab keeps working; once it releases, another tab may take over.
    expect(await Effect.runPromise(firstTab.accountPairingCode())).toBe(2);
    await Effect.runPromise(first.release());
    expect(await Effect.runPromise(secondTab.requestAccountPairing())).toBe(3);
    await Effect.runPromise(second.release());
  });
});

describe('handing the account pairing to another tab', () => {
  it('waits for an operation already running in this tab before releasing the lock', async () => {
    const locks = lockManager();
    const name = `lody-e2ee-account-pairing:test-${crypto.randomUUID()}`;
    const a = makeAccountPairingTabOwnership({ name, locks });
    const b = makeAccountPairingTabOwnership({ name, locks });
    const events: string[] = [];
    // Tab A's signing step blocks on an explicit gate.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const tabA = withAccountPairingTabOwnership(
      {
        approveAccountPairing: () =>
          Effect.promise(async () => {
            events.push('a:start');
            entered();
            await gate;
            events.push('a:done');
          }),
      },
      a
    );
    const tabB = withAccountPairingTabOwnership(
      { approveAccountPairing: () => Effect.sync(() => void events.push('b:start')) },
      b
    );
    const running = Effect.runPromise(tabA.approveAccountPairing());
    await started;
    const released = Effect.runPromise(a.release());
    // While A is still inside its operation, B is refused and never starts.
    const early = await Effect.runPromiseExit(tabB.approveAccountPairing());
    expect(Exit.isFailure(early)).toBe(true);
    // Released tab A takes no new operations.
    const refusedA = await Effect.runPromiseExit(tabA.approveAccountPairing());
    expect(Exit.isFailure(refusedA)).toBe(true);
    open();
    await running;
    await released;
    await Effect.runPromise(tabB.approveAccountPairing());
    expect(events).toEqual(['a:start', 'a:done', 'b:start']);
    await Effect.runPromise(b.release());
  });
});

describe('releasing while a claim or another release is in flight', () => {
  it('settles a claim still waiting for its lock callback before releasing, so no tab is stuck', async () => {
    const locks = lockManager();
    const name = `lody-e2ee-account-pairing:test-${crypto.randomUUID()}`;
    // Tab A's injected lock callback is held until an explicit signal.
    let deliver!: () => void;
    const callbackGate = new Promise<void>((resolve) => (deliver = resolve));
    const delayed = {
      request: (lockName: string, options: LockOptions, callback: (lock: Lock | null) => unknown) =>
        locks.request(lockName, options, async (lock) => {
          await callbackGate;
          return callback(lock);
        }),
    } as unknown as LockManager;
    const a = makeAccountPairingTabOwnership({ name, locks: delayed });
    const b = makeAccountPairingTabOwnership({ name, locks });
    const tabA = withAccountPairingTabOwnership({ op: () => Effect.succeed('a') }, a);
    // The lock request is issued, but its callback has not run yet.
    const pending = Effect.runPromiseExit(tabA.op());
    const released = Effect.runPromise(a.release());
    deliver();
    await released;
    await pending;
    // The lock is free again: another tab can pair.
    const tabB = withAccountPairingTabOwnership({ op: () => Effect.succeed('b') }, b);
    expect(await Effect.runPromise(tabB.op())).toBe('b');
    await Effect.runPromise(b.release());
  });

  it('lets concurrent releases share one handover', async () => {
    const locks = lockManager();
    const name = `lody-e2ee-account-pairing:test-${crypto.randomUUID()}`;
    const a = makeAccountPairingTabOwnership({ name, locks });
    const b = makeAccountPairingTabOwnership({ name, locks });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const tabA = withAccountPairingTabOwnership(
      {
        op: () =>
          Effect.promise(async () => {
            entered();
            await gate;
          }),
      },
      a
    );
    const running = Effect.runPromise(tabA.op());
    await started;
    const first = Effect.runPromise(a.release());
    const second = Effect.runPromise(a.release());
    open();
    await running;
    await Promise.all([first, second]);
    const tabB = withAccountPairingTabOwnership({ op: () => Effect.succeed('b') }, b);
    expect(await Effect.runPromise(tabB.op())).toBe('b');
    await Effect.runPromise(b.release());
  });
});

describe('an interrupted claim', () => {
  it('keeps the running count balanced when its caller is interrupted before the lock callback runs', async () => {
    const locks = lockManager();
    const name = `lody-e2ee-account-pairing:test-${crypto.randomUUID()}`;
    let deliver!: () => void;
    const callbackGate = new Promise<void>((resolve) => (deliver = resolve));
    let requested!: () => void;
    let callbackDone!: () => void;
    const callbackFinished = new Promise<void>((resolve) => (callbackDone = resolve));
    const lockRequested = new Promise<void>((resolve) => (requested = resolve));
    const delayed = {
      request: (
        lockName: string,
        options: LockOptions,
        callback: (lock: Lock | null) => unknown
      ) => {
        const result = locks.request(lockName, options, async (lock) => {
          await callbackGate;
          const held = callback(lock);
          callbackDone();
          return held;
        });
        requested();
        return result;
      },
    } as unknown as LockManager;
    const a = makeAccountPairingTabOwnership({ name, locks: delayed });
    const b = makeAccountPairingTabOwnership({ name, locks });
    let ran = false;
    const tabA = withAccountPairingTabOwnership(
      { op: () => Effect.sync(() => void (ran = true)) },
      a
    );
    // The caller gives up while its claim still waits for the lock callback.
    const fiber = Effect.runFork(tabA.op());
    await lockRequested;
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
    deliver();
    await interrupted;
    // The lock callback has completed and every queued continuation has run
    // (a macrotask boundary), before any release starts.
    await callbackFinished;
    await new Promise<void>((resolve) => setImmediate(resolve));
    // A later release completes, and another tab can pair.
    await Effect.runPromise(a.release());
    const tabB = withAccountPairingTabOwnership({ op: () => Effect.succeed('b') }, b);
    expect(await Effect.runPromise(tabB.op())).toBe('b');
    expect(ran).toBe(false);
    await Effect.runPromise(b.release());
  });
});
