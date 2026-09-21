import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import {
  InMemoryRemoteCursorStore,
  StreamsCrdt,
  createLoroDocAdapter,
} from '@loro-dev/streams-crdt/loro';
import {
  ContentCipher,
  Ledger,
  LedgerError,
  createRecoveryFile,
  openRecoveryBackup,
  sealRecoveryBackup,
} from '@lody/e2ee-core';
import {
  LedgerClient,
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
import { createStreamsContentProvider } from '@lody/e2ee-core/streams-content';

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

async function genesis(owner: Device, secret: Uint8Array) {
  const body = encodeGenesisBody({
    signer: owner.publicKey,
    userId: random(32),
    membershipId: random(16),
    encryptionPublicKey: owner.enc,
    epochCommitment: await commitEpochKey(new Uint8Array(32), 0, secret),
  });
  const record = encodeSignedRecord(body, await owner.sign(signingBytesForBody(body)));
  const anchor = await hashRecord(record);
  const ledger = await Ledger.verify({ anchor, records: [record] });
  return { record, anchor, ledger, secret };
}

async function joinRequest(genesisHash: Uint8Array, applicant: Device): Promise<JoinRequest> {
  const request = {
    requestId: random(16),
    userId: random(32),
    signingPublicKey: applicant.publicKey,
    encryptionPublicKey: applicant.enc,
    expiresAt: null as number | null,
  };
  return {
    ...request,
    signature: await applicant.sign(joinRequestSigningBytes(genesisHash, request)),
  };
}

async function admitDevice(
  genesisHash: Uint8Array,
  targetMembershipId: Uint8Array,
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
        genesis: genesisHash,
        targetMembershipId: targetMembershipId,
        signingPublicKey: target.publicKey,
        encryptionPublicKey: target.enc,
        kind,
        canManage,
      })
    ),
  };
}

async function append(
  ledger: Awaited<ReturnType<typeof Ledger.verify>>,
  signer: Device,
  operation: Operation
) {
  const proposal = ledger.prepare(operation, signer.publicKey);
  const record = await ledger.finalize(proposal, await signer.sign(proposal.signingBytes));
  return { ledger: await ledger.extend([record]), record };
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(LedgerError);
  expect((error as LedgerError).code).toBe(code);
}

function response(body: Uint8Array, nextOffset = 'tail', upToDate = true) {
  return new Response(new Uint8Array(body).buffer, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Stream-Next-Offset': nextOffset,
      'Stream-Up-To-Date': upToDate ? 'true' : 'false',
    },
  });
}

describe('P3 public-export K/R/C loop', () => {
  it('wraps keys, enforces recovery bounds, and decrypts content without src imports', async () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const specifiers = [...source.matchAll(/\bfrom '([^']+)'/g)].map((match) => match[1]!);
    expect(
      specifiers.some((value) => value.includes('../src') || value.includes('ledger-fixtures'))
    ).toBe(false);
    expect(specifiers).toContain('@lody/e2ee-core');
    expect(specifiers).toContain('@lody/e2ee-core/ledger');
    expect(specifiers).toContain('@lody/e2ee-core/ledger-node');
    expect(specifiers).toContain('@lody/e2ee-core/streams-content');
    expect(specifiers.filter((value) => value === '@lody/e2ee-core').length).toBeGreaterThanOrEqual(
      1
    );

    const owner = await device();
    const k0 = random(32);
    const created = await genesis(owner, k0);
    const records = [created.record];
    let ledger = created.ledger;

    const phoneA = await device();
    const admittedA = await append(
      ledger,
      owner,
      await admitDevice(created.anchor, created.ledger.state.owner, phoneA, 'personal', true)
    );
    records.push(admittedA.record);
    ledger = admittedA.ledger;
    const laptopC = await device();
    const admittedC = await append(
      ledger,
      phoneA,
      await admitDevice(created.anchor, created.ledger.state.owner, laptopC, 'personal', false)
    );
    records.push(admittedC.record);
    ledger = admittedC.ledger;
    const recovery = await device();
    const admittedR = await append(
      ledger,
      owner,
      await admitDevice(created.anchor, created.ledger.state.owner, recovery, 'recovery', false)
    );
    records.push(admittedR.record);
    ledger = admittedR.ledger;

    await expect(
      sealEpochEnvelope({
        state: created.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phoneA.publicKey,
        recipientEncryptionKey: phoneA.enc,
        epochKey: k0,
        sign: (bytes) => owner.sign(bytes),
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });

    const frameA = await sealEpochEnvelope({
      state: ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phoneA.publicKey,
      recipientEncryptionKey: phoneA.enc,
      epochKey: k0,
      sign: (bytes) => owner.sign(bytes),
    });
    expect(
      await openEpochEnvelope({
        state: ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phoneA.publicKey,
        recipientKeyPair: phoneA.dh,
        frame: frameA,
      })
    ).toEqual(k0);

    const keys = [k0];
    for (let epoch = 1; epoch <= 3; epoch++) {
      const next = random(32);
      const published = await append(ledger, owner, {
        type: 'publishEpoch',
        epoch,
        commitment: await commitEpochKey(created.anchor, epoch, next),
        previousEpochKey: sealHistoryPacket(next, keys[epoch - 1]!, created.anchor, epoch),
      });
      records.push(published.record);
      ledger = published.ledger;
      keys.push(next);
    }
    const genesisBody = decodeRecord(created.record);
    if (genesisBody.body.type !== 'genesis') throw new Error('not-genesis');
    const packets = collectEpochPackets(records, genesisBody.body.fields.epochCommitment);
    const recovered = await recoverHistory({
      genesis: created.anchor,
      latestEpoch: 3,
      latestKey: keys[3]!,
      packets,
    });
    expect([...recovered.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    for (let epoch = 0; epoch <= 3; epoch++) expect(recovered.get(epoch)).toEqual(keys[epoch]);

    const identity = hex(created.anchor);
    const recoveryFile = createRecoveryFile();
    const sealedLatest = new Uint8Array(keys[3]!);
    const recoveryBackup = sealRecoveryBackup(
      recoveryFile,
      { identity, revision: 1 },
      sealedLatest
    );
    sealedLatest.fill(0);
    keys[3]!.fill(0);
    expect(() =>
      openRecoveryBackup(recoveryFile, { identity: '00'.repeat(32), revision: 1 }, recoveryBackup)
    ).toThrow();
    const openedLatest = openRecoveryBackup(
      recoveryFile,
      { identity, revision: 1 },
      recoveryBackup
    );
    expect(openedLatest).toEqual(recovered.get(3));

    const dir = mkdtempSync(join(tmpdir(), 'lody-e2ee-krc-'));
    dirs.push(dir);
    const journal = join(dir, 'ledger.sqlite');
    const stream = new MemoryLedgerStream();
    const persisted = await LedgerClient.open(
      created.record,
      new SqliteLedgerStore(journal),
      stream
    );
    for (const record of records.slice(1)) {
      expect((await persisted.submit(record)).status).toBe('committed');
    }
    const restarted = await LedgerClient.open(
      created.record,
      new SqliteLedgerStore(journal),
      stream
    );
    const restartedView = await restarted.read();
    expect(restartedView.head).toEqual(ledger.head);
    expect(restartedView.length).toBe(records.length);
    const loaded = (await new SqliteLedgerStore(journal).exclusive((tx) => tx.load()))!.records;
    const recoveredAfterRestart = await recoverHistory({
      genesis: created.anchor,
      latestEpoch: 3,
      latestKey: openedLatest,
      packets: collectEpochPackets(loaded, genesisBody.body.fields.epochCommitment),
    });
    expect(recoveredAfterRestart.get(0)).toEqual(k0);
    expect(recoveredAfterRestart.get(3)).toEqual(openedLatest);
    await expect(
      recoverHistory({
        genesis: created.anchor,
        latestEpoch: 3,
        latestKey: keys[0]!,
        packets,
      })
    ).rejects.toBeInstanceOf(LedgerError);
    const broken = new Map(packets);
    const tampered = new Uint8Array(packets.get(2)!.packet);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    broken.set(2, { ...packets.get(2)!, packet: tampered });
    await expect(
      recoverHistory({
        genesis: created.anchor,
        latestEpoch: 3,
        latestKey: openedLatest,
        packets: broken,
      })
    ).rejects.toBeInstanceOf(LedgerError);

    const revokedA = await append(ledger, owner, {
      type: 'revokeDevice',
      target: phoneA.publicKey,
    });
    ledger = revokedA.ledger;
    records.push(revokedA.record);
    expect(ledger.state.devices.has(hex(phoneA.publicKey))).toBe(false);
    expect(ledger.state.devices.has(hex(laptopC.publicKey))).toBe(true);
    expect(ledger.state.devices.has(hex(recovery.publicKey))).toBe(true);
    await expect(
      sealEpochEnvelope({
        state: ledger.state,
        genesis: created.anchor,
        epoch: 3,
        sender: owner.publicKey,
        recipient: phoneA.publicKey,
        recipientEncryptionKey: phoneA.enc,
        epochKey: openedLatest,
        sign: (bytes) => owner.sign(bytes),
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      append(ledger, recovery, {
        type: 'publishEpoch',
        epoch: 4,
        commitment: await commitEpochKey(created.anchor, 4, random(32)),
        previousEpochKey: random(72),
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });

    const member = await device();
    const joined = await append(ledger, owner, {
      type: 'admitMember',
      membershipId: random(16),
      request: await joinRequest(created.anchor, member),
    });
    ledger = joined.ledger;
    records.push(joined.record);
    const memberR = await device();
    const withMemberR = await append(
      ledger,
      member,
      await admitDevice(
        created.anchor,
        ledger.state.devices.get(hex(member.publicKey))!.membershipId,
        memberR,
        'recovery',
        false
      )
    );
    ledger = withMemberR.ledger;
    records.push(withMemberR.record);
    await expect(
      append(
        ledger,
        memberR,
        await admitDevice(
          created.anchor,
          ledger.state.devices.get(hex(memberR.publicKey))!.membershipId,
          await device(),
          'personal',
          true
        )
      )
    ).rejects.toMatchObject({ code: 'unauthorized' });
    const memberC = await append(
      ledger,
      memberR,
      await admitDevice(
        created.anchor,
        ledger.state.devices.get(hex(memberR.publicKey))!.membershipId,
        await device(),
        'personal',
        false
      )
    );
    ledger = memberC.ledger;
    records.push(memberC.record);

    const restored = await append(
      ledger,
      recovery,
      await admitDevice(
        created.anchor,
        created.ledger.state.owner,
        await device(),
        'personal',
        true
      )
    );
    ledger = restored.ledger;
    records.push(restored.record);

    const otherOwner = await device();
    const orgY = await genesis(otherOwner, random(32));
    try {
      await append(
        orgY.ledger,
        recovery,
        await admitDevice(orgY.anchor, orgY.ledger.state.owner, await device(), 'personal', false)
      );
      throw new Error('cross-org-recovery');
    } catch (error) {
      expectCode(error, 'unauthorized');
    }
    expect(orgY.ledger.state.devices.size).toBe(1);

    const pair = (await crypto.subtle.generateKey('Ed25519', false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const signingPublic = hex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
    const author = { actor: 'owner', memberInstance: 'm0', device: 'd0' };
    const provider = (readKey: (epoch: number) => Uint8Array | undefined, writeEpoch = 3) =>
      createStreamsContentProvider({
        cipher: new ContentCipher({
          authorize(header) {
            if (header.actor !== author.actor) throw new Error('unauthorized');
            return signingPublic;
          },
        }),
        genesis: hex(created.anchor),
        resource: 'doc-1',
        model: 'loro',
        writeEpoch,
        author,
        signingKey: pair.privateKey,
        readKey,
      });
    const url = 'https://synthetic.example.test/ds/krc';
    const writer = new LoroDoc();
    let body = new Uint8Array();
    const write = new StreamsCrdt({
      streamUrl: url,
      adapter: createLoroDocAdapter(writer),
      e2ee: {
        provider: provider((epoch) => recovered.get(epoch)),
        readPolicy: 'encrypted-only',
        writePolicy: 'encrypt',
      },
      fetch: async (_requestUrl, init) => {
        if (init?.method !== 'POST') throw new Error('unexpected-read');
        body = new Uint8Array(await new Response(init.body).arrayBuffer());
        return response(new Uint8Array());
      },
    });
    writer.getText('text').insert(0, 'krc-secret');
    writer.commit();
    expect((await write.appendWriteOnly()).ok).toBe(true);
    expect(new TextDecoder().decode(body)).not.toContain('krc-secret');
    writer.free();

    const reader = new LoroDoc();
    const store = new InMemoryRemoteCursorStore();
    await store.save({
      streamUrl: url,
      nextOffset: '-1',
      serverLowerBoundVersion: {},
      updatedAtMs: 0,
    });
    const read = new StreamsCrdt({
      streamUrl: url,
      adapter: createLoroDocAdapter(reader),
      remoteCursorStore: store,
      e2ee: {
        provider: provider((epoch) => recovered.get(epoch)),
        readPolicy: 'encrypted-only',
        writePolicy: 'encrypt',
      },
      fetch: async (requestUrl) => {
        if (new URL(requestUrl).pathname.endsWith('/bootstrap')) {
          throw new Error('unexpected-bootstrap');
        }
        return response(body);
      },
    });
    expect((await read.catchup()).ok).toBe(true);
    expect(reader.getText('text').toString()).toBe('krc-secret');
    reader.free();

    const wrong = new LoroDoc();
    const wrongStore = new InMemoryRemoteCursorStore();
    await wrongStore.save({
      streamUrl: url,
      nextOffset: '-1',
      serverLowerBoundVersion: {},
      updatedAtMs: 0,
    });
    const wrongRead = new StreamsCrdt({
      streamUrl: url,
      adapter: createLoroDocAdapter(wrong),
      remoteCursorStore: wrongStore,
      e2ee: {
        provider: provider(() => random(32)),
        readPolicy: 'encrypted-only',
        writePolicy: 'encrypt',
      },
      fetch: async (requestUrl) => {
        if (new URL(requestUrl).pathname.endsWith('/bootstrap')) {
          throw new Error('unexpected-bootstrap');
        }
        return response(body);
      },
    });
    expect((await wrongRead.catchup()).ok).toBe(false);
    expect(wrong.getText('text').toString()).not.toBe('krc-secret');
    wrong.free();
  });

  it('recovers from R after personal keys are dropped, and refuses missing current packets', async () => {
    const owner = await device();
    const k0 = random(32);
    const created = await genesis(owner, k0);
    const recovery = await device();
    const withR = await append(
      created.ledger,
      owner,
      await admitDevice(created.anchor, created.ledger.state.owner, recovery, 'recovery', false)
    );
    let ledger = withR.ledger;
    const records = [created.record, withR.record];
    const k1 = random(32);
    const published = await append(ledger, owner, {
      type: 'publishEpoch',
      epoch: 1,
      commitment: await commitEpochKey(created.anchor, 1, k1),
      previousEpochKey: sealHistoryPacket(k1, k0, created.anchor, 1),
    });
    ledger = published.ledger;
    records.push(published.record);

    const stale = await sealEpochEnvelope({
      state: withR.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: recovery.publicKey,
      recipientEncryptionKey: recovery.enc,
      epochKey: k0,
      sign: (bytes) => owner.sign(bytes),
    });
    await expect(
      openEpochEnvelope({
        state: ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: recovery.publicKey,
        recipientKeyPair: recovery.dh,
        frame: stale,
      })
    ).rejects.toMatchObject({ code: 'invalid-operation' });

    const current = await sealEpochEnvelope({
      state: ledger.state,
      genesis: created.anchor,
      epoch: 1,
      sender: owner.publicKey,
      recipient: recovery.publicKey,
      recipientEncryptionKey: recovery.enc,
      epochKey: k1,
      sign: (bytes) => owner.sign(bytes),
    });
    const sender = Uint8Array.from(owner.publicKey);
    owner.publicKey.fill(0);
    const opened = await openEpochEnvelope({
      state: ledger.state,
      genesis: created.anchor,
      epoch: 1,
      sender,
      recipient: recovery.publicKey,
      recipientKeyPair: recovery.dh,
      frame: current,
    });
    expect(opened).toEqual(k1);
    const genesisBody = decodeRecord(created.record);
    if (genesisBody.body.type !== 'genesis') throw new Error('not-genesis');
    const recovered = await recoverHistory({
      genesis: created.anchor,
      latestEpoch: 1,
      latestKey: opened,
      packets: collectEpochPackets(records, genesisBody.body.fields.epochCommitment),
    });
    expect(recovered.get(0)).toEqual(k0);
    expect(recovered.get(1)).toEqual(k1);

    const replacement = await device();
    const restored = await append(
      ledger,
      recovery,
      await admitDevice(created.anchor, created.ledger.state.owner, replacement, 'personal', true)
    );
    expect(restored.ledger.state.devices.get(hex(replacement.publicKey))?.canManage).toBe(true);
  });

  it('keeps approved C after R revoke, drops all device kinds on removeMember, and isolates Org Y', async () => {
    const owner = await device();
    const created = await genesis(owner, random(32));
    let ledger = created.ledger;
    const recovery = await device();
    const withR = await append(
      ledger,
      owner,
      await admitDevice(created.anchor, created.ledger.state.owner, recovery, 'recovery', false)
    );
    ledger = withR.ledger;
    const laptopC = await device();
    const withC = await append(
      ledger,
      recovery,
      await admitDevice(created.anchor, created.ledger.state.owner, laptopC, 'personal', true)
    );
    ledger = withC.ledger;
    expect(ledger.state.devices.get(hex(laptopC.publicKey))?.canManage).toBe(true);

    const revokedR = await append(ledger, owner, {
      type: 'revokeDevice',
      target: recovery.publicKey,
    });
    ledger = revokedR.ledger;
    expect(ledger.state.devices.has(hex(recovery.publicKey))).toBe(false);
    expect(ledger.state.devices.has(hex(laptopC.publicKey))).toBe(true);
    expect(ledger.state.devices.get(hex(laptopC.publicKey))?.canManage).toBe(true);
    await expect(
      append(
        ledger,
        recovery,
        await admitDevice(
          created.anchor,
          created.ledger.state.owner,
          await device(),
          'personal',
          false
        )
      )
    ).rejects.toMatchObject({ code: 'unauthorized' });

    const member = await device();
    const request = await joinRequest(created.anchor, member);
    const joined = await append(ledger, owner, {
      type: 'admitMember',
      membershipId: random(16),
      request,
    });
    ledger = joined.ledger;
    const memberPersonal = member.publicKey;
    const memberMachine = await device();
    const withMachine = await append(
      ledger,
      member,
      await admitDevice(
        created.anchor,
        ledger.state.devices.get(hex(member.publicKey))!.membershipId,
        memberMachine,
        'machine',
        false
      )
    );
    ledger = withMachine.ledger;
    const memberR = await device();
    const withMemberR = await append(
      ledger,
      member,
      await admitDevice(
        created.anchor,
        ledger.state.devices.get(hex(member.publicKey))!.membershipId,
        memberR,
        'recovery',
        false
      )
    );
    ledger = withMemberR.ledger;
    expect(ledger.state.devices.has(hex(memberPersonal))).toBe(true);
    expect(ledger.state.devices.has(hex(memberMachine.publicKey))).toBe(true);
    expect(ledger.state.devices.has(hex(memberR.publicKey))).toBe(true);
    const membershipId = ledger.state.devices.get(hex(memberPersonal))!.membershipId;
    const removed = await append(ledger, owner, {
      type: 'removeMember',
      membershipId,
    });
    ledger = removed.ledger;
    expect(ledger.state.devices.has(hex(memberPersonal))).toBe(false);
    expect(ledger.state.devices.has(hex(memberMachine.publicKey))).toBe(false);
    expect(ledger.state.devices.has(hex(memberR.publicKey))).toBe(false);
    await expect(
      append(
        ledger,
        member,
        await admitDevice(
          created.anchor,
          created.ledger.state.owner,
          await device(),
          'personal',
          false
        )
      )
    ).rejects.toMatchObject({ code: 'unauthorized' });

    const otherOwner = await device();
    const orgY = await genesis(otherOwner, random(32));
    const yR = await append(
      orgY.ledger,
      otherOwner,
      await admitDevice(orgY.anchor, orgY.ledger.state.owner, recovery, 'recovery', false)
    );
    expect(yR.ledger.state.devices.has(hex(recovery.publicKey))).toBe(true);
    expect(ledger.state.devices.has(hex(recovery.publicKey))).toBe(false);
    const yC = await append(
      yR.ledger,
      recovery,
      await admitDevice(orgY.anchor, orgY.ledger.state.owner, await device(), 'personal', false)
    );
    expect(yC.ledger.state.devices.size).toBe(3);
  });

  it('wraps the same recovery material in two independent files without ledger revoke on delete', async () => {
    const owner = await device();
    const created = await genesis(owner, random(32));
    const recovery = await device();
    const withR = await append(
      created.ledger,
      owner,
      await admitDevice(created.anchor, created.ledger.state.owner, recovery, 'recovery', false)
    );
    const identity = hex(created.anchor);
    const material = random(32);
    const fileA = createRecoveryFile();
    const fileB = createRecoveryFile();
    expect(fileA).not.toEqual(fileB);
    const backupA = sealRecoveryBackup(fileA, { identity, revision: 1 }, material);
    const backupB = sealRecoveryBackup(fileB, { identity, revision: 1 }, material);
    expect(backupA).not.toEqual(backupB);
    expect(openRecoveryBackup(fileA, { identity, revision: 1 }, backupA)).toEqual(material);
    expect(openRecoveryBackup(fileB, { identity, revision: 1 }, backupB)).toEqual(material);
    expect(() => openRecoveryBackup(fileB, { identity, revision: 1 }, backupA)).toThrow();
    expect(() => openRecoveryBackup(fileA, { identity, revision: 1 }, backupB)).toThrow();
    const truncated = backupA.subarray(0, backupA.byteLength - 1);
    expect(() => openRecoveryBackup(fileA, { identity, revision: 1 }, truncated)).toThrow();
    const damaged = new Uint8Array(backupA);
    damaged[damaged.byteLength - 1] = (damaged[damaged.byteLength - 1] ?? 0) ^ 0xff;
    expect(() => openRecoveryBackup(fileA, { identity, revision: 1 }, damaged)).toThrow();
    fileB.fill(0);
    expect(openRecoveryBackup(fileA, { identity, revision: 1 }, backupA)).toEqual(material);
    expect(withR.ledger.state.devices.has(hex(recovery.publicKey))).toBe(true);
    expect(typeof globalThis.PublicKeyCredential).toBe('undefined');
  });

  it('recovers two rooms after rotation and refuses cross-org and stale-epoch keys', async () => {
    const owner = await device();
    const k0 = random(32);
    const created = await genesis(owner, k0);
    const pair = (await crypto.subtle.generateKey('Ed25519', false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const signingPublic = hex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
    const author = { actor: 'owner', memberInstance: 'm0', device: 'd0' };
    const provider = (
      genesisBytes: Uint8Array,
      resource: string,
      writeEpoch: number,
      readKey: (epoch: number) => Uint8Array | undefined
    ) =>
      createStreamsContentProvider({
        cipher: new ContentCipher({
          authorize(header) {
            if (header.actor !== author.actor) throw new Error('unauthorized');
            return signingPublic;
          },
        }),
        genesis: hex(genesisBytes),
        resource,
        model: 'loro',
        writeEpoch,
        author,
        signingKey: pair.privateKey,
        readKey,
      });

    async function writePlain(
      streamUrl: string,
      resource: string,
      genesisBytes: Uint8Array,
      writeEpoch: number,
      key: Uint8Array,
      plaintext: string
    ): Promise<Uint8Array> {
      const doc = new LoroDoc();
      let body = new Uint8Array();
      const write = new StreamsCrdt({
        streamUrl,
        adapter: createLoroDocAdapter(doc),
        e2ee: {
          provider: provider(genesisBytes, resource, writeEpoch, (epoch) =>
            epoch === writeEpoch ? key : undefined
          ),
          readPolicy: 'encrypted-only',
          writePolicy: 'encrypt',
        },
        fetch: async (_url, init) => {
          if (init?.method !== 'POST') throw new Error('unexpected-read');
          body = new Uint8Array(await new Response(init.body).arrayBuffer());
          return response(new Uint8Array());
        },
      });
      doc.getText('text').insert(0, plaintext);
      doc.commit();
      expect((await write.appendWriteOnly()).ok).toBe(true);
      expect(new TextDecoder().decode(body)).not.toContain(plaintext);
      doc.free();
      return body;
    }

    async function catchup(
      streamUrl: string,
      pages: Uint8Array[],
      genesisBytes: Uint8Array,
      resource: string,
      writeEpoch: number,
      readKey: (epoch: number) => Uint8Array | undefined
    ) {
      const reader = new LoroDoc();
      const store = new InMemoryRemoteCursorStore();
      await store.save({
        streamUrl,
        nextOffset: '-1',
        serverLowerBoundVersion: {},
        updatedAtMs: 0,
      });
      const read = new StreamsCrdt({
        streamUrl,
        adapter: createLoroDocAdapter(reader),
        remoteCursorStore: store,
        e2ee: {
          provider: provider(genesisBytes, resource, writeEpoch, readKey),
          readPolicy: 'encrypted-only',
          writePolicy: 'encrypt',
        },
        fetch: async (requestUrl) => {
          if (new URL(requestUrl).pathname.endsWith('/bootstrap')) {
            throw new Error('unexpected-bootstrap');
          }
          const offset = new URL(requestUrl).searchParams.get('offset') ?? '-1';
          const index = offset === '-1' ? 0 : Number.parseInt(offset, 10);
          const page = pages[index];
          if (!page) return response(new Uint8Array(), 'tail', true);
          const last = index + 1 >= pages.length;
          return response(page, last ? 'tail' : String(index + 1), last);
        },
      });
      const result = await read.catchup();
      return { result, reader };
    }

    const urlA = 'https://synthetic.example.test/ds/room-a';
    const urlB = 'https://synthetic.example.test/ds/room-b';
    const pageA0 = await writePlain(urlA, 'room-a', created.anchor, 0, k0, 'room-a-epoch-0');
    const k1 = random(32);
    expect(k1).not.toEqual(k0);
    const published = await append(created.ledger, owner, {
      type: 'publishEpoch',
      epoch: 1,
      commitment: await commitEpochKey(created.anchor, 1, k1),
      previousEpochKey: sealHistoryPacket(k1, k0, created.anchor, 1),
    });
    const genesisBody = decodeRecord(created.record);
    if (genesisBody.body.type !== 'genesis') throw new Error('not-genesis');
    const packets = collectEpochPackets(
      [created.record, published.record],
      genesisBody.body.fields.epochCommitment
    );
    const recovered = await recoverHistory({
      genesis: created.anchor,
      latestEpoch: 1,
      latestKey: k1,
      packets,
    });
    expect(recovered.get(0)).toEqual(k0);
    expect(recovered.get(1)).toEqual(k1);

    const pageA1 = await writePlain(urlA, 'room-a', created.anchor, 1, k1, 'room-a-epoch-1');
    const pageB1 = await writePlain(urlB, 'room-b', created.anchor, 1, k1, 'room-b-epoch-1');

    const roomA = await catchup(urlA, [pageA0, pageA1], created.anchor, 'room-a', 1, (epoch) =>
      recovered.get(epoch)
    );
    expect(roomA.result.ok).toBe(true);
    expect(roomA.reader.getText('text').toString()).toContain('room-a-epoch-0');
    expect(roomA.reader.getText('text').toString()).toContain('room-a-epoch-1');
    roomA.reader.free();

    const roomB = await catchup(urlB, [pageB1], created.anchor, 'room-b', 1, (epoch) =>
      recovered.get(epoch)
    );
    expect(roomB.result.ok).toBe(true);
    expect(roomB.reader.getText('text').toString()).toBe('room-b-epoch-1');
    roomB.reader.free();

    const staleB = await catchup(urlB, [pageB1], created.anchor, 'room-b', 1, (epoch) =>
      epoch === 0 ? k0 : undefined
    );
    expect(staleB.result.ok).toBe(false);
    expect(staleB.reader.getText('text').toString()).not.toBe('room-b-epoch-1');
    staleB.reader.free();

    const crossed = await catchup(urlA, [pageA1], created.anchor, 'room-b', 1, (epoch) =>
      recovered.get(epoch)
    );
    expect(crossed.result.ok).toBe(false);
    expect(crossed.reader.getText('text').toString()).not.toContain('room-a-epoch-1');
    crossed.reader.free();

    const other = await genesis(await device(), random(32));
    await expect(
      recoverHistory({
        genesis: other.anchor,
        latestEpoch: 1,
        latestKey: k1,
        packets,
      })
    ).rejects.toMatchObject({ code: 'invalid-operation' });
    const foreign = await catchup(urlA, [pageA0, pageA1], other.anchor, 'room-a', 1, () => k1);
    expect(foreign.result.ok).toBe(false);
    expect(foreign.reader.getText('text').toString()).not.toContain('room-a-epoch-0');
    expect(foreign.reader.getText('text').toString()).not.toContain('room-a-epoch-1');
    foreign.reader.free();
  });
});
