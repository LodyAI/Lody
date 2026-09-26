import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

/** The Lean model must use role-derived management (no per-device `canManage`) to
 * correspond with this ledger. A stale sibling checkout is skipped visibly; an
 * explicitly configured stale model is a hard error. */
function freshLeanRoot(): { root: string | null; stale: boolean } {
  const root = resolveLeanRoot();
  if (!root) return { root: null, stale: false };
  const stale = /\bcanManage\b/.test(readFileSync(join(root, 'E2EE.lean'), 'utf8'));
  if (stale && process.env.LODY_E2EE_LEAN) {
    throw new Error(`LODY_E2EE_LEAN=${root} still models per-device canManage`);
  }
  return { root: stale ? null : root, stale };
}

const { root: LEAN_ROOT, stale: LEAN_STALE } = freshLeanRoot();

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
      return `admitDevice ${op.actor} ${op.newId} ${op.kind}`;
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
  devices: Array<[number, { memberId: number; kind: 'personal' | 'machine' | 'recovery' }]>;
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
      const fields = part.split(':');
      const [id, memberId, kind] = fields;
      if (fields.length !== 3 || !id || !memberId || !kind) {
        throw new Error(`bad-lean-device:${part}`);
      }
      if (kind !== 'personal' && kind !== 'machine' && kind !== 'recovery') {
        throw new Error(`bad-lean-kind:${kind}`);
      }
      devices.push([Number(id), { memberId: Number(memberId), kind }]);
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

type Snapshot = { ledger: Awaited<ReturnType<typeof Ledger.verify>>; ok: boolean };

/** Drives one synthetic trace through both the TS oracle and the public Ledger API. */
async function runTrace() {
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
  const snapshots: Snapshot[] = [];

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

  const signerOf = (id: number) => {
    const keys = devices.get(id);
    if (!keys) throw new Error(`unknown-device:${id}`);
    return keys;
  };
  const membershipOf = (id: number) => {
    const membership = memberships.get(id);
    if (!membership) throw new Error(`unknown-member:${id}`);
    return membership;
  };

  /** admitDevice step; the possession proof binds the actor's membership. */
  async function admitDevice(
    actor: number,
    newId: number,
    memberId: number,
    kind: 'personal' | 'machine' | 'recovery',
    expectedCode?: LedgerErrorCode
  ) {
    if (!devices.has(newId)) devices.set(newId, await device());
    const target = signerOf(newId);
    await apply(
      { type: 'admitDevice', actor, newId, kind },
      async () => ({
        signer: signerOf(actor),
        operation: {
          type: 'admitDevice',
          kind,
          signingPublicKey: target.publicKey,
          encryptionPublicKey: target.enc,
          possessionSignature: await target.sign(
            possessionSigningBytes({
              genesis: anchor,
              targetMembershipId: membershipOf(memberId),
              signingPublicKey: target.publicKey,
              encryptionPublicKey: target.enc,
              kind,
            })
          ),
        },
      }),
      expectedCode
    );
  }

  async function publishEpoch(actor: number, expectedCode?: LedgerErrorCode) {
    await apply(
      { type: 'publishEpoch', actor },
      async () => ({
        signer: signerOf(actor),
        operation: {
          type: 'publishEpoch',
          epoch: ledger.state.epoch.number + 1,
          commitment: await commitEpochKey(anchor, ledger.state.epoch.number + 1, random(32)),
          previousEpochKey: random(HISTORY_PACKET_BYTES),
        },
      }),
      expectedCode
    );
  }

  async function setRole(
    actor: number,
    target: number,
    role: 'admin' | 'member' | 'guest',
    expectedCode?: LedgerErrorCode
  ) {
    const type =
      role === 'admin' ? 'setRoleAdmin' : role === 'member' ? 'setRoleMember' : 'setRoleGuest';
    await apply(
      { type, actor, target },
      async () => ({
        signer: signerOf(actor),
        operation: { type: 'setRole', membershipId: membershipOf(target), role },
      }),
      expectedCode
    );
  }

  async function admitMember(
    actor: number,
    newMember: number,
    firstDevice: number,
    expectedCode?: LedgerErrorCode
  ) {
    if (!devices.has(firstDevice)) devices.set(firstDevice, await device());
    if (!memberships.has(newMember)) memberships.set(newMember, random(16));
    const applicant = signerOf(firstDevice);
    const request = {
      requestId: random(16),
      userId: random(32),
      signingPublicKey: applicant.publicKey,
      encryptionPublicKey: applicant.enc,
      expiresAt: null as number | null,
    };
    const signature = await applicant.sign(joinRequestSigningBytes(anchor, request));
    await apply(
      { type: 'admitMember', actor, newMember, firstDevice },
      async () => ({
        signer: signerOf(actor),
        operation: {
          type: 'admitMember',
          membershipId: membershipOf(newMember),
          request: { ...request, signature },
        },
      }),
      expectedCode
    );
  }

  // Member 2 joins with personal device 1; as a Member it cannot manage.
  await admitMember(0, 2, 1);
  await publishEpoch(1, 'unauthorized');
  // Promotion: device 1, admitted before promotion, manages immediately.
  await setRole(0, 2, 'admin');
  await publishEpoch(1);
  await admitMember(1, 12, 13);
  await admitDevice(1, 3, 2, 'personal');
  await publishEpoch(3);
  // An Admin's machine never manages.
  await admitDevice(1, 14, 2, 'machine');
  await publishEpoch(14, 'unauthorized');
  await admitMember(14, 15, 16, 'unauthorized');

  // The Owner's recovery device never manages.
  await admitDevice(0, 4, 0, 'recovery');
  await publishEpoch(4, 'unauthorized');
  await admitMember(4, 15, 16, 'unauthorized');
  // Only the Owner removes members.
  await apply(
    { type: 'removeMember', actor: 3, target: 2 },
    async () => ({
      signer: signerOf(3),
      operation: { type: 'removeMember', membershipId: membershipOf(2) },
    }),
    'unauthorized'
  );

  // Revoked device keys are retired and cannot be re-admitted.
  await admitDevice(0, 5, 0, 'personal');
  await apply({ type: 'revokeDevice', actor: 0, target: 5 }, async () => ({
    signer: owner,
    operation: { type: 'revokeDevice', target: signerOf(5).publicKey },
  }));
  await admitDevice(0, 5, 0, 'personal');

  // Member 7: its recovery device admits a personal device that still cannot manage.
  await admitMember(0, 7, 6);
  await admitDevice(6, 8, 7, 'recovery');
  await admitDevice(8, 9, 7, 'personal');
  await publishEpoch(9, 'unauthorized');
  await setRole(6, 7, 'guest');
  await setRole(0, 7, 'guest');
  await admitDevice(6, 10, 7, 'machine', 'unauthorized');

  // Demotion: the former Admin's personal devices lose management immediately.
  await setRole(0, 2, 'member');
  await publishEpoch(1, 'unauthorized');
  await publishEpoch(3, 'unauthorized');
  await admitMember(3, 15, 16, 'unauthorized');

  await apply({ type: 'removeMember', actor: 0, target: 7 }, async () => ({
    signer: owner,
    operation: { type: 'removeMember', membershipId: membershipOf(7) },
  }));
  await admitMember(0, 7, 11, 'replay');

  await apply({ type: 'transferOwner', actor: 6, successor: 0 }, async () => ({
    signer: signerOf(6),
    operation: { type: 'transferOwner', successorMembershipId: ownerMembership },
  }));
  await apply({ type: 'transferOwner', actor: 0, successor: 2 }, async () => ({
    signer: owner,
    operation: { type: 'transferOwner', successorMembershipId: membershipOf(2) },
  }));
  // The successor's existing device manages as Owner; the predecessor keeps Admin rights.
  await publishEpoch(1);
  await publishEpoch(0);
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
      operation: { type: 'removeMember', membershipId: membershipOf(2) },
    }),
    'unauthorized'
  );

  expect(snapshots.length).toBe(leanLines.length);
  return { anchor, records, ledger, devices, memberships, snapshots, leanLines };
}

describe('M3 Lean model ↔ public Ledger API', () => {
  it('accepts and rejects the same synthetic trace as the model step, including broken guards', async () => {
    const { anchor, records, ledger } = await runTrace();
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

  it.skipIf(!LEAN_ROOT)(
    `matches the Lean executable step state-by-state${LEAN_STALE ? ' (skipped: Lean model still has per-device canManage)' : ''}`,
    async () => {
      const { devices, memberships, snapshots, leanLines } = await runTrace();
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
          const memberId = memberships.get(deviceRow.memberId);
          expect(memberId, `device-member ${deviceRow.memberId}`).toBeDefined();
          expect(hex(row!.membershipId)).toBe(hex(memberId!));
        }
      }
    }
  );
});
