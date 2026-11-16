import { generateKeyPairSync } from 'node:crypto';
import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { ContentError, inspectContentFrame } from '@lody/e2ee-core/protocol';
import {
  LEDGER_LOOKAHEAD_EPOCHS,
  RECEIVE_KEY_COOLDOWN_MS,
  makeContentLedgerCatchUp,
  type ContentKeyPendingState,
} from './content-ledger-catch-up';

const updateContext = {
  protocol: 'loro-streams-crdt-payload-protection',
  version: 2,
  kind: 'update_batch',
} as const;

const validEd25519Pubkey = new Uint8Array(
  generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
);

function makeWireFrame(epoch: number) {
  // v0 content wire layout:
  // [0]: version=0, [1..4]: uint32 BE epoch, [5..6]: docEpoch=0,
  // [7..38]: 32-byte canonical Ed25519 pubkey, [39..62]: 24-byte nonce,
  // [63..78]: 16-byte AEAD tag/ciphertext, [79..142]: 64-byte signature.
  const buf = new Uint8Array(143);
  buf[0] = 0;
  new DataView(buf.buffer).setUint32(1, epoch, false);
  buf.set(validEd25519Pubkey, 7);
  buf.fill(0x22, 39, 63);
  buf.fill(0x33, 63, 79);
  buf.fill(0x44, 79, 143);
  return {
    context: updateContext,
    sealed: buf,
    header: new Uint8Array(),
    additionalData: new Uint8Array(),
  };
}

function classifyLag(
  currentEpoch: () => number,
  hasKey: (epoch: number) => boolean
): (epoch: number, unknownAuthority: boolean) => Promise<ContentKeyPendingState> {
  return async (epoch, unknownAuthority) => {
    const current = currentEpoch();
    if (
      epoch <= current + LEDGER_LOOKAHEAD_EPOCHS &&
      (epoch > current || (epoch === current && unknownAuthority))
    ) {
      return 'pending';
    }
    if (unknownAuthority || epoch > current) return false;
    return hasKey(epoch) ? 'installed' : 'pending';
  };
}

describe('CLI content ledger catch-up (skew-convex-slow parity)', () => {
  it('catches up bounded-lookahead epochs and unknown current-epoch authors via Effect.runPromise, then succeeds on retry', async () => {
    const sample = makeWireFrame(3);
    expect(inspectContentFrame(sample.sealed, 'doc-update')._tag).toBe('Success');

    let verifiedEpoch = 0;
    let deviceAdmitted = false;
    let targetEpochOnRefresh = 0;
    let catchUps = 0;

    const guard = makeContentLedgerCatchUp({
      isClosed: () => false,
      keyPending: classifyLag(
        () => verifiedEpoch,
        (e) => e <= verifiedEpoch
      ),
      catchUp: async () => {
        catchUps++;
        verifiedEpoch = targetEpochOnRefresh;
        deviceAdmitted = true;
      },
      cooldownMs: 0,
    });

    // 1. Newly admitted peer writes at epoch 0 before Convex ledger arrives (`unauthorized` via Effect.runPromise).
    const res0 = await guard.openWithCatchUp('loro', makeWireFrame(0), () =>
      Effect.runPromise(
        deviceAdmitted
          ? Effect.succeed('decrypted-epoch-0')
          : Effect.fail(new ContentError({ code: 'unauthorized' }))
      )
    );
    expect(res0).toBe('decrypted-epoch-0');
    expect(catchUps).toBe(1);

    // 2. Rotated peer writes at epoch 4 (at +4 lookahead boundary of verifiedEpoch=0) before ledger arrives.
    targetEpochOnRefresh = 4;
    const res4 = await guard.openWithCatchUp('loro', makeWireFrame(4), () =>
      Effect.runPromise(
        verifiedEpoch >= 4
          ? Effect.succeed('decrypted-epoch-4')
          : Effect.fail(new ContentError({ code: 'unauthorized' }))
      )
    );
    expect(res4).toBe('decrypted-epoch-4');
    expect(catchUps).toBe(2);
  });

  it('rejects far-future epochs (> current + 4) and non-authority errors without refreshing', async () => {
    let catchUps = 0;
    const guard = makeContentLedgerCatchUp({
      isClosed: () => false,
      keyPending: classifyLag(
        () => 1,
        () => true
      ),
      catchUp: async () => {
        catchUps++;
      },
      cooldownMs: 0,
    });

    // Epoch 6 is 5 ahead of verified epoch 1 -> rejected without network catch-up.
    await expect(
      guard.openWithCatchUp('loro', makeWireFrame(6), () =>
        Effect.runPromise(Effect.fail(new ContentError({ code: 'unauthorized' })))
      )
    ).rejects.toMatchObject({ code: 'unauthorized' });

    // Epoch 999_999 forged frame -> 0 catchUps.
    await expect(
      guard.openWithCatchUp('loro', makeWireFrame(999_999), () =>
        Effect.runPromise(Effect.fail(new ContentError({ code: 'unauthorized' })))
      )
    ).rejects.toMatchObject({ code: 'unauthorized' });

    // Signature/ciphertext corruption at current epoch -> 0 catchUps.
    await expect(
      guard.openWithCatchUp('loro', makeWireFrame(1), () =>
        Effect.runPromise(Effect.fail(new ContentError({ code: 'invalid-signature' })))
      )
    ).rejects.toMatchObject({ code: 'invalid-signature' });

    expect(catchUps).toBe(0);
  });

  it('spaces concurrent and rapid pending receptions to at most one refresh per 3s interval', async () => {
    vi.useFakeTimers();
    try {
      let caughtUp = false;
      const catchUp = vi.fn(async () => {});

      const guard = makeContentLedgerCatchUp({
        isClosed: () => false,
        keyPending: async () => 'pending',
        catchUp,
      });

      const attempt = () =>
        guard.openWithCatchUp('loro', makeWireFrame(1), async () => {
          if (!caughtUp) throw new ContentError({ code: 'missing-read-key' });
          return 'ok';
        });

      // First read triggers immediate catchUp #1, still missing key -> rejects.
      await expect(attempt()).rejects.toMatchObject({ code: 'missing-read-key' });
      expect(catchUp).toHaveBeenCalledTimes(1);

      // Three concurrent reads inside the 3s cooldown share a single spaced reception.
      const batch = [attempt(), attempt(), attempt()];
      await vi.advanceTimersByTimeAsync(RECEIVE_KEY_COOLDOWN_MS - 1);
      expect(catchUp).toHaveBeenCalledTimes(1);

      caughtUp = true;
      await vi.advanceTimersByTimeAsync(1);
      expect(await Promise.all(batch)).toEqual(['ok', 'ok', 'ok']);
      expect(catchUp).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries immediately without catchUp when key is already installed, and aborts wait on close', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let catchUps = 0;
      const guard = makeContentLedgerCatchUp({
        isClosed: () => false,
        keyPending: async () => (calls === 1 ? 'installed' : 'pending'),
        catchUp: async () => {
          catchUps++;
        },
      });

      // 1. Key installed between initial failure and keyPending check -> immediate retry, 0 catchUps.
      const res = await guard.openWithCatchUp('loro', makeWireFrame(0), async () => {
        if (++calls === 1) throw new ContentError({ code: 'missing-read-key' });
        return 'fast-retry';
      });
      expect(res).toBe('fast-retry');
      expect(catchUps).toBe(0);

      // 2. Prime cooldown, then start another pending read and close() mid-cooldown.
      await expect(
        guard.openWithCatchUp('loro', makeWireFrame(1), async () => {
          throw new ContentError({ code: 'missing-read-key' });
        })
      ).rejects.toMatchObject({ code: 'missing-read-key' });
      expect(catchUps).toBe(1);

      const waiting = guard.openWithCatchUp('loro', makeWireFrame(1), async () => {
        throw new ContentError({ code: 'missing-read-key' });
      });
      const expectedAbort = expect(waiting).rejects.toThrow('e2ee_closed');
      await vi.advanceTimersByTimeAsync(10);
      guard.close();
      await expectedAbort;
      expect(catchUps).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
