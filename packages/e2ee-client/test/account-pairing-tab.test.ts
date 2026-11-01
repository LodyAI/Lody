import { Effect, Exit } from 'effect';
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
