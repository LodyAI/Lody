import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Ledger, LedgerError } from '@lody/e2ee-core';
import { Ledger as LedgerAgain } from '@lody/e2ee-core';
import {
  LedgerClient,
  MemoryLedgerStore,
  MemoryLedgerStream,
  collectEpochPackets,
  commitEpochKey,
  decodeRecord,
  encodeGenesisBody,
  encodeSignedRecord,
  hashRecord,
  joinRequestSigningBytes,
  openEpochEnvelope,
  possessionSigningBytes,
  recoverHistory,
  sealEpochEnvelope,
  sealHistoryPacket,
  signingBytesForBody,
  type JoinRequest,
  type Operation,
} from '@lody/e2ee-core/ledger';
import { SqliteLedgerStore } from '@lody/e2ee-core/ledger-node';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Device = {
  publicKey: Uint8Array;
  enc: Uint8Array;
  dh: CryptoKeyPair;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
};

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
}

function random(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function pkgVersion(name: string): string {
  let dir = fileURLToPath(new URL('.', import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'node_modules', ...name.split('/'), 'package.json');
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === name && typeof pkg.version === 'string') return pkg.version;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`installed-version-missing:${name}`);
}

async function device(): Promise<Device> {
  const sign = (await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', sign.publicKey));
  const dh = (await crypto.subtle.generateKey('X25519', false, ['deriveBits'])) as CryptoKeyPair;
  const enc = new Uint8Array(await crypto.subtle.exportKey('raw', dh.publicKey));
  return {
    publicKey,
    enc,
    dh,
    async sign(bytes: Uint8Array) {
      const message = new Uint8Array(bytes.byteLength);
      message.set(bytes);
      return new Uint8Array(await crypto.subtle.sign('Ed25519', sign.privateKey, message));
    },
  };
}

async function joinRequest(genesis: Uint8Array, applicant: Device): Promise<JoinRequest> {
  const request = {
    requestId: random(16),
    userId: random(32),
    signingPublicKey: applicant.publicKey,
    encryptionPublicKey: applicant.enc,
    expiresAt: null as number | null,
  };
  return {
    ...request,
    signature: await applicant.sign(joinRequestSigningBytes(genesis, request)),
  };
}

async function admitDevice(
  genesis: Uint8Array,
  target: Device,
  kind: 'personal' | 'machine' | 'recovery',
  canManage: boolean
): Promise<Extract<Operation, { type: 'admitDevice' }>> {
  return {
    type: 'admitDevice',
    kind,
    signingPublicKey: target.publicKey,
    encryptionPublicKey: target.enc,
    canManage,
    possessionSignature: await target.sign(
      possessionSigningBytes({
        genesis,
        signingPublicKey: target.publicKey,
        encryptionPublicKey: target.enc,
        kind,
        canManage,
      })
    ),
  };
}

function membershipId(ledger: Awaited<ReturnType<typeof Ledger.verify>>, userId: Uint8Array) {
  const want = hex(userId);
  for (const [id, member] of ledger.state.members) {
    if (hex(member.userId) === want) return fromHex(id);
  }
  throw new Error('membership-not-found');
}

async function commit(
  client: LedgerClient,
  signer: Device,
  operation: Operation
): Promise<Uint8Array> {
  const view = await client.read();
  const proposal = view.prepare(operation, signer.publicKey);
  const record = await view.finalize(proposal, await signer.sign(proposal.signingBytes));
  const result = await client.submit(record);
  expect(result.status).toBe('committed');
  return record;
}

describe('C2 public-package black-box consumer', () => {
  it('creates, joins, syncs, revokes, rotates, recovers, restarts and reconciles', async () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const specifiers = [...source.matchAll(/\bfrom '([^']+)'/g)].map((match) => match[1]!);
    expect(specifiers.length).toBeGreaterThan(5);
    expect(specifiers.some((value) => value.startsWith('../src') || value.includes('src/'))).toBe(
      false
    );
    expect(specifiers.some((value) => value.includes('ledger-fixtures'))).toBe(false);
    expect(specifiers.some((value) => value.includes(['@lody', 'convex'].join('/')))).toBe(false);
    expect(specifiers.filter((value) => value === '@lody/e2ee-core')).toHaveLength(2);
    expect(specifiers).toContain('@lody/e2ee-core/ledger');
    expect(specifiers).toContain('@lody/e2ee-core/ledger-node');
    expect(LedgerAgain).toBe(Ledger);
    const publicRoot = await import('@lody/e2ee-core');
    const publicLedger = await import('@lody/e2ee-core/ledger');
    expect(publicRoot).not.toHaveProperty('HistoryPublisher');
    expect(publicRoot).not.toHaveProperty('EpochPublisher');
    expect(publicRoot).not.toHaveProperty('replayChain');
    expect(publicRoot).not.toHaveProperty('encodeRecord');
    expect(publicRoot).not.toHaveProperty('KeyDelivery');
    expect(publicLedger).not.toHaveProperty('RECOVERY_WRAP_DOMAIN');
    expect(publicRoot).toHaveProperty('Ledger');
    expect(publicRoot).toHaveProperty('ContentCipher');
    expect(pkgVersion('@noble/ed25519')).toBe('3.2.0');
    expect(pkgVersion('@noble/ciphers')).toBe('2.1.1');
    expect(pkgVersion('@ipld/dag-cbor')).toBe('10.0.2');
    expect(pkgVersion('@hpke/core')).toBe('1.9.0');
    expect(pkgVersion('@hpke/chacha20poly1305')).toBe('1.8.0');
    expect(pkgVersion('@loro-dev/streams-crdt').length).toBeGreaterThan(0);
    expect(existsSync(fileURLToPath(new URL('./control-log.test.ts', import.meta.url)))).toBe(true);
    expect(existsSync(fileURLToPath(new URL('./team.test.ts', import.meta.url)))).toBe(true);

    const owner = await device();
    const k0 = random(32);
    const userId = random(32);
    const ownerMembership = random(16);
    const genesisBody = encodeGenesisBody({
      signer: owner.publicKey,
      userId,
      membershipId: ownerMembership,
      encryptionPublicKey: owner.enc,
      epochCommitment: await commitEpochKey(new Uint8Array(32), 0, k0),
    });
    const genesis = encodeSignedRecord(
      genesisBody,
      await owner.sign(signingBytesForBody(genesisBody))
    );
    const anchor = await hashRecord(genesis);
    const created = await Ledger.verify({ anchor, records: [genesis] });
    expect(created.length).toBe(1);
    expect(created.state.members.size).toBe(1);

    const dir = mkdtempSync(join(tmpdir(), 'lody-e2ee-c2-'));
    dirs.push(dir);
    const journal = join(dir, 'ledger.sqlite');
    const stream = new MemoryLedgerStream();
    stream.pageSize = 2;
    const leader = await LedgerClient.open(genesis, new SqliteLedgerStore(journal), stream);
    const followerStore = new MemoryLedgerStore();
    const follower = await LedgerClient.open(genesis, followerStore, stream);

    const member = await device();
    const memberJoin = await joinRequest(anchor, member);
    await commit(leader, owner, {
      type: 'admitMember',
      membershipId: random(16),
      request: memberJoin,
    });
    const afterJoin = await follower.read();
    expect(afterJoin.length).toBe(2);
    expect(afterJoin.head).toEqual((await leader.read()).head);
    expect(afterJoin.state.members.size).toBe(2);
    const stale = afterJoin;

    const recovery = await device();
    await commit(leader, owner, await admitDevice(anchor, recovery, 'recovery', false));
    const phone = await device();
    await commit(leader, owner, await admitDevice(anchor, phone, 'personal', true));
    await commit(leader, owner, { type: 'revokeDevice', target: phone.publicKey });
    const afterRevoke = await leader.read();
    expect(afterRevoke.state.devices.has(hex(phone.publicKey))).toBe(false);
    expect(afterRevoke.state.devices.has(hex(recovery.publicKey))).toBe(true);

    const memberId = membershipId(afterRevoke, memberJoin.userId);
    await commit(leader, owner, { type: 'removeMember', membershipId: memberId });
    const afterRemove = await leader.read();
    expect(afterRemove.state.members.size).toBe(1);
    expect(afterRemove.state.devices.has(hex(member.publicKey))).toBe(false);

    const k1 = random(32);
    await commit(leader, owner, {
      type: 'publishEpoch',
      epoch: 1,
      commitment: await commitEpochKey(anchor, 1, k1),
      previousEpochKey: sealHistoryPacket(k1, k0, anchor, 1),
    });

    const laptop = await device();
    await commit(leader, recovery, await admitDevice(anchor, laptop, 'personal', true));
    const recoveredView = await leader.read();
    expect(recoveredView.state.devices.get(hex(laptop.publicKey))?.kind).toBe('personal');
    expect(recoveredView.state.devices.get(hex(laptop.publicKey))?.canManage).toBe(true);

    const genesisDecoded = decodeRecord(genesis);
    if (genesisDecoded.body.type !== 'genesis') throw new Error('not-genesis');
    const records = (await new SqliteLedgerStore(journal).exclusive((tx) => tx.load()))!.records;
    const history = await recoverHistory({
      genesis: anchor,
      latestEpoch: 1,
      latestKey: k1,
      packets: collectEpochPackets(records, genesisDecoded.body.fields.epochCommitment),
    });
    expect(history.get(0)).toEqual(k0);
    expect(history.get(1)).toEqual(k1);

    const frame = await sealEpochEnvelope({
      state: recoveredView.state,
      genesis: anchor,
      epoch: 1,
      sender: owner.publicKey,
      recipient: laptop.publicKey,
      recipientEncryptionKey: laptop.enc,
      epochKey: k1,
      sign: (bytes) => owner.sign(bytes),
    });
    expect(
      await openEpochEnvelope({
        state: recoveredView.state,
        genesis: anchor,
        epoch: 1,
        sender: owner.publicKey,
        recipient: laptop.publicKey,
        recipientKeyPair: laptop.dh,
        frame,
      })
    ).toEqual(k1);

    const restarted = await LedgerClient.open(genesis, new SqliteLedgerStore(journal), stream);
    const restartedView = await restarted.read();
    expect(restartedView.head).toEqual(recoveredView.head);
    expect(restartedView.length).toBe(recoveredView.length);
    const independent = await LedgerAgain.verify({ anchor, records });
    expect(independent.head).toEqual(restartedView.head);
    expect(independent.state.devices.size).toBe(restartedView.state.devices.size);

    const caught = await follower.read();
    expect(caught.head).toEqual(recoveredView.head);
    expect(followerStore.journal?.offset.startsWith('opaque:')).toBe(true);
    for (let i = 0; i < recoveredView.length; i++) {
      expect(caught.hashAt(i)).toEqual(recoveredView.hashAt(i));
    }

    const stranger = await device();
    const competing = await admitDevice(anchor, stranger, 'personal', false);
    const proposal = stale.prepare(competing, owner.publicKey);
    const fork = await stale.finalize(proposal, await owner.sign(proposal.signingBytes));
    const conflict = await follower.submit(fork);
    expect(conflict.status).toBe('conflict');
    expect(conflict.ledger.head).toEqual(recoveredView.head);
    expect(conflict.ledger.state.devices.has(hex(stranger.publicKey))).toBe(false);

    const successor = await device();
    const successorJoin = await joinRequest(anchor, successor);
    await commit(leader, owner, {
      type: 'admitMember',
      membershipId: random(16),
      request: successorJoin,
    });
    const successorId = membershipId(await leader.read(), successorJoin.userId);
    await commit(leader, owner, {
      type: 'transferOwner',
      successorMembershipId: successorId,
    });
    const afterTransfer = await leader.read();
    expect(hex(afterTransfer.state.owner)).toBe(hex(successorId));
    expect(afterTransfer.state.members.get(hex(ownerMembership))?.role).toBe('admin');
    expect(afterTransfer.state.members.get(hex(successorId))?.role).toBe('owner');
    try {
      await commit(leader, owner, {
        type: 'removeMember',
        membershipId: successorId,
      });
      throw new Error('predecessor-removed-owner');
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerError);
      expect((error as LedgerError).code).toBe('unauthorized');
    }

    try {
      await commit(leader, member, await admitDevice(anchor, await device(), 'personal', false));
      throw new Error('removed-member-admitted');
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerError);
      expect((error as LedgerError).code).toBe('unauthorized');
    }
  });

  it('bootstraps from a signed snapshot using only public exports', async () => {
    const owner = await device();
    const k0 = random(32);
    const userId = random(32);
    const ownerMembership = random(16);
    const commitment = await commitEpochKey(new Uint8Array(32), 0, k0);
    const body = encodeGenesisBody({
      signer: owner.publicKey,
      userId,
      membershipId: ownerMembership,
      encryptionPublicKey: owner.enc,
      epochCommitment: commitment,
    });
    const genesis = encodeSignedRecord(body, await owner.sign(signingBytesForBody(body)));
    const anchor = await hashRecord(genesis);
    const audited = await Ledger.verify({ anchor, records: [genesis] });
    const proposal = audited.prepareSnapshot(owner.publicKey);
    const snapshot = await Ledger.finalizeSnapshot(
      proposal,
      await owner.sign(proposal.signingBytes)
    );
    const joined = await Ledger.verifySnapshot({
      trust: {
        genesis: proposal.genesis,
        endorser: owner.publicKey,
        head: proposal.head,
        headSignature: await owner.sign(proposal.headAttestationSigningBytes),
      },
      snapshot,
    });
    expect(joined.origin).toBe('snapshot');
    const peer = await device();
    const other = await device();
    const cmp = Ledger.compareNotes(
      joined.comparisonNote(peer.publicKey),
      audited.comparisonNote(other.publicKey),
      { originalEndorser: owner.publicKey, confirmedNoteSigners: [other.publicKey] }
    );
    expect(cmp.kind).toBe('agree');
    if (cmp.kind === 'agree') expect(cmp.independent).toBe(true);
  });
});
