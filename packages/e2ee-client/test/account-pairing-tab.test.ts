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
