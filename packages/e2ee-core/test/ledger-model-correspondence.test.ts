import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Ledger, LedgerError, type LedgerErrorCode } from '@lody/e2ee-core';
import {
  HISTORY_PACKET_BYTES,
  commitEpochKey,
  encodeGenesisBody,
  encodeSignedRecord,
  hashRecord,
  joinRequestSigningBytes,
  possessionSigningBytes,
  signingBytesForBody,
  type Operation,
} from '@lody/e2ee-core/ledger';
import { genesis, leanStep, type LeanOp, type LeanState } from './ledger-model';

function resolveLeanRoot(): string | null {
  const fromEnv = process.env.LODY_E2EE_LEAN;
  if (fromEnv) {
    if (!existsSync(join(fromEnv, 'lakefile.toml'))) {
      throw new Error(`LODY_E2EE_LEAN=${fromEnv} has no lakefile.toml`);
    }
    return fromEnv;
  }
  const sibling = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../lody-e2ee-design/proofs/e2ee'
  );
  return existsSync(join(sibling, 'lakefile.toml')) ? sibling : null;
}

const LEAN_ROOT = resolveLeanRoot();

function encodeLean(op: LeanOp): string {
  switch (op.type) {
    case 'admitMember':
      return `admitMember ${op.actor} ${op.newMember} ${op.firstDevice}`;
    case 'removeMember':
      return `removeMember ${op.actor} ${op.target}`;
    case 'setRoleAdmin':
      return `setRoleAdmin ${op.actor} ${op.target}`;
    case 'setRoleMember':
      return `setRoleMember ${op.actor} ${op.target}`;
    case 'setRoleGuest':
      return `setRoleGuest ${op.actor} ${op.target}`;
    case 'admitDevice':
      return `admitDevice ${op.actor} ${op.newId} ${op.kind} ${op.canManage ? 1 : 0}`;
    case 'revokeDevice':
      return `revokeDevice ${op.actor} ${op.target}`;
    case 'publishEpoch':
      return `publishEpoch ${op.actor}`;
    case 'transferOwner':
      return `transferOwner ${op.actor} ${op.successor}`;
  }
  throw new Error('unreachable-lean-op');
}

type LeanProjection = {
  owner: number;
  epoch: number;
  members: Array<[number, 'owner' | 'admin' | 'member' | 'guest']>;
  devices: Array<
    [number, { memberId: number; kind: 'personal' | 'machine' | 'recovery'; canManage: boolean }]
  >;
};

type LeanLine = { ok: false } | { ok: true; state: LeanProjection };

function parseLeanLine(line: string): LeanLine {
  if (line === 'none') return { ok: false };
  const match = /^some owner=(\d+) epoch=(\d+) members=(.*) devices=(.*)$/.exec(line);
  if (!match) throw new Error(`bad-lean-line:${line}`);
  const members: LeanProjection['members'] = [];
  if (match[3]) {
    for (const part of match[3].split(',')) {
      const [id, role] = part.split(':');
      if (!id || !role) throw new Error(`bad-lean-member:${part}`);
      if (role !== 'owner' && role !== 'admin' && role !== 'member' && role !== 'guest') {
        throw new Error(`bad-lean-role:${role}`);
      }
      members.push([Number(id), role]);
    }
  }
  const devices: LeanProjection['devices'] = [];
  if (match[4]) {
    for (const part of match[4].split(',')) {
      const [id, memberId, kind, cm] = part.split(':');
      if (!id || !memberId || !kind || cm === undefined) throw new Error(`bad-lean-device:${part}`);
      if (kind !== 'personal' && kind !== 'machine' && kind !== 'recovery') {
        throw new Error(`bad-lean-kind:${kind}`);
      }
      devices.push([Number(id), { memberId: Number(memberId), kind, canManage: cm === '1' }]);
    }
  }
  return {
    ok: true,
    state: {
      owner: Number(match[1]),
      epoch: Number(match[2]),
      members,
      devices,
    },
  };
}

function runLeanTrace(ops: string[]): LeanLine[] {
  if (!LEAN_ROOT) throw new Error('lean-root-missing');
  const built = spawnSync('lake', ['build', 'correspond'], {
    cwd: LEAN_ROOT,
    encoding: 'utf8',
  });
  if (built.status !== 0) {
    throw new Error(`lake-build-failed\n${built.stdout}\n${built.stderr}`);
  }
  const ran = spawnSync('lake', ['exe', 'correspond'], {
    cwd: LEAN_ROOT,
    input: `${ops.join('\n')}\n`,
    encoding: 'utf8',
  });
  if (ran.status !== 0) {
    throw new Error(`lake-exe-failed\n${ran.stdout}\n${ran.stderr}`);
  }
  return ran.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('some ') || line === 'none')
    .map(parseLeanLine);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

type Device = {
  publicKey: Uint8Array;
  enc: Uint8Array;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
};

function random(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function device(): Promise<Device> {
  const sign = (await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', sign.publicKey));
  const dh = (await crypto.subtle.generateKey('X25519', false, ['deriveBits'])) as CryptoKeyPair;
  const enc = new Uint8Array(await crypto.subtle.exportKey('raw', dh.publicKey));
  void dh;
  return {
    publicKey,
    enc,
    async sign(bytes: Uint8Array) {
      const message = new Uint8Array(bytes.byteLength);
      message.set(bytes);
      return new Uint8Array(await crypto.subtle.sign('Ed25519', sign.privateKey, message));
    },
  };
}

describe('M3 Lean model ↔ public Ledger API', () => {
  it('accepts and rejects the same synthetic trace as E2EE.step, including broken guards', async () => {
    const owner = await device();
    const secret = random(32);
    const ownerMembership = random(16);
    const body = encodeGenesisBody({
      signer: owner.publicKey,
      userId: random(32),
      membershipId: ownerMembership,
      encryptionPublicKey: owner.enc,
      epochCommitment: await commitEpochKey(new Uint8Array(32), 0, secret),
    });
    const genesisRecord = encodeSignedRecord(body, await owner.sign(signingBytesForBody(body)));
    const anchor = await hashRecord(genesisRecord);
    const records = [genesisRecord];
    let ledger = await Ledger.verify({ anchor, records });

    const devices = new Map<number, Device>([[0, owner]]);
    const memberships = new Map<number, Uint8Array>([[0, ownerMembership]]);
    let lean: LeanState = genesis;
    const leanLines: string[] = [];
    const snapshots: Array<{ ledger: typeof ledger; ok: boolean }> = [];

    const tryLedger = async (signer: Device, operation: Operation) => {
      try {
        const proposal = ledger.prepare(operation, signer.publicKey);
        const record = await ledger.finalize(proposal, await signer.sign(proposal.signingBytes));
        const next = await ledger.extend([record]);
        return { ok: true as const, record, ledger: next };
      } catch (error) {
        return { ok: false as const, error };
      }
    };

    async function apply(
      op: LeanOp,
      build: () => Promise<{ signer: Device; operation: Operation }>,
      expectedCode?: LedgerErrorCode
    ) {
      const model = leanStep(lean, op);
      const { signer, operation } = await build();
      const result = await tryLedger(signer, operation);
      leanLines.push(encodeLean(op));
      expect(result.ok, JSON.stringify(op)).toBe(model !== null);
      if (expectedCode !== undefined) {
        expect(result.ok, JSON.stringify(op)).toBe(false);
        expect(result.error).toBeInstanceOf(LedgerError);
        expect((result.error as LedgerError).code, JSON.stringify(op)).toBe(expectedCode);
      }
      if (model && result.ok) {
        lean = model;
        records.push(result.record);
        ledger = result.ledger;
        expect(ledger.state.epoch.number).toBe(lean.epoch);
        expect(ledger.state.members.size).toBe(lean.members.length);
        expect(ledger.state.devices.size).toBe(lean.devices.length);
        snapshots.push({ ledger, ok: true });
      } else if (!result.ok) {
        expect(result.error).toBeInstanceOf(LedgerError);
        snapshots.push({ ledger, ok: false });
      }
    }

    const member = await device();
    devices.set(1, member);
    const memberJoin = {
      requestId: random(16),
      userId: random(32),
      signingPublicKey: member.publicKey,
      encryptionPublicKey: member.enc,
      expiresAt: null as number | null,
    };
    const memberJoinSigned = {
      ...memberJoin,
      signature: await member.sign(joinRequestSigningBytes(anchor, memberJoin)),
    };
    const memberMembership = random(16);
    memberships.set(2, memberMembership);
    await apply({ type: 'admitMember', actor: 0, newMember: 2, firstDevice: 1 }, async () => ({
      signer: owner,
      operation: { type: 'admitMember', membershipId: memberMembership, request: memberJoinSigned },
    }));

    await apply({ type: 'setRoleAdmin', actor: 0, target: 2 }, async () => ({
      signer: owner,
      operation: { type: 'setRole', membershipId: memberMembership, role: 'admin' },
    }));

    const adminManage = await device();
    devices.set(3, adminManage);
    await apply(
      { type: 'admitDevice', actor: 1, newId: 3, kind: 'personal', canManage: true },
      async () => {
        const target = adminManage;
        return {
          signer: member,
          operation: {
            type: 'admitDevice',
            kind: 'personal',
            signingPublicKey: target.publicKey,
            encryptionPublicKey: target.enc,
            canManage: true,
            possessionSignature: await target.sign(
              possessionSigningBytes({
                genesis: anchor,
                targetMembershipId: memberMembership,
                signingPublicKey: target.publicKey,
                encryptionPublicKey: target.enc,
                kind: 'personal',
                canManage: true,
              })
            ),
          },
        };
      }
    );

    await apply({ type: 'publishEpoch', actor: 3 }, async () => ({
      signer: adminManage,
      operation: {
        type: 'publishEpoch',
        epoch: ledger.state.epoch.number + 1,
        commitment: await commitEpochKey(anchor, ledger.state.epoch.number + 1, random(32)),
        previousEpochKey: random(HISTORY_PACKET_BYTES),
      },
    }));

    const recovery = await device();
    devices.set(4, recovery);
    await apply(
      { type: 'admitDevice', actor: 0, newId: 4, kind: 'recovery', canManage: false },
      async () => ({
        signer: owner,
        operation: {
          type: 'admitDevice',
          kind: 'recovery',
          signingPublicKey: recovery.publicKey,
          encryptionPublicKey: recovery.enc,
          canManage: false,
          possessionSignature: await recovery.sign(
            possessionSigningBytes({
              genesis: anchor,
              targetMembershipId: ownerMembership,
              signingPublicKey: recovery.publicKey,
              encryptionPublicKey: recovery.enc,
              kind: 'recovery',
              canManage: false,
            })
          ),
        },
      })
    );

    await apply({ type: 'publishEpoch', actor: 4 }, async () => ({
      signer: recovery,
      operation: {
        type: 'publishEpoch',
        epoch: ledger.state.epoch.number + 1,
        commitment: await commitEpochKey(anchor, ledger.state.epoch.number + 1, random(32)),
        previousEpochKey: random(HISTORY_PACKET_BYTES),
      },
    }));

    await apply(
      { type: 'removeMember', actor: 3, target: 2 },
      async () => ({
        signer: adminManage,
        operation: { type: 'removeMember', membershipId: memberMembership },
      }),
      'unauthorized'
    );

    const extra = await device();
    devices.set(5, extra);
    await apply(
      { type: 'admitDevice', actor: 0, newId: 5, kind: 'personal', canManage: false },
      async () => ({
        signer: owner,
        operation: {
          type: 'admitDevice',
          kind: 'personal',
          signingPublicKey: extra.publicKey,
          encryptionPublicKey: extra.enc,
          canManage: false,
          possessionSignature: await extra.sign(
            possessionSigningBytes({
              genesis: anchor,
              targetMembershipId: ownerMembership,
              signingPublicKey: extra.publicKey,
              encryptionPublicKey: extra.enc,
              kind: 'personal',
              canManage: false,
            })
          ),
        },
      })
    );
    await apply({ type: 'revokeDevice', actor: 0, target: 5 }, async () => ({
      signer: owner,
      operation: { type: 'revokeDevice', target: extra.publicKey },
    }));
    await apply(
      { type: 'admitDevice', actor: 0, newId: 5, kind: 'personal', canManage: false },
      async () => ({
        signer: owner,
        operation: {
          type: 'admitDevice',
          kind: 'personal',
          signingPublicKey: extra.publicKey,
          encryptionPublicKey: extra.enc,
          canManage: false,
          possessionSignature: await extra.sign(
            possessionSigningBytes({
              genesis: anchor,
              targetMembershipId: ownerMembership,
              signingPublicKey: extra.publicKey,
              encryptionPublicKey: extra.enc,
              kind: 'personal',
              canManage: false,
            })
          ),
        },
      })
    );

    const plain = await device();
    devices.set(6, plain);
    const plainMembership = random(16);
    memberships.set(7, plainMembership);
    const plainJoin = {
      requestId: random(16),
      userId: random(32),
      signingPublicKey: plain.publicKey,
      encryptionPublicKey: plain.enc,
      expiresAt: null as number | null,
    };
    await apply({ type: 'admitMember', actor: 0, newMember: 7, firstDevice: 6 }, async () => ({
      signer: owner,
      operation: {
        type: 'admitMember',
        membershipId: plainMembership,
        request: {
          ...plainJoin,
          signature: await plain.sign(joinRequestSigningBytes(anchor, plainJoin)),
        },
      },
    }));
    const plainRecovery = await device();
    devices.set(8, plainRecovery);
    await apply(
      { type: 'admitDevice', actor: 6, newId: 8, kind: 'recovery', canManage: false },
      async () => ({
        signer: plain,
        operation: {
          type: 'admitDevice',
          kind: 'recovery',
          signingPublicKey: plainRecovery.publicKey,
          encryptionPublicKey: plainRecovery.enc,
          canManage: false,
          possessionSignature: await plainRecovery.sign(
            possessionSigningBytes({
              genesis: anchor,
              targetMembershipId: plainMembership,
              signingPublicKey: plainRecovery.publicKey,
              encryptionPublicKey: plainRecovery.enc,
              kind: 'recovery',
              canManage: false,
            })
          ),
        },
      })
    );
    const granted = await device();
    devices.set(9, granted);
    await apply(
      { type: 'admitDevice', actor: 8, newId: 9, kind: 'personal', canManage: true },
      async () => ({
        signer: plainRecovery,
        operation: {
          type: 'admitDevice',
          kind: 'personal',
          signingPublicKey: granted.publicKey,
          encryptionPublicKey: granted.enc,
          canManage: true,
          possessionSignature: await granted.sign(
            possessionSigningBytes({
              genesis: anchor,
              targetMembershipId: plainMembership,
              signingPublicKey: granted.publicKey,
              encryptionPublicKey: granted.enc,
              kind: 'personal',
              canManage: true,
            })
          ),
        },
      })
    );

    await apply({ type: 'setRoleGuest', actor: 6, target: 7 }, async () => ({
      signer: plain,
      operation: { type: 'setRole', membershipId: plainMembership, role: 'guest' },
    }));
    await apply({ type: 'setRoleGuest', actor: 0, target: 7 }, async () => ({
      signer: owner,
      operation: { type: 'setRole', membershipId: plainMembership, role: 'guest' },
    }));
    const guestMachine = await device();
    devices.set(10, guestMachine);
    await apply(
      { type: 'admitDevice', actor: 6, newId: 10, kind: 'machine', canManage: false },
      async () => ({
        signer: plain,
        operation: {
          type: 'admitDevice',
          kind: 'machine',
          signingPublicKey: guestMachine.publicKey,
          encryptionPublicKey: guestMachine.enc,
          canManage: false,
          possessionSignature: await guestMachine.sign(
            possessionSigningBytes({
              genesis: anchor,
              targetMembershipId: plainMembership,
              signingPublicKey: guestMachine.publicKey,
              encryptionPublicKey: guestMachine.enc,
              kind: 'machine',
              canManage: false,
            })
          ),
        },
      }),
      'unauthorized'
    );

    await apply({ type: 'removeMember', actor: 0, target: 7 }, async () => ({
      signer: owner,
      operation: { type: 'removeMember', membershipId: plainMembership },
    }));
    const rejoined = await device();
    devices.set(11, rejoined);
    const rejoinRequest = {
      requestId: random(16),
      userId: random(32),
      signingPublicKey: rejoined.publicKey,
      encryptionPublicKey: rejoined.enc,
      expiresAt: null as number | null,
    };
    await apply(
      { type: 'admitMember', actor: 0, newMember: 7, firstDevice: 11 },
      async () => ({
        signer: owner,
        operation: {
          type: 'admitMember',
          membershipId: plainMembership,
          request: {
            ...rejoinRequest,
            signature: await rejoined.sign(joinRequestSigningBytes(anchor, rejoinRequest)),
          },
        },
      }),
      'replay'
    );

    await apply({ type: 'transferOwner', actor: 6, successor: 0 }, async () => ({
      signer: plain,
      operation: { type: 'transferOwner', successorMembershipId: ownerMembership },
    }));
    await apply({ type: 'transferOwner', actor: 0, successor: 2 }, async () => ({
      signer: owner,
      operation: { type: 'transferOwner', successorMembershipId: memberMembership },
    }));
    await apply({ type: 'transferOwner', actor: 0, successor: 0 }, async () => ({
      signer: owner,
      operation: { type: 'transferOwner', successorMembershipId: ownerMembership },
    }));

    await apply({ type: 'removeMember', actor: 0, target: 0 }, async () => ({
      signer: owner,
      operation: { type: 'removeMember', membershipId: ownerMembership },
    }));
    await apply(
      { type: 'removeMember', actor: 0, target: 2 },
      async () => ({
        signer: owner,
        operation: { type: 'removeMember', membershipId: memberMembership },
      }),
      'unauthorized'
    );

    expect(snapshots.length).toBe(leanLines.length);
    if (LEAN_ROOT) {
      const leanExe = runLeanTrace(leanLines);
      expect(leanExe).toHaveLength(snapshots.length);
      for (let i = 0; i < leanExe.length; i++) {
        const exe = leanExe[i]!;
        const snap = snapshots[i]!;
        expect(exe.ok, leanLines[i]).toBe(snap.ok);
        if (!exe.ok) continue;
        const ownerId = memberships.get(exe.state.owner);
        expect(ownerId, `owner ${exe.state.owner}`).toBeDefined();
        expect(hex(snap.ledger.state.owner)).toBe(hex(ownerId!));
        expect(snap.ledger.state.epoch.number).toBe(exe.state.epoch);
        expect(snap.ledger.state.members.size).toBe(exe.state.members.length);
        for (const [id, role] of exe.state.members) {
          const membership = memberships.get(id);
          expect(membership, `member ${id}`).toBeDefined();
          expect(snap.ledger.state.members.get(hex(membership!))?.role).toBe(role);
        }
        expect(snap.ledger.state.devices.size).toBe(exe.state.devices.length);
        for (const [id, deviceRow] of exe.state.devices) {
          const keys = devices.get(id);
          expect(keys, `device ${id}`).toBeDefined();
          const row = snap.ledger.state.devices.get(hex(keys!.publicKey));
          expect(row?.kind).toBe(deviceRow.kind);
          expect(row?.canManage).toBe(deviceRow.canManage);
          const memberId = memberships.get(deviceRow.memberId);
          expect(memberId, `device-member ${deviceRow.memberId}`).toBeDefined();
          expect(hex(row!.membershipId)).toBe(hex(memberId!));
        }
      }
    }

    const full = await Ledger.verify({ anchor, records });
    expect(full.head).toEqual(ledger.head);
    for (let split = 1; split < records.length; split++) {
      const prefix = await Ledger.verify({ anchor, records: records.slice(0, split) });
      const extended = await prefix.extend(records.slice(split));
      expect(extended.head, `split ${split}`).toEqual(full.head);
      expect(extended.state.epoch.number).toBe(full.state.epoch.number);
      expect(extended.state.members.size).toBe(full.state.members.size);
      expect(extended.state.devices.size).toBe(full.state.devices.size);
    }
  });
});
