import { describe, expect, it } from 'vitest';
import { Ledger, LedgerError } from '../src/ledger';
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

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(LedgerError);
  expect((error as LedgerError).code).toBe(code);
}

async function tryAppend(
  ledger: Awaited<ReturnType<typeof signGenesis>>['ledger'],
  signer: DeviceKeys,
  operation: Parameters<typeof append>[2]
) {
  try {
    const result = await append(ledger, signer, operation);
    return { ok: true as const, ...result };
  } catch (error) {
    return { ok: false as const, error };
  }
}

type Expect = 'ok' | 'unauthorized' | 'invalid-operation' | 'replay';

describe('L3 confirmed permission matrix', () => {
  it('enumerates 4 roles × 3 device kinds for confirmed operations only', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const records = [created.record];
    let ledger = created.ledger;
    const track = async (signer: DeviceKeys, operation: Parameters<typeof append>[2]) => {
      const result = await append(ledger, signer, operation);
      records.push(result.record);
      ledger = result.ledger;
      return result;
    };

    const admin = await ed25519();
    const adminJoin = await signJoin(created.anchor, admin);
    await track(owner, { type: 'admitMember', membershipId: random(16), request: adminJoin });
    const adminMembership = findMembership(ledger, adminJoin.userId);
    await track(owner, { type: 'setRole', membershipId: adminMembership, role: 'admin' });
    const adminManage = await ed25519();
    await track(
      admin,
      await admitDeviceOp(created.anchor, adminMembership, adminManage, 'personal', true)
    );
    const adminMachine = await ed25519();
    await track(
      admin,
      await admitDeviceOp(created.anchor, adminMembership, adminMachine, 'machine', false)
    );
    const adminRecovery = await ed25519();
    await track(
      admin,
      await admitDeviceOp(created.anchor, adminMembership, adminRecovery, 'recovery', false)
    );

    const member = await ed25519();
    const memberJoin = await signJoin(created.anchor, member);
    await track(owner, { type: 'admitMember', membershipId: random(16), request: memberJoin });
    const memberMembership = findMembership(ledger, memberJoin.userId);
    const memberMachine = await ed25519();
    await track(
      member,
      await admitDeviceOp(created.anchor, memberMembership, memberMachine, 'machine', false)
    );
    const memberRecovery = await ed25519();
    await track(
      member,
      await admitDeviceOp(created.anchor, memberMembership, memberRecovery, 'recovery', false)
    );

    const subject = await ed25519();
    const subjectJoin = await signJoin(created.anchor, subject);
    await track(owner, { type: 'admitMember', membershipId: random(16), request: subjectJoin });
    const subjectMembership = findMembership(ledger, subjectJoin.userId);

    const guest = await ed25519();
    const guestJoin = await signJoin(created.anchor, guest);
    await track(owner, { type: 'admitMember', membershipId: random(16), request: guestJoin });
    const guestMembership = findMembership(ledger, guestJoin.userId);
    // D5 frozen: only Owner setRole→guest.
    await track(owner, { type: 'setRole', membershipId: guestMembership, role: 'guest' });
    expect([...ledger.state.members.values()].some((row) => row.role === 'guest')).toBe(true);
    const guestRecovery = await ed25519();
    await track(
      guest,
      await admitDeviceOp(created.anchor, guestMembership, guestRecovery, 'recovery', false)
    );

    const ownerMachine = await ed25519();
    await track(
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, ownerMachine, 'machine', false)
    );
    const ownerRecovery = await ed25519();
    await track(
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, ownerRecovery, 'recovery', false)
    );

    const epochOp = async () => ({
      type: 'publishEpoch' as const,
      epoch: ledger.state.epoch.number + 1,
      commitment: await commitEpochKey(created.anchor, ledger.state.epoch.number + 1, random(32)),
      previousEpochKey: random(HISTORY_PACKET_BYTES),
    });
    const invite = async () => ({
      type: 'admitMember' as const,
      membershipId: random(16),
      request: await signJoin(created.anchor, await ed25519()),
    });

    const rows: {
      name: string;
      signer: DeviceKeys;
      op: () => Promise<Parameters<typeof append>[2]>;
      expect: Expect;
    }[] = [
      { name: 'owner-personal-invite', signer: owner, op: invite, expect: 'ok' },
      { name: 'admin-manage-invite', signer: adminManage, op: invite, expect: 'ok' },
      { name: 'admin-join-invite', signer: admin, op: invite, expect: 'unauthorized' },
      { name: 'member-personal-invite', signer: member, op: invite, expect: 'unauthorized' },
      { name: 'guest-personal-invite', signer: guest, op: invite, expect: 'unauthorized' },
      { name: 'owner-machine-invite', signer: ownerMachine, op: invite, expect: 'unauthorized' },
      { name: 'admin-machine-invite', signer: adminMachine, op: invite, expect: 'unauthorized' },
      { name: 'member-machine-invite', signer: memberMachine, op: invite, expect: 'unauthorized' },
      { name: 'owner-recovery-invite', signer: ownerRecovery, op: invite, expect: 'unauthorized' },
      { name: 'admin-recovery-invite', signer: adminRecovery, op: invite, expect: 'unauthorized' },
      {
        name: 'member-recovery-invite',
        signer: memberRecovery,
        op: invite,
        expect: 'unauthorized',
      },
      { name: 'guest-recovery-invite', signer: guestRecovery, op: invite, expect: 'unauthorized' },

      { name: 'owner-personal-epoch', signer: owner, op: epochOp, expect: 'ok' },
      { name: 'admin-manage-epoch', signer: adminManage, op: epochOp, expect: 'ok' },
      { name: 'admin-join-epoch', signer: admin, op: epochOp, expect: 'unauthorized' },
      { name: 'member-personal-epoch', signer: member, op: epochOp, expect: 'unauthorized' },
      { name: 'guest-personal-epoch', signer: guest, op: epochOp, expect: 'unauthorized' },
      { name: 'owner-machine-epoch', signer: ownerMachine, op: epochOp, expect: 'unauthorized' },
      { name: 'admin-machine-epoch', signer: adminMachine, op: epochOp, expect: 'unauthorized' },
      { name: 'member-machine-epoch', signer: memberMachine, op: epochOp, expect: 'unauthorized' },
      { name: 'owner-recovery-epoch', signer: ownerRecovery, op: epochOp, expect: 'unauthorized' },
      { name: 'admin-recovery-epoch', signer: adminRecovery, op: epochOp, expect: 'unauthorized' },
      {
        name: 'member-recovery-epoch',
        signer: memberRecovery,
        op: epochOp,
        expect: 'unauthorized',
      },
      { name: 'guest-recovery-epoch', signer: guestRecovery, op: epochOp, expect: 'unauthorized' },

      {
        name: 'owner-remove-subject',
        signer: owner,
        op: async () => ({ type: 'removeMember', membershipId: subjectMembership }),
        expect: 'ok',
      },
      {
        name: 'admin-manage-remove-member',
        signer: adminManage,
        op: async () => ({ type: 'removeMember', membershipId: memberMembership }),
        expect: 'unauthorized',
      },
      {
        name: 'member-remove-self',
        signer: member,
        op: async () => ({ type: 'removeMember', membershipId: memberMembership }),
        expect: 'unauthorized',
      },
      {
        name: 'guest-remove-member',
        signer: guest,
        op: async () => ({ type: 'removeMember', membershipId: memberMembership }),
        expect: 'unauthorized',
      },
      {
        name: 'owner-machine-remove',
        signer: ownerMachine,
        op: async () => ({ type: 'removeMember', membershipId: memberMembership }),
        expect: 'unauthorized',
      },
      {
        name: 'owner-recovery-remove',
        signer: ownerRecovery,
        op: async () => ({ type: 'removeMember', membershipId: memberMembership }),
        expect: 'unauthorized',
      },
      {
        name: 'owner-cannot-remove-self',
        signer: owner,
        op: async () => ({ type: 'removeMember', membershipId: created.membershipId }),
        expect: 'unauthorized',
      },

      {
        name: 'owner-setrole-admin-on-member',
        signer: owner,
        op: async () => ({ type: 'setRole', membershipId: memberMembership, role: 'admin' }),
        expect: 'ok',
      },
      {
        name: 'owner-setrole-same-role',
        signer: owner,
        op: async () => ({ type: 'setRole', membershipId: memberMembership, role: 'admin' }),
        expect: 'invalid-operation',
      },
      {
        name: 'owner-setrole-back-to-member',
        signer: owner,
        op: async () => ({ type: 'setRole', membershipId: memberMembership, role: 'member' }),
        expect: 'ok',
      },
      {
        name: 'admin-manage-setrole',
        signer: adminManage,
        op: async () => ({ type: 'setRole', membershipId: memberMembership, role: 'admin' }),
        expect: 'unauthorized',
      },
      {
        name: 'member-setrole',
        signer: member,
        op: async () => ({ type: 'setRole', membershipId: adminMembership, role: 'member' }),
        expect: 'unauthorized',
      },
      {
        name: 'guest-setrole',
        signer: guest,
        op: async () => ({ type: 'setRole', membershipId: memberMembership, role: 'admin' }),
        expect: 'unauthorized',
      },
      {
        name: 'owner-machine-setrole',
        signer: ownerMachine,
        op: async () => ({ type: 'setRole', membershipId: memberMembership, role: 'admin' }),
        expect: 'unauthorized',
      },
      {
        name: 'owner-recovery-setrole',
        signer: ownerRecovery,
        op: async () => ({ type: 'setRole', membershipId: memberMembership, role: 'admin' }),
        expect: 'unauthorized',
      },

      {
        name: 'owner-personal-admit-personal',
        signer: owner,
        op: async () =>
          admitDeviceOp(created.anchor, created.membershipId, await ed25519(), 'personal', false),
        expect: 'ok',
      },
      {
        name: 'admin-manage-admit-personal-manage',
        signer: adminManage,
        op: async () =>
          admitDeviceOp(created.anchor, adminMembership, await ed25519(), 'personal', true),
        expect: 'ok',
      },
      {
        name: 'member-admit-personal',
        signer: member,
        op: async () =>
          admitDeviceOp(created.anchor, memberMembership, await ed25519(), 'personal', false),
        expect: 'ok',
      },
      {
        name: 'member-admit-personal-manage',
        signer: member,
        op: async () =>
          admitDeviceOp(created.anchor, memberMembership, await ed25519(), 'personal', true),
        expect: 'unauthorized',
      },
      {
        name: 'guest-admit-personal',
        signer: guest,
        op: async () =>
          admitDeviceOp(created.anchor, guestMembership, await ed25519(), 'personal', false),
        expect: 'ok',
      },
      {
        name: 'guest-admit-personal-manage',
        signer: guest,
        op: async () =>
          admitDeviceOp(created.anchor, guestMembership, await ed25519(), 'personal', true),
        expect: 'unauthorized',
      },
      {
        name: 'guest-admit-machine',
        signer: guest,
        op: async () =>
          admitDeviceOp(created.anchor, guestMembership, await ed25519(), 'machine', false),
        expect: 'unauthorized',
      },
      {
        name: 'owner-machine-cannot-admit',
        signer: ownerMachine,
        op: async () =>
          admitDeviceOp(created.anchor, created.membershipId, await ed25519(), 'personal', false),
        expect: 'unauthorized',
      },
      {
        name: 'admin-machine-cannot-admit',
        signer: adminMachine,
        op: async () =>
          admitDeviceOp(created.anchor, adminMembership, await ed25519(), 'personal', false),
        expect: 'unauthorized',
      },
      {
        name: 'member-machine-cannot-admit',
        signer: memberMachine,
        op: async () =>
          admitDeviceOp(created.anchor, memberMembership, await ed25519(), 'personal', false),
        expect: 'unauthorized',
      },
      {
        name: 'owner-recovery-admit-personal-manage',
        signer: ownerRecovery,
        op: async () =>
          admitDeviceOp(created.anchor, created.membershipId, await ed25519(), 'personal', true),
        expect: 'ok',
      },
      {
        name: 'owner-recovery-cannot-admit-machine',
        signer: ownerRecovery,
        op: async () =>
          admitDeviceOp(created.anchor, created.membershipId, await ed25519(), 'machine', false),
        expect: 'unauthorized',
      },
      {
        name: 'admin-recovery-grant-manage',
        signer: adminRecovery,
        op: async () =>
          admitDeviceOp(created.anchor, adminMembership, await ed25519(), 'personal', true),
        expect: 'ok',
      },
      {
        name: 'member-recovery-cannot-grant-manage',
        signer: memberRecovery,
        op: async () =>
          admitDeviceOp(created.anchor, memberMembership, await ed25519(), 'personal', true),
        expect: 'unauthorized',
      },
      {
        name: 'member-recovery-admit-personal',
        signer: memberRecovery,
        op: async () =>
          admitDeviceOp(created.anchor, memberMembership, await ed25519(), 'personal', false),
        expect: 'ok',
      },
      {
        name: 'guest-recovery-admit-personal',
        signer: guestRecovery,
        op: async () =>
          admitDeviceOp(created.anchor, guestMembership, await ed25519(), 'personal', false),
        expect: 'ok',
      },
      {
        name: 'guest-recovery-grant-manage',
        signer: guestRecovery,
        op: async () =>
          admitDeviceOp(created.anchor, guestMembership, await ed25519(), 'personal', true),
        expect: 'unauthorized',
      },
      {
        name: 'guest-recovery-admit-machine',
        signer: guestRecovery,
        op: async () =>
          admitDeviceOp(created.anchor, guestMembership, await ed25519(), 'machine', false),
        expect: 'unauthorized',
      },
      {
        name: 'guest-recovery-cannot-revoke',
        signer: guestRecovery,
        op: async () => ({ type: 'revokeDevice', target: guest.publicKey }),
        expect: 'unauthorized',
      },

      {
        name: 'member-revoke-own-machine',
        signer: member,
        op: async () => ({ type: 'revokeDevice', target: memberMachine.publicKey }),
        expect: 'ok',
      },
      {
        name: 'revoked-device-cannot-admit',
        signer: memberMachine,
        op: async () =>
          admitDeviceOp(created.anchor, memberMembership, await ed25519(), 'personal', false),
        expect: 'unauthorized',
      },
      {
        name: 'member-revoke-owner-device',
        signer: member,
        op: async () => ({ type: 'revokeDevice', target: owner.publicKey }),
        expect: 'unauthorized',
      },
      {
        name: 'guest-revoke-own-recovery',
        signer: guest,
        op: async () => ({ type: 'revokeDevice', target: guestRecovery.publicKey }),
        expect: 'ok',
      },
      {
        name: 'guest-revoke-owner-device',
        signer: guest,
        op: async () => ({ type: 'revokeDevice', target: owner.publicKey }),
        expect: 'unauthorized',
      },
      {
        name: 'owner-machine-revoke-self',
        signer: ownerMachine,
        op: async () => ({ type: 'revokeDevice', target: ownerMachine.publicKey }),
        expect: 'unauthorized',
      },
      {
        name: 'admin-machine-revoke',
        signer: adminMachine,
        op: async () => ({ type: 'revokeDevice', target: adminMachine.publicKey }),
        expect: 'unauthorized',
      },
      {
        name: 'owner-recovery-cannot-revoke',
        signer: ownerRecovery,
        op: async () => ({ type: 'revokeDevice', target: ownerMachine.publicKey }),
        expect: 'unauthorized',
      },
      {
        name: 'admin-recovery-cannot-revoke',
        signer: adminRecovery,
        op: async () => ({ type: 'revokeDevice', target: adminMachine.publicKey }),
        expect: 'unauthorized',
      },
      {
        name: 'owner-transfer-self',
        signer: owner,
        op: async () => ({ type: 'transferOwner', successorMembershipId: created.membershipId }),
        expect: 'unauthorized',
      },
      {
        name: 'owner-transfer-unknown',
        signer: owner,
        op: async () => ({ type: 'transferOwner', successorMembershipId: random(16) }),
        expect: 'unauthorized',
      },
      {
        name: 'admin-manage-transfer',
        signer: adminManage,
        op: async () => ({ type: 'transferOwner', successorMembershipId: memberMembership }),
        expect: 'unauthorized',
      },
      {
        name: 'member-transfer',
        signer: member,
        op: async () => ({ type: 'transferOwner', successorMembershipId: adminMembership }),
        expect: 'unauthorized',
      },
      {
        name: 'guest-transfer',
        signer: guest,
        op: async () => ({ type: 'transferOwner', successorMembershipId: memberMembership }),
        expect: 'unauthorized',
      },
      {
        name: 'owner-machine-transfer',
        signer: ownerMachine,
        op: async () => ({ type: 'transferOwner', successorMembershipId: memberMembership }),
        expect: 'unauthorized',
      },
      {
        name: 'owner-recovery-transfer',
        signer: ownerRecovery,
        op: async () => ({ type: 'transferOwner', successorMembershipId: memberMembership }),
        expect: 'unauthorized',
      },
      {
        name: 'admin-setRole-guest',
        signer: adminManage,
        op: async () => ({ type: 'setRole', membershipId: memberMembership, role: 'guest' }),
        expect: 'unauthorized',
      },
      {
        name: 'member-setRole-guest',
        signer: member,
        op: async () => ({ type: 'setRole', membershipId: subjectMembership, role: 'guest' }),
        expect: 'unauthorized',
      },
      {
        name: 'guest-setRole-member',
        signer: guest,
        op: async () => ({ type: 'setRole', membershipId: memberMembership, role: 'member' }),
        expect: 'unauthorized',
      },
      {
        name: 'owner-machine-setRole-guest',
        signer: ownerMachine,
        op: async () => ({ type: 'setRole', membershipId: memberMembership, role: 'guest' }),
        expect: 'unauthorized',
      },
      {
        name: 'owner-recovery-setRole-guest',
        signer: ownerRecovery,
        op: async () => ({ type: 'setRole', membershipId: memberMembership, role: 'guest' }),
        expect: 'unauthorized',
      },
      {
        name: 'owner-setRole-guest-noop',
        signer: owner,
        op: async () => ({ type: 'setRole', membershipId: guestMembership, role: 'guest' }),
        expect: 'invalid-operation',
      },
    ];

    const covered = new Set(rows.map((row) => row.name.split('-').slice(0, 2).join('-')));
    for (const cell of [
      'owner-personal',
      'owner-machine',
      'owner-recovery',
      'admin-manage',
      'admin-join',
      'admin-machine',
      'admin-recovery',
      'member-personal',
      'member-machine',
      'member-recovery',
      'guest-personal',
      'guest-recovery',
    ]) {
      expect(covered.has(cell), `missing ${cell}`).toBe(true);
    }
    expect(rows.some((row) => row.name.startsWith('guest-machine-') && row.expect === 'ok')).toBe(
      false
    );
    expect(rows.some((row) => row.name.includes('transfer') && row.expect === 'unauthorized')).toBe(
      true
    );

    for (const row of rows) {
      const operation = await row.op();
      const result = await tryAppend(ledger, row.signer, operation);
      if (row.expect === 'ok') {
        expect(result.ok, row.name).toBe(true);
        if (result.ok) {
          records.push(result.record);
          ledger = result.ledger;
        }
      } else {
        expect(result.ok, row.name).toBe(false);
        if (!result.ok) expectCode(result.error, row.expect);
      }
    }

    const removed = await append(ledger, owner, {
      type: 'removeMember',
      membershipId: memberMembership,
    });
    records.push(removed.record);
    ledger = removed.ledger;
    const stale = await tryAppend(
      ledger,
      member,
      await admitDeviceOp(created.anchor, created.membershipId, await ed25519(), 'personal', false)
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expectCode(stale.error, 'unauthorized');

    const rejoin = await ed25519();
    const reentry = await append(ledger, owner, {
      type: 'admitMember',
      membershipId: random(16),
      request: await signJoin(created.anchor, rejoin),
    });
    records.push(reentry.record);
    expect(reentry.ledger.state.members.size).toBe(ledger.state.members.size + 1);
    ledger = reentry.ledger;
    const replayJoin = await tryAppend(ledger, owner, {
      type: 'admitMember',
      membershipId: random(16),
      request: memberJoin,
    });
    expect(replayJoin.ok).toBe(false);
    if (!replayJoin.ok) expectCode(replayJoin.error, 'replay');

    const successorMembership = ledger.state.devices.get(hex(rejoin.publicKey))!.membershipId;
    const transferred = await append(ledger, owner, {
      type: 'transferOwner',
      successorMembershipId: successorMembership,
    });
    records.push(transferred.record);
    ledger = transferred.ledger;
    expect(hex(ledger.state.owner)).toBe(hex(successorMembership));
    expect(ledger.state.members.get(hex(successorMembership))?.role).toBe('owner');
    expect(ledger.state.members.get(hex(created.membershipId))?.role).toBe('admin');

    const full = await Ledger.verify({ anchor: created.anchor, records });
    expect(full.head).toEqual(ledger.head);
    expect(full.length).toBe(records.length);
    expect(full.state.members.size).toBe(ledger.state.members.size);
    expect(full.state.devices.size).toBe(ledger.state.devices.size);
    for (let split = 1; split < records.length; split++) {
      const prefix = await Ledger.verify({
        anchor: created.anchor,
        records: records.slice(0, split),
      });
      const extended = await prefix.extend(records.slice(split));
      expect(extended.head, `split ${split}`).toEqual(full.head);
      expect(extended.length).toBe(full.length);
      expect(extended.state.epoch.number).toBe(full.state.epoch.number);
      expect(extended.state.devices.size).toBe(full.state.devices.size);
      expect(extended.state.members.size).toBe(full.state.members.size);
      for (let i = 0; i < full.length; i++) {
        expect(extended.hashAt(i)).toEqual(full.hashAt(i));
      }
    }
  });
});
