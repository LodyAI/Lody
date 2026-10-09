// Regression tests: verified views are immutable and never constructed from unverified state.
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { Ledger as RootLedger } from '@lody/e2ee-core';
import { Ledger, LedgerError } from '../src/ledger';
import { Bytes, extendLedger, verifyLedger } from '@lody/e2ee-core/effect';
import { signatureVerifierLayer } from '@lody/e2ee-core/effect/platform';
import { encodeSignedRecord } from '../src/ledger/schema';
import {
  HISTORY_PACKET_BYTES,
  append,
  commitEpochKey,
  ed25519,
  random,
  signGenesis,
  signJoin,
} from './ledger-fixtures';

async function code(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    if (error instanceof LedgerError) return error.code;
    throw error;
  }
  return 'accepted';
}

async function epochRecord(
  ledger: Ledger,
  anchor: Uint8Array,
  signer: Awaited<ReturnType<typeof ed25519>>
) {
  const n = ledger.state.epoch.number + 1;
  const p = ledger.prepare(
    {
      type: 'publishEpoch',
      epoch: n,
      commitment: await commitEpochKey(anchor, n, random(32)),
      previousEpochKey: random(HISTORY_PACKET_BYTES),
    },
    signer.publicKey
  );
  return encodeSignedRecord(p.bodyBytes, await signer.sign(p.signingBytes));
}

describe('verified view immutability', () => {
  it('SAFE: mutating inputs, outputs and proposals after verification does not change verified state', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const bob = await ed25519();
    const join = await signJoin(created.anchor, bob);
    const membershipId = random(16);
    const op = { type: 'admitMember' as const, membershipId, request: join };
    const proposal = created.ledger.prepare(op, owner.publicKey);
    membershipId.fill(0xaa); // mutate caller op after prepare
    const record = await created.ledger.finalize(proposal, await owner.sign(proposal.signingBytes));
    const input = [created.record, record];
    const verified = await Ledger.verify({ anchor: created.anchor, records: input });
    input[1]!.fill(0);
    record.fill(0);
    const s = verified.state as unknown as {
      members: Map<string, unknown>;
      devices: Map<string, unknown>;
    };
    s.members.clear();
    s.devices.clear();
    expect(verified.state.members.size).toBe(2);
    expect(verified.state.devices.size).toBe(2);
    expect(() => {
      (verified.state.epoch as { rotationRequired: boolean }).rotationRequired = true;
    }).toThrow();
    expect(verified.head).toEqual(verified.hashAt(1));
  });

  it('exposes no public constructor from unverified state', () => {
    expect((RootLedger as unknown as Record<string, unknown>).fromInternal).toBeUndefined();
  });

  it('keeps verified Ledger state unreachable at runtime', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const attacker = await ed25519();
    const ledger = created.ledger as unknown as Record<string | symbol, unknown>;
    expect(ledger.internal).toBeUndefined();
    expect(Object.getOwnPropertySymbols(created.ledger)).toEqual([]);
    expect(
      await code(
        created.ledger.extend([await epochRecord(created.ledger, created.anchor, attacker)])
      )
    ).toBe('unauthorized');
  });

  it('keeps Effect LedgerView state unreachable through prototype symbols', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const view = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* verifyLedger({
          anchor: yield* Effect.fromResult(Bytes.genesisHash(created.anchor)),
          records: [created.record],
        });
      }).pipe(Effect.provide(signatureVerifierLayer))
    );
    expect(Object.getOwnPropertySymbols(Object.getPrototypeOf(view) as object)).toEqual([]);
    expect(Object.getOwnPropertySymbols(view)).toEqual([]);
    void append;
    void extendLedger;
  });
});

import { prepareDeviceAdmission } from '@lody/e2ee-core/effect';
import { deviceSignerLayer } from '@lody/e2ee-core/effect/platform';
import { Layer } from 'effect';

describe('enrollment proof binding', () => {
  it('ignores extra grant keys, so a proof cannot be retargeted to another membership', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const bob = await ed25519();
    const bobM = random(16);
    const admitted = await append(created.ledger, owner, {
      type: 'admitMember',
      membershipId: bobM,
      request: await signJoin(created.anchor, bob),
    });
    const newDevice = await ed25519();
    const command = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* prepareDeviceAdmission({
          genesis: yield* Effect.fromResult(Bytes.genesisHash(created.anchor)),
          // Caller believes the proof targets the Owner's membership...
          membershipId: yield* Effect.fromResult(Bytes.membershipId(created.membershipId)),
          encryptionPublicKey: yield* Effect.fromResult(Bytes.encryptionPublicKey(newDevice.enc)),
          // ...but an extra runtime key (e.g. from parsed JSON) retargets it to Bob.
          grant: { kind: 'personal', targetMembershipId: bobM } as never,
        });
      }).pipe(
        Effect.provide(
          Layer.merge(
            deviceSignerLayer(
              Bytes.signingPublicKey(newDevice.publicKey).pipe((e) => {
                if (e._tag === 'Failure') throw new Error('key');
                return e.success;
              }),
              newDevice.sign
            ),
            signatureVerifierLayer
          )
        )
      )
    );
    const op = {
      type: 'admitDevice' as const,
      kind: 'personal' as const,
      signingPublicKey: newDevice.publicKey,
      encryptionPublicKey: newDevice.enc,
      possessionSignature: (
        command as { possessionSignature: { toBytes(): Uint8Array } }
      ).possessionSignature.toBytes(),
    };
    const sign = async (ledger: Ledger, who: typeof owner) => {
      const p = ledger.prepare(op, who.publicKey);
      return code(ledger.extend([encodeSignedRecord(p.bodyBytes, await who.sign(p.signingBytes))]));
    };
    expect(await sign(admitted.ledger, owner)).toBe('accepted');
    expect(await sign(admitted.ledger, bob)).toBe('bad-proof');
  });
});
