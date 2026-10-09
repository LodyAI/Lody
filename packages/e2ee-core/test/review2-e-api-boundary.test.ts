// R2-E: public API surface, Promise/Effect parity, snapshot import corners, persisted trust.
import { Effect, Result, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  Ledger,
  LedgerClient,
  LedgerError,
  MemoryLedgerStore,
  MemoryLedgerStream,
} from '@lody/e2ee-core/ledger';
import { Bytes, SignatureVerifier, verifyLedger } from '@lody/e2ee-core/effect';
import { signatureVerifierLayer } from '@lody/e2ee-core/effect/platform';
import { deviceMayWriteDocument } from '@lody/e2ee-core/streams-content';
import { decodeSnapshotCbor, encodeSnapshotCbor } from '../src/ledger/cbor';
import { headAttestationSigningBytes, snapshotSigningBytes } from '../src/ledger/crypto';
import { encodeSignedRecord } from '../src/ledger/schema';
import { encodeSignedSnapshot } from '../src/ledger/snapshot';
import type { Operation } from '../src/ledger/schema';
import {
  HISTORY_PACKET_BYTES,
  admitDeviceOp,
  append,
  commitEpochKey,
  ed25519,
  hex,
  random,
  signGenesis,
  signJoin,
  type DeviceKeys,
} from './ledger-fixtures';

type L = Awaited<ReturnType<typeof Ledger.verify>>;

async function code(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    if (error instanceof LedgerError) return error.code;
    throw error;
  }
  return 'accepted';
}

async function org() {
  const owner = await ed25519();
  const created = await signGenesis(owner);
  let ledger: L = created.ledger;
  const records = [created.record];
  const push = async (signer: DeviceKeys, op: Operation) => {
    const next = await append(ledger, signer, op);
    ledger = next.ledger;
    records.push(next.record);
  };
  const admit = async () => {
    const device = await ed25519();
    const membershipId = random(16);
    await push(owner, {
      type: 'admitMember',
      membershipId,
      request: await signJoin(created.anchor, device),
    });
    return { device, membershipId };
  };
  return {
    owner,
    created,
    records,
    push,
    admit,
    get ledger() {
      return ledger;
    },
  };
}

const cmp = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
};

/** Re-sign an edited snapshot body as `signer` for the given (genesis, head). */
async function signBody(body: unknown[], signer: DeviceKeys) {
  body[4] = signer.publicKey;
  const bytes = encodeSnapshotCbor(body as never);
  const snapshot = encodeSignedSnapshot(bytes, await signer.sign(snapshotSigningBytes(bytes)));
  const genesis = body[1] as Uint8Array;
  const head = body[3] as Uint8Array;
  return {
    snapshot,
    trust: {
      genesis,
      endorser: signer.publicKey,
      head,
      headSignature: await signer.sign(headAttestationSigningBytes(genesis, head)),
    },
  };
}

describe('R2-E Promise vs Effect verifier trust', () => {
  it('BUG (parity): Effect verifyLedger accepts unsigned records under any caller-supplied SignatureVerifier', async () => {
    const o = await org();
    // A record claimed by the Owner, never signed by the Owner.
    const proposal = o.ledger.prepare(
      {
        type: 'publishEpoch',
        epoch: 1,
        commitment: await commitEpochKey(o.created.anchor, 1, random(32)),
        previousEpochKey: random(HISTORY_PACKET_BYTES),
      },
      o.owner.publicKey
    );
    const forged = encodeSignedRecord(proposal.bodyBytes, new Uint8Array(64));
    const records = [o.created.record, forged];

    // Promise: default rejects; a caller-built executor is refused outright.
    expect(await code(Ledger.verify({ anchor: o.created.anchor, records }))).toBe('bad-signature');
    const yes = { verify: async (jobs: readonly unknown[]) => jobs.map(() => true) };
    expect(
      await code(Ledger.verify({ anchor: o.created.anchor, records, executor: yes as never }))
    ).toBe('invalid-operation');

    // Effect with the real verifier rejects.
    const run = (layer: Layer.Layer<SignatureVerifier>) =>
      Effect.runPromise(
        Effect.result(
          Effect.gen(function* () {
            return yield* verifyLedger({
              anchor: yield* Effect.fromResult(Bytes.genesisHash(o.created.anchor)),
              records,
            });
          })
        ).pipe(Effect.provide(layer))
      );
    const real = await run(signatureVerifierLayer);
    expect(Result.isFailure(real) && real.failure.code).toBe('bad-signature');

    // Effect with a permissive verifier yields a LedgerView at epoch 1 (the Promise guard has no analogue).
    const permissive = Layer.succeed(
      SignatureVerifier,
      SignatureVerifier.of({ verify: () => Effect.void, verifyMany: () => Effect.void })
    );
    const forgedView = await run(permissive);
    const epoch = Result.isSuccess(forgedView)
      ? forgedView.success.inspectState().epoch.number
      : -1;
    expect(epoch, 'Effect must not build a verified view without real signature checks').toBe(-1);
  });
});

describe('R2-E snapshot import of impossible states', () => {
  it('BUG (hardening): an Admin-endorsed snapshot where the Owner has no personal device or R is imported', async () => {
    const o = await org();
    const bob = await o.admit();
    await o.push(o.owner, { type: 'setRole', membershipId: bob.membershipId, role: 'admin' });
    const honest = o.ledger.prepareSnapshot(bob.device.publicKey);
    const body = decodeSnapshotCbor(honest.bodyBytes) as unknown[];
    const auth = body[5] as unknown[];
    // Drop the Owner's only device; the replay rule (2026-09-26) makes this state unreachable.
    auth[2] = (auth[2] as unknown[][]).filter(
      (row) => hex(row[0] as Uint8Array) !== hex(o.owner.publicKey)
    );
    const forged = await signBody(body, bob.device);
    const joined = await code(Ledger.verifySnapshot(forged));
    expect(joined, 'Owner without a governing device is not a reachable state').not.toBe(
      'accepted'
    );
  });
});

describe('R2-E persisted snapshot trust', () => {
  it('BUG (hardening): restore re-reads endorser trust from the unauthenticated journal and accepts a substituted endorser', async () => {
    const o = await org();
    const bob = await o.admit();
    await o.push(o.owner, { type: 'setRole', membershipId: bob.membershipId, role: 'admin' });
    const stream = new MemoryLedgerStream();
    stream.records = [...o.records];

    // Honest join from Bob's out-of-band endorsement.
    const honest = o.ledger.prepareSnapshot(bob.device.publicKey);
    const honestSigned = await signBody(
      decodeSnapshotCbor(honest.bodyBytes) as unknown[],
      bob.device
    );
    const store = new MemoryLedgerStore();
    const joined = await LedgerClient.openFromSnapshot({ ...honestSigned, store, stream });
    await joined.read();
    const saved = store.journal!;

    // Attacker with write access to the plain journal (not OS-wrapped): a key never in the Org
    // relabels the Owner's device row as itself and self-endorses the real (genesis, head).
    const mallory = await ed25519();
    const body = decodeSnapshotCbor(honest.bodyBytes) as unknown[];
    const auth = body[5] as unknown[];
    const devices = auth[2] as unknown[][];
    for (const row of devices)
      if (hex(row[0] as Uint8Array) === hex(o.owner.publicKey)) row[0] = mallory.publicKey;
    devices.sort((a, b) => cmp(a[0] as Uint8Array, b[0] as Uint8Array));
    const used = (auth[6] as Uint8Array[]).map((k) =>
      hex(k) === hex(o.owner.publicKey) ? mallory.publicKey : k
    );
    auth[6] = used.sort(cmp);
    const forged = await signBody(body, mallory);
    store.journal = {
      genesis: saved.genesis,
      records: [],
      pending: null,
      offset: stream.initialOffset,
      snapshot: forged.snapshot,
      snapshotTrust: forged.trust,
    };

    const reopened = await LedgerClient.openJournal(o.created.anchor, store, stream);
    const result = await reopened.read().then(
      (ledger) => ledger.state,
      (error: unknown) => error
    );
    const malloryRole =
      result instanceof Error
        ? 'rejected'
        : (() => {
            const device = (result as L['state']).devices.get(hex(mallory.publicKey));
            return device
              ? (result as L['state']).members.get(hex(device.membershipId))?.role
              : 'absent';
          })();
    expect(malloryRole, 'restore must not trust an endorser that only the journal names').not.toBe(
      'owner'
    );
  });
});

describe('R2-E ledger policy corners', () => {
  it('SAFE: demoted user keeps a machine that can neither write nor manage; transfer to a Guest follows spec', async () => {
    const o = await org();
    const bob = await o.admit();
    await o.push(o.owner, { type: 'setRole', membershipId: bob.membershipId, role: 'admin' });
    const machine = await ed25519();
    await o.push(
      bob.device,
      await admitDeviceOp(o.created.anchor, bob.membershipId, machine, 'machine')
    );
    expect(deviceMayWriteDocument(o.ledger.state, hex(machine.publicKey))).toBe(true);
    await o.push(o.owner, { type: 'setRole', membershipId: bob.membershipId, role: 'guest' });
    // §8.6: the machine stays registered, but a Guest's devices cannot write.
    expect(o.ledger.state.devices.has(hex(machine.publicKey))).toBe(true);
    expect(deviceMayWriteDocument(o.ledger.state, hex(machine.publicKey))).toBe(false);
    const epochOp = async (): Promise<Operation> => ({
      type: 'publishEpoch',
      epoch: o.ledger.state.epoch.number + 1,
      commitment: await commitEpochKey(
        o.created.anchor,
        o.ledger.state.epoch.number + 1,
        random(32)
      ),
      previousEpochKey: random(HISTORY_PACKET_BYTES),
    });
    for (const signer of [machine, bob.device])
      expect(await code(append(o.ledger, signer, await epochOp()))).toBe('unauthorized');
    // A Guest cannot register a new machine either.
    expect(
      await code(
        append(
          o.ledger,
          bob.device,
          await admitDeviceOp(o.created.anchor, bob.membershipId, await ed25519(), 'machine')
        )
      )
    ).toBe('unauthorized');
    // transferOwner only requires a current member with a personal device or R (§8.2.2).
    await o.push(o.owner, { type: 'transferOwner', successorMembershipId: bob.membershipId });
    expect(hex(o.ledger.state.owner)).toBe(hex(bob.membershipId));
    expect(deviceMayWriteDocument(o.ledger.state, hex(machine.publicKey))).toBe(true);
    await o.push(bob.device, await epochOp());
  });
});
