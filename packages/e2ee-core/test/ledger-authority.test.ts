// Ledger authorization policy: management derives from role ∩ personal device kind.
// Real Ed25519 keys and signatures; no crypto stubs, clocks or network.
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { Ledger, LedgerError } from '../src/ledger';
import { verifyLedger, Bytes } from '@lody/e2ee-core/effect';
import { signatureVerifierLayer } from '@lody/e2ee-core/effect/platform';
import { encodeSignedRecord, type Operation } from '../src/ledger/schema';
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
  type DeviceKeys,
} from './ledger-fixtures';

type L = Awaited<ReturnType<typeof Ledger.verify>>;

async function code(run: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof run === 'function' ? run() : run);
  } catch (error) {
    if (error instanceof LedgerError) return error.code;
    throw error;
  }
  return 'accepted';
}

/** Sign without prepareChecked; extend is the only authority. */
async function sign(ledger: L, signer: DeviceKeys, operation: Operation) {
  const proposal = ledger.prepare(operation, signer.publicKey);
  return encodeSignedRecord(proposal.bodyBytes, await signer.sign(proposal.signingBytes));
}

async function tryAppend(ledger: L, signer: DeviceKeys, operation: Operation) {
  const bytes = await sign(ledger, signer, operation);
  return code(ledger.extend([bytes]));
}

async function epochOp(ledger: L, anchor: Uint8Array): Promise<Operation> {
  const epoch = ledger.state.epoch.number + 1;
  return {
    type: 'publishEpoch',
    epoch,
    commitment: await commitEpochKey(anchor, epoch, random(32)),
    previousEpochKey: random(HISTORY_PACKET_BYTES),
  };
}

async function org() {
  const owner = await ed25519();
  const created = await signGenesis(owner);
  const records = [created.record];
  let ledger = created.ledger;
  const push = async (signer: DeviceKeys, op: Operation) => {
    const next = await append(ledger, signer, op);
    ledger = next.ledger;
    records.push(next.record);
    return next;
  };
  const admit = async (actor: DeviceKeys = owner) => {
    const device = await ed25519();
    const join = await signJoin(created.anchor, device);
    const membershipId = random(16);
    await push(actor, { type: 'admitMember', membershipId, request: join });
    return { device, membershipId, userId: join.userId };
  };
  return {
    owner,
    created,
    records,
    get ledger() {
      return ledger;
    },
    push,
    admit,
  };
}

describe('management derives from role ∩ personal kind', () => {
  it('SAFE: owner machine and recovery devices never manage', async () => {
    const o = await org();
    const machine = await ed25519();
    const recovery = await ed25519();
    await o.push(
      o.owner,
      await admitDeviceOp(o.created.anchor, o.created.membershipId, machine, 'machine')
    );
    await o.push(
      o.owner,
      await admitDeviceOp(o.created.anchor, o.created.membershipId, recovery, 'recovery')
    );
    const bob = await o.admit();
    for (const actor of [machine, recovery]) {
      expect(await tryAppend(o.ledger, actor, await epochOp(o.ledger, o.created.anchor))).toBe(
        'unauthorized'
      );
      expect(
        await tryAppend(o.ledger, actor, { type: 'removeMember', membershipId: bob.membershipId })
      ).toBe('unauthorized');
      expect(
        await tryAppend(o.ledger, actor, {
          type: 'setRole',
          membershipId: bob.membershipId,
          role: 'admin',
        })
      ).toBe('unauthorized');
      expect(
        await tryAppend(o.ledger, actor, {
          type: 'transferOwner',
          successorMembershipId: bob.membershipId,
        })
      ).toBe('unauthorized');
      const applicant = await ed25519();
      expect(
        await tryAppend(o.ledger, actor, {
          type: 'admitMember',
          membershipId: random(16),
          request: await signJoin(o.created.anchor, applicant),
        })
      ).toBe('unauthorized');
      expect(
        await tryAppend(o.ledger, actor, { type: 'revokeDevice', target: bob.device.publicKey })
      ).toBe('unauthorized');
    }
    // Machine cannot admit devices at all; recovery only personal.
    const extra = await ed25519();
    expect(
      await tryAppend(
        o.ledger,
        machine,
        await admitDeviceOp(o.created.anchor, o.created.membershipId, extra, 'personal')
      )
    ).toBe('unauthorized');
    for (const kind of ['machine', 'recovery'] as const) {
      const d = await ed25519();
      expect(
        await tryAppend(
          o.ledger,
          recovery,
          await admitDeviceOp(o.created.anchor, o.created.membershipId, d, kind)
        )
      ).toBe('unauthorized');
    }
  });

  it('SAFE: promotion/demotion applies immediately to every personal device; guest restrictions', async () => {
    const o = await org();
    const bob = await o.admit();
    const bobPhone = await ed25519();
    await o.push(
      bob.device,
      await admitDeviceOp(o.created.anchor, bob.membershipId, bobPhone, 'personal')
    );
    // Member cannot publish.
    expect(await tryAppend(o.ledger, bobPhone, await epochOp(o.ledger, o.created.anchor))).toBe(
      'unauthorized'
    );
    await o.push(o.owner, { type: 'setRole', membershipId: bob.membershipId, role: 'admin' });
    // Admin: both personal devices may publish/admit, not remove/setRole/transfer.
    expect(await tryAppend(o.ledger, bobPhone, await epochOp(o.ledger, o.created.anchor))).toBe(
      'accepted'
    );
    const carol = await o.admit(bobPhone);
    expect(
      await tryAppend(o.ledger, bobPhone, {
        type: 'removeMember',
        membershipId: carol.membershipId,
      })
    ).toBe('unauthorized');
    expect(
      await tryAppend(o.ledger, bobPhone, {
        type: 'setRole',
        membershipId: carol.membershipId,
        role: 'admin',
      })
    ).toBe('unauthorized');
    expect(
      await tryAppend(o.ledger, bobPhone, {
        type: 'transferOwner',
        successorMembershipId: carol.membershipId,
      })
    ).toBe('unauthorized');
    // Demote to guest: management gone at once; guest cannot admit machine, can admit R.
    await o.push(o.owner, { type: 'setRole', membershipId: bob.membershipId, role: 'guest' });
    expect(await tryAppend(o.ledger, bob.device, await epochOp(o.ledger, o.created.anchor))).toBe(
      'unauthorized'
    );
    const m = await ed25519();
    expect(
      await tryAppend(
        o.ledger,
        bobPhone,
        await admitDeviceOp(o.created.anchor, bob.membershipId, m, 'machine')
      )
    ).toBe('unauthorized');
    const r = await ed25519();
    await o.push(bobPhone, await admitDeviceOp(o.created.anchor, bob.membershipId, r, 'recovery'));
    // Guest R admits a personal device; that device is still guest (no management).
    const fresh = await ed25519();
    await o.push(r, await admitDeviceOp(o.created.anchor, bob.membershipId, fresh, 'personal'));
    expect(await tryAppend(o.ledger, fresh, await epochOp(o.ledger, o.created.anchor))).toBe(
      'unauthorized'
    );
  });

  it('SAFE: transferOwner — predecessor loses owner-only authority, successor gains it', async () => {
    const o = await org();
    const bob = await o.admit();
    const carol = await o.admit();
    await o.push(o.owner, { type: 'transferOwner', successorMembershipId: bob.membershipId });
    expect(o.ledger.state.members.get(hex(o.created.membershipId))!.role).toBe('admin');
    expect(
      await tryAppend(o.ledger, o.owner, { type: 'removeMember', membershipId: carol.membershipId })
    ).toBe('unauthorized');
    expect(
      await tryAppend(o.ledger, o.owner, {
        type: 'transferOwner',
        successorMembershipId: carol.membershipId,
      })
    ).toBe('unauthorized');
    // Successor can demote/remove predecessor.
    expect(
      await tryAppend(o.ledger, bob.device, {
        type: 'removeMember',
        membershipId: o.created.membershipId,
      })
    ).toBe('accepted');
    // Nobody can remove/transfer to self/current owner.
    expect(
      await tryAppend(o.ledger, bob.device, {
        type: 'transferOwner',
        successorMembershipId: bob.membershipId,
      })
    ).toBe('unauthorized');
    expect(
      await tryAppend(o.ledger, bob.device, {
        type: 'setRole',
        membershipId: bob.membershipId,
        role: 'admin',
      })
    ).toBe('unauthorized');
  });

  it('SAFE: removeMember revokes machine/recovery too; rejoin needs a fresh membership and fresh keys', async () => {
    const o = await org();
    const bob = await o.admit();
    const r = await ed25519();
    const mach = await ed25519();
    await o.push(
      bob.device,
      await admitDeviceOp(o.created.anchor, bob.membershipId, r, 'recovery')
    );
    await o.push(
      bob.device,
      await admitDeviceOp(o.created.anchor, bob.membershipId, mach, 'machine')
    );
    // Pre-sign an R admission while R is still valid (stale authority attempt).
    const preparedBeforeRemoval = await admitDeviceOp(
      o.created.anchor,
      bob.membershipId,
      await ed25519(),
      'personal'
    );
    await o.push(o.owner, { type: 'removeMember', membershipId: bob.membershipId });
    expect(o.ledger.state.epoch.rotationRequired).toBe(true);
    for (const k of [bob.device, r, mach])
      expect(o.ledger.state.devices.has(hex(k.publicKey))).toBe(false);
    expect(await tryAppend(o.ledger, r, preparedBeforeRemoval)).toBe('unauthorized');
    // Re-admitting with the same membershipId or same first key is replay.
    const again = await signJoin(o.created.anchor, await ed25519());
    expect(
      await tryAppend(o.ledger, o.owner, {
        type: 'admitMember',
        membershipId: bob.membershipId,
        request: { ...again },
      })
    ).toBe('replay');
    const reuseKey = await signJoin(o.created.anchor, bob.device);
    expect(
      await tryAppend(o.ledger, o.owner, {
        type: 'admitMember',
        membershipId: random(16),
        request: reuseKey,
      })
    ).toBe('replay');
  });

  it('SAFE: possession proofs are bound to target membership, kind and Org', async () => {
    const o = await org();
    const bob = await o.admit();
    const carol = await o.admit();
    const d = await ed25519();
    const forBob = await admitDeviceOp(o.created.anchor, bob.membershipId, d, 'personal');
    // Carol tries to attach Bob's intended device to her membership.
    expect(await tryAppend(o.ledger, carol.device, forBob)).toBe('bad-proof');
    // Kind swap.
    expect(await tryAppend(o.ledger, bob.device, { ...forBob, kind: 'machine' })).toBe('bad-proof');
    // Cross-Org: same membership bytes in another Org is still another genesis.
    const o2owner = await ed25519();
    const o2 = await signGenesis(o2owner);
    const crossOrg = await admitDeviceOp(o2.anchor, o2.membershipId, await ed25519(), 'personal');
    expect(await tryAppend(o.ledger, o.owner, { ...crossOrg })).toBe('bad-proof');
    // Cross-Org join request.
    const applicant = await ed25519();
    const joinB = await signJoin(o2.anchor, applicant);
    expect(
      await tryAppend(o.ledger, o.owner, {
        type: 'admitMember',
        membershipId: random(16),
        request: joinB,
      })
    ).toBe('bad-proof');
    expect(await tryAppend(o.ledger, bob.device, forBob)).toBe('accepted');
  });

  it('SAFE: revokeDevice is own-membership only and revoked keys can never return', async () => {
    const o = await org();
    const bob = await o.admit();
    const carol = await o.admit();
    expect(
      await tryAppend(o.ledger, o.owner, { type: 'revokeDevice', target: bob.device.publicKey })
    ).toBe('unauthorized');
    expect(
      await tryAppend(o.ledger, bob.device, {
        type: 'revokeDevice',
        target: carol.device.publicKey,
      })
    ).toBe('unauthorized');
    const phone = await ed25519();
    await o.push(
      bob.device,
      await admitDeviceOp(o.created.anchor, bob.membershipId, phone, 'personal')
    );
    await o.push(bob.device, { type: 'revokeDevice', target: phone.publicKey });
    expect(
      await tryAppend(
        o.ledger,
        bob.device,
        await admitDeviceOp(o.created.anchor, bob.membershipId, phone, 'personal')
      )
    ).toBe('replay');
    expect(await tryAppend(o.ledger, phone, await epochOp(o.ledger, o.created.anchor))).toBe(
      'unauthorized'
    );
  });

  it('SAFE: publishEpoch replay of commitment / epoch number is rejected', async () => {
    const o = await org();
    const op = (await epochOp(o.ledger, o.created.anchor)) as Extract<
      Operation,
      { type: 'publishEpoch' }
    >;
    await o.push(o.owner, op);
    expect(await tryAppend(o.ledger, o.owner, { ...op, epoch: op.epoch + 1 })).toBe('replay');
    expect(await tryAppend(o.ledger, o.owner, { ...op, commitment: random(32) })).toBe(
      'invalid-operation'
    );
    expect(
      await tryAppend(o.ledger, o.owner, {
        ...op,
        epoch: op.epoch + 1,
        commitment: o.created.commitment,
      })
    ).toBe('replay');
  });

  it('keeps the Owner a personal device or recovery device R', async () => {
    const o = await org();
    const bob = await o.admit();
    // The Owner cannot revoke its only governing device ...
    expect(
      await tryAppend(o.ledger, o.owner, { type: 'revokeDevice', target: o.owner.publicKey })
    ).toBe('unauthorized');
    // ... but can once another personal device (or R) remains.
    const spare = await ed25519();
    await o.push(
      o.owner,
      await admitDeviceOp(o.created.anchor, o.created.membershipId, spare, 'personal')
    );
    expect(
      await tryAppend(o.ledger, o.owner, { type: 'revokeDevice', target: o.owner.publicKey })
    ).toBe('accepted');

    // Ownership never moves to a member left with only a machine.
    const daveMachine = await ed25519();
    await o.push(
      bob.device,
      await admitDeviceOp(o.created.anchor, bob.membershipId, daveMachine, 'machine')
    );
    await o.push(bob.device, { type: 'revokeDevice', target: bob.device.publicKey });
    expect(
      await tryAppend(o.ledger, o.owner, {
        type: 'transferOwner',
        successorMembershipId: bob.membershipId,
      })
    ).toBe('unauthorized');
  });

  it('SAFE: Effect verifyLedger and Promise Ledger.verify agree on a mixed history', async () => {
    const o = await org();
    const bob = await o.admit();
    await o.push(o.owner, { type: 'setRole', membershipId: bob.membershipId, role: 'admin' });
    const r = await ed25519();
    await o.push(
      bob.device,
      await admitDeviceOp(o.created.anchor, bob.membershipId, r, 'recovery')
    );
    const n = await ed25519();
    await o.push(r, await admitDeviceOp(o.created.anchor, bob.membershipId, n, 'personal'));
    await o.push(n, await epochOp(o.ledger, o.created.anchor));
    await o.push(o.owner, { type: 'transferOwner', successorMembershipId: bob.membershipId });
    await o.push(n, { type: 'setRole', membershipId: o.created.membershipId, role: 'guest' });
    const view = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* verifyLedger({
          anchor: yield* Effect.fromResult(Bytes.genesisHash(o.created.anchor)),
          records: o.records,
        });
      }).pipe(Effect.provide(signatureVerifierLayer))
    );
    const full = await Ledger.verify({ anchor: o.created.anchor, records: o.records });
    const a = view.inspectState();
    const b = full.state;
    expect(hex(a.owner)).toBe(hex(b.owner));
    expect([...a.members].map(([k, v]) => [k, v.role])).toEqual(
      [...b.members].map(([k, v]) => [k, v.role])
    );
    expect([...a.devices.keys()].sort()).toEqual([...b.devices.keys()].sort());
    expect(findMembership(full, bob.userId)).toEqual(bob.membershipId);
  });
});
