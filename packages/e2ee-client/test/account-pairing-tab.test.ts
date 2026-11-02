import { Effect, Exit, Fiber } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  makeAccountPairingTabOwnership,
  withAccountPairingTabOwnership,
} from '../src/account-pairing-browser';

// Real Web Locks (Node implements `navigator.locks`); each ownership stands for one tab.
describe('account pairing tab ownership', () => {
  it('lets one tab own the account pairing; others are told it runs elsewhere', async () => {
    const name = `lody-e2ee-account-pairing:test-${crypto.randomUUID()}`;
    const first = makeAccountPairingTabOwnership({ name });
    const second = makeAccountPairingTabOwnership({ name });
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
    const name = `lody-e2ee-account-pairing:test-${crypto.randomUUID()}`;
    const a = makeAccountPairingTabOwnership({ name });
    const b = makeAccountPairingTabOwnership({ name });
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
    const name = `lody-e2ee-account-pairing:test-${crypto.randomUUID()}`;
    // Real Web Locks, with tab A's lock callback held until an explicit signal.
    let deliver!: () => void;
    const callbackGate = new Promise<void>((resolve) => (deliver = resolve));
    const delayed = {
      request: (lockName: string, options: LockOptions, callback: (lock: Lock | null) => unknown) =>
        navigator.locks.request(lockName, options, async (lock) => {
          await callbackGate;
          return callback(lock);
        }),
    } as unknown as LockManager;
    const a = makeAccountPairingTabOwnership({ name, locks: delayed });
    const b = makeAccountPairingTabOwnership({ name });
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
    const name = `lody-e2ee-account-pairing:test-${crypto.randomUUID()}`;
    const a = makeAccountPairingTabOwnership({ name });
    const b = makeAccountPairingTabOwnership({ name });
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
        const result = navigator.locks.request(lockName, options, async (lock) => {
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
    const b = makeAccountPairingTabOwnership({ name });
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
