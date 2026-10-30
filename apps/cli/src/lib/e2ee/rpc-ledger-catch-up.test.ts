import { describe, expect, it } from 'vitest';
import { Effect, Exit } from 'effect';
import { ContentError } from '@lody/e2ee-core/protocol';
import { encryptedRpcFixture } from '../../../../../packages/loro-streams-rpc/tests/fixtures/e2ee-native-fixture';
import { openDispatchAfterLedgerCatchUp } from './rpc-ledger-catch-up';

// The host has verified epoch `local`; the frame was sealed at `sealed`. Opening
// succeeds only once the host has caught up, exactly like the core epoch guard.
function host(options: { local: number; sealed: number; catchUpTo?: number }) {
  let local = options.local;
  let opens = 0;
  let catchUps = 0;
  const open = (_machineId: string, _frameHex: string) =>
    Effect.suspend(() => {
      opens++;
      return options.sealed === local
        ? Effect.succeed({ epoch: local })
        : Effect.fail(new ContentError({ code: 'unauthorized' }));
    });
  const opener = openDispatchAfterLedgerCatchUp({
    open,
    currentEpoch: () => Effect.sync(() => local),
    catchUp: async () => {
      catchUps++;
      if (options.catchUpTo !== undefined) local = options.catchUpTo;
    },
    frameEpoch: () => options.sealed,
  });
  return { opener, opens: () => opens, catchUps: () => catchUps };
}

describe('dispatch open after an epoch rotation', () => {
  it('catches up the verified ledger once and reopens a frame sealed at a newer epoch', async () => {
    const h = host({ local: 0, sealed: 1, catchUpTo: 1 });
    expect(await Effect.runPromise(h.opener('machine', 'frame'))).toEqual({ epoch: 1 });
    expect(h.catchUps()).toBe(1);
    expect(h.opens()).toBe(2);
  });

  it('keeps the guard rejection when catch-up does not reach the frame epoch', async () => {
    const h = host({ local: 0, sealed: 1 });
    const exit = await Effect.runPromiseExit(h.opener('machine', 'frame'));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(h.catchUps()).toBe(1);
    expect(h.opens()).toBe(2);
  });

  it('never refreshes for a frame at or below the verified epoch', async () => {
    const h = host({ local: 1, sealed: 0 });
    const exit = await Effect.runPromiseExit(h.opener('machine', 'frame'));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(h.catchUps()).toBe(0);
    expect(h.opens()).toBe(1);
  });

  it('reads the declared epoch from a real sealed dispatch frame', async () => {
    const f = encryptedRpcFixture();
    try {
      const original = await Effect.runPromise(f.sender.prepareDispatch(f.machineId, f.input));
      let catchUps = 0;
      const opener = openDispatchAfterLedgerCatchUp({
        open: () => Effect.fail(new ContentError({ code: 'unauthorized' })),
        currentEpoch: () => Effect.succeed(0),
        catchUp: async () => {
          catchUps++;
        },
      });
      // Sealed at the verified epoch 0: an ordinary rejection, no refresh.
      expect(
        Exit.isFailure(await Effect.runPromiseExit(opener(f.machineId, original.frameHex)))
      ).toBe(true);
      expect(catchUps).toBe(0);
    } finally {
      f.close();
    }
  });
});
