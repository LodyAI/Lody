// Round-2 review (R2-A): bypass attempts against 4fc6de97 core fixes.
// Real Ed25519 signatures; each test asserts the secure/spec behaviour, so a failing
// test is a finding.
import { describe, expect, it } from 'vitest';
import { Effect, Result } from 'effect';
import { Ledger } from '../src/ledger';
import { Bytes, verifyLedger } from '@lody/e2ee-core/effect';
import { signatureVerifierLayer } from '@lody/e2ee-core/effect/platform';
import { contentAuthorKey } from '../src/streams-content';
import {
  HISTORY_PACKET_BYTES,
  admitDeviceOp,
  append,
  commitEpochKey,
  ed25519,
  findMembership,
  hex,
  random,
  signGenesis,
  signJoin,
} from './ledger-fixtures';

describe('R2-A1 contentAuthorKey for revoked devices', () => {
  it('BUG if fails: a revoked device cannot claim another member identity', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const carol = await ed25519();
    const join = await signJoin(created.anchor, carol);
    const carolMembership = random(16);
    let { ledger } = await append(created.ledger, owner, {
      type: 'admitMember',
      membershipId: carolMembership,
      request: join,
    });
    const spare = await ed25519();
    ({ ledger } = await append(
      ledger,
      carol,
      await admitDeviceOp(created.anchor, carolMembership, spare, 'personal')
    ));
    // Carol revokes her own spare device; no Owner involvement.
    ({ ledger } = await append(ledger, carol, { type: 'revokeDevice', target: spare.publicKey }));
    const state = ledger.state;
    const header = {
      genesis: hex(created.anchor),
      actor: hex(created.userId),
      memberInstance: hex(created.membershipId),
      device: hex(spare.publicKey),
    };
    const resolved = contentAuthorKey(state, header, (id) => ledger.wasDeviceAdmitted(id));
    // The ledger history knows the spare belonged to carol, not to the Owner.
    expect(Result.isFailure(resolved), 'revoked spare accepted as the Owner').toBe(true);
    void findMembership;
  });
});

describe('R2-A8 verified Ledger/LedgerView construction', () => {
  it('BUG if fails: the Ledger constructor cannot build a verified-looking Ledger from arbitrary state', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const attacker = await ed25519();
    const membership = hex(created.membershipId);
    const fake = {
      genesis: created.anchor,
      owner: created.membershipId,
      members: new Map([[membership, { userId: created.userId, role: 'owner' }]]),
      userIndex: new Map([[hex(created.userId), membership]]),
      devices: new Map([
        [
          hex(attacker.publicKey),
          {
            membershipId: created.membershipId,
            kind: 'personal',
            encryptionPublicKey: attacker.enc,
          },
        ],
      ]),
      epoch: { number: 0, keyCommitment: created.commitment, rotationRequired: false },
      usedSigningKeys: new Set([hex(attacker.publicKey)]),
      usedEncKeys: new Set<string>(),
      usedMembershipIds: new Set([membership]),
      closedJoins: new Set<string>(),
      usedCommitments: new Set<string>(),
      hashes: [created.anchor],
      origin: 'genesis',
      endorser: null,
      snapshotLength: null,
      historyPackets: new Map(),
    };
    let forged: Ledger | 'refused';
    try {
      // TypeScript `private constructor` is not a runtime boundary.
      forged = Reflect.construct(Ledger, [fake]) as Ledger;
    } catch {
      forged = 'refused';
    }
    if (forged !== 'refused') {
      // Same genesis and head as the genuine ledger; attacker key signs as Owner device.
      const next = await append(forged, attacker, {
        type: 'publishEpoch',
        epoch: 1,
        commitment: await commitEpochKey(created.anchor, 1, random(32)),
        previousEpochKey: random(HISTORY_PACKET_BYTES),
      });
      expect({
        head: hex(forged.head),
        attackerIsOwnerDevice: forged.state.devices.has(hex(attacker.publicKey)),
        extendedEpoch: next.ledger.state.epoch.number,
      }).toEqual({ head: hex(created.ledger.head), attackerIsOwnerDevice: true, extendedEpoch: 1 });
    }
    expect(forged, 'Ledger built from unverified state').toBe('refused');
  });

  it('BUG if fails: a LedgerView cannot be rebuilt from arbitrary state via its constructor', async () => {
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
    const attacker = await ed25519();
    const fakeState = {
      genesis: created.anchor,
      owner: created.membershipId,
      members: new Map([[hex(created.membershipId), { userId: created.userId, role: 'owner' }]]),
      devices: new Map([
        [
          hex(attacker.publicKey),
          {
            membershipId: created.membershipId,
            kind: 'personal',
            encryptionPublicKey: attacker.enc,
          },
        ],
      ]),
      epoch: { number: 0, keyCommitment: created.commitment, rotationRequired: false },
      hashes: [created.anchor],
      origin: 'genesis',
    };
    const Ctor = (view as object).constructor as new (...args: unknown[]) => typeof view;
    let observed: string;
    try {
      const forged = new Ctor(fakeState, view.genesis, view.head);
      observed = forged.inspectState().devices.has(hex(attacker.publicKey))
        ? 'forged-view-accepted'
        : 'no-effect';
    } catch {
      observed = 'refused';
    }
    expect(observed).toBe('refused');
  });
});
