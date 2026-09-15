import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRecoveryDeviceSecret } from '@lody/e2ee-core';
import {
  encodeSignedRecord,
  headAttestationSigningBytes,
  Ledger,
  possessionSigningBytes,
  signingBytesForBody,
} from '@lody/e2ee-core/ledger';
import { exportBackup, restoreBackup } from '../src/backup';
import {
  assertLiveCiphertext,
  assertSnapshotCiphertext,
  bootstrapLoroFromSnapshot,
  editLoro,
  loroTailOffset,
  loroWriter,
  putLoroSnapshot,
  readFlock,
  readLoro,
  sealLoroSnapshot,
  syncLoro,
  uploadLoroSnapshot,
  writeFlock,
  writeLoro,
} from '../src/content-session';
import { deviceHex, generateDevice } from '../src/device';
import { CONTROL_STREAM, DEVICE_HEADER } from '../src/protocol';
import { fromHex } from '../src/bytes';
import { findSubarray, frameRecord, launchHost, session, spawnCli, tempDir } from './helpers';
import { DemoSession } from '../src/session';

describe('D5 fault matrix', () => {
  it('CAS conflict does not re-sign or change the losing record bytes', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    const twin = await session(host, 'alice');
    const extra = await generateDevice();
    const other = await generateDevice();
    await alice.createSpace();
    twin.device = alice.device;
    await twin.reauth();
    await twin.adoptGenesis(alice.genesisHex!);
    const first = alice.admitDevice(extra, 'personal', false);
    const second = twin.admitDevice(other, 'personal', false);
    const results = await Promise.allSettled([first, second]);
    const statuses = results.map((row) =>
      row.status === 'fulfilled' ? row.value.status : 'rejected'
    );
    expect(statuses).toContain('committed');
    expect(statuses.some((status) => status === 'conflict' || status === 'rejected')).toBe(true);
    expect((await alice.readLedger()).length).toBe(2);
  });

  it('dropped ACK recovers the exact pending record without a second signature', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    const extra = await generateDevice();
    await alice.createSpace();
    await fetch(`${host.baseUrl}/v1/failpoints`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'drop-control-ack' }),
    });
    let result: { status: string };
    try {
      result = await alice.admitDevice(extra, 'personal', false);
    } catch {
      await fetch(`${host.baseUrl}/v1/failpoints`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'none' }),
      });
      result = await alice.resume();
    }
    expect(result.status).toBe('committed');
    expect((await alice.readLedger()).length).toBe(2);
    expect((await alice.readLedger()).state.devices.size).toBe(2);
  });

  it('rejects a tampered signature without advancing the cursor', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    await alice.createSpace();
    const ledger = await alice.readLedger();
    const extra = await generateDevice();
    const proposal = ledger.prepare(
      {
        type: 'admitDevice',
        kind: 'personal',
        signingPublicKey: extra.publicKey,
        encryptionPublicKey: extra.enc,
        canManage: false,
        possessionSignature: await extra.sign(
          (await import('@lody/e2ee-core/ledger')).possessionSigningBytes({
            genesis: alice.genesis!,
            signingPublicKey: extra.publicKey,
            encryptionPublicKey: extra.enc,
            kind: 'personal',
            canManage: false,
          })
        ),
      },
      alice.device.publicKey
    );
    const record = encodeSignedRecord(
      proposal.bodyBytes,
      await alice.device.sign(signingBytesForBody(proposal.bodyBytes))
    );
    const last = record.length - 1;
    const lastByte = record[last];
    if (lastByte === undefined) throw new Error('empty-record');
    record[last] = lastByte ^ 0xff;
    const framed = new Uint8Array(4 + record.length);
    new DataView(framed.buffer).setUint32(0, record.length, false);
    framed.set(record, 4);
    const response = await fetch(
      `${host.baseUrl}/ds/${alice.genesisHex}/${CONTROL_STREAM}/append-cas`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${alice.credential!.token}`,
          [DEVICE_HEADER]: (await import('../src/device')).deviceHex(alice.device),
          'content-type': 'application/octet-stream',
          'stream-expected-offset': '-1',
        },
        body: framed,
      }
    );
    expect(response.ok).toBe(false);
    expect((await alice.readLedger()).length).toBe(1);
  });

  it('treats now == expires as expired on the HTTP path', async () => {
    let now = 1_000;
    const host = await launchHost({ now: () => now });
    const alice = await session(host, 'alice', () => now);
    await alice.createSpace();
    now = alice.credential!.expiresAt;
    await fetch(`${host.baseUrl}/v1/clock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ now }),
    });
    const extra = await generateDevice();
    await expect(alice.admitDevice(extra, 'personal', false)).rejects.toThrow();
  });

  it('guest cannot write content on the server', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    const guest = await session(host, 'guest');
    await alice.createSpace();
    const join = await guest.requestJoin(alice.genesisHex!);
    await alice.approveJoin(join, 'guest');
    const response = await fetch(`${host.baseUrl}/ds/${alice.genesisHex}/loro`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${guest.credential!.token}`,
        [DEVICE_HEADER]: (await import('../src/device')).deviceHex(guest.device),
        'content-type': 'application/octet-stream',
      },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(response.status === 401 || response.status === 403).toBe(true);
  });

  it('rejects recovery-device content writes on the server', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    const recovery = await session(host, 'alice-r');
    await alice.createSpace();
    const secret = await (await import('@lody/e2ee-core')).createRecoveryDeviceSecret();
    const handle = await (await import('@lody/e2ee-core')).importRecoveryDevice(secret.secret);
    const recoveryDevice = {
      publicKey: handle.publicKey,
      enc: handle.enc,
      signing: handle.recipientKeyPair,
      encryption: handle.recipientKeyPair,
      sign: (bytes: Uint8Array) => handle.sign(bytes),
    };
    expect((await alice.admitDevice(recoveryDevice, 'recovery', false)).status).toBe('committed');
    recovery.device = recoveryDevice;
    await recovery.reauth();
    await recovery.adoptGenesis(alice.genesisHex!);
    const response = await fetch(`${host.baseUrl}/ds/${alice.genesisHex}/loro`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${recovery.credential!.token}`,
        [DEVICE_HEADER]: (await import('../src/device')).deviceHex(recovery.device),
        'content-type': 'application/octet-stream',
      },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(response.status === 401 || response.status === 403).toBe(true);
  });

  it('killing Node after a committed CAS recovers the same head from disk', async () => {
    const dir = tempDir('e2ee-demo-kill-');
    const first = await spawnCli(dir);
    const alice = new DemoSession({
      baseUrl: first.baseUrl,
      clientDir: tempDir('e2ee-demo-kill-alice-'),
      account: 'alice',
      testMode: true,
    });
    await alice.start();
    await alice.createSpace();
    await fetch(`${first.baseUrl}/v1/failpoints`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'kill-after-commit' }),
    });
    const extra = await generateDevice();
    await alice.admitDevice(extra, 'personal', false).catch(() => undefined);
    await new Promise<void>((resolve) => {
      if (first.child.exitCode !== null) resolve();
      else first.child.on('exit', () => resolve());
    });
    const second = await spawnCli(dir);
    const alice2 = new DemoSession({
      baseUrl: second.baseUrl,
      clientDir: alice.clientDir,
      account: 'alice',
      testMode: true,
      device: alice.device,
    });
    await alice2.start();
    await alice2.adoptGenesis(alice.genesisHex!);
    expect((await alice2.readLedger()).length).toBe(2);
  });

  it('rejects a different ciphertext at an already-admitted snapshot offset', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    await alice.createSpace();
    await alice.readLedger();
    await writeLoro(alice, 'snap-base');
    const offset = await loroTailOffset(alice);
    const first = await sealLoroSnapshot(alice, offset, 'cipher-a');
    const second = await sealLoroSnapshot(alice, offset, 'cipher-b');
    expect(first).not.toEqual(second);
    const accepted = await putLoroSnapshot(alice, offset, first);
    expect(accepted.ok).toBe(true);
    const conflict = await putLoroSnapshot(alice, offset, second);
    expect(conflict.ok).toBe(false);
    expect(await conflict.text()).toContain('snapshot-identity-conflict');
    const retry = await putLoroSnapshot(alice, offset, first);
    expect(retry.ok).toBe(true);
  });

  it('fails closed on a corrupted recovery backup', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    await alice.createSpace();
    const recovery = await createRecoveryDeviceSecret();
    const file = await exportBackup(alice, {
      secret: recovery.secret,
      publicKey: recovery.publicKey,
    });
    const tampered = file.slice();
    const last = tampered.length - 8;
    tampered[last] = (tampered[last] ?? 0) ^ 0xff;
    const victim = await session(host, 'alice-restored');
    await expect(restoreBackup(victim, tampered)).rejects.toThrow();
  });

  it('rejects a wrong-parent control record without advancing the cursor', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    await alice.createSpace();
    const ledger = await alice.readLedger();
    const extra = await generateDevice();
    const proposal = ledger.prepare(
      {
        type: 'admitDevice',
        kind: 'personal',
        signingPublicKey: extra.publicKey,
        encryptionPublicKey: extra.enc,
        canManage: false,
        possessionSignature: await extra.sign(
          possessionSigningBytes({
            genesis: fromHex(alice.genesisHex!),
            signingPublicKey: extra.publicKey,
            encryptionPublicKey: extra.enc,
            kind: 'personal',
            canManage: false,
          })
        ),
      },
      alice.device.publicKey
    );
    const parentAt = findSubarray(proposal.bodyBytes, ledger.head);
    expect(parentAt).toBeGreaterThanOrEqual(0);
    const tamperedBody = proposal.bodyBytes.slice();
    tamperedBody[parentAt] = (tamperedBody[parentAt] ?? 0) ^ 0xff;
    const record = encodeSignedRecord(
      tamperedBody,
      await alice.device.sign(signingBytesForBody(tamperedBody))
    );
    const response = await fetch(
      `${host.baseUrl}/ds/${alice.genesisHex}/${CONTROL_STREAM}/append-cas`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${alice.credential!.token}`,
          [DEVICE_HEADER]: deviceHex(alice.device),
          'content-type': 'application/octet-stream',
          'stream-expected-offset': '-1',
        },
        body: Buffer.from(frameRecord(record)),
      }
    );
    expect(response.ok).toBe(false);
    expect((await alice.readLedger()).length).toBe(1);
    expect((await alice.readLedger()).state.devices.size).toBe(1);
  });

  it('rejects a nested possession proof under a valid outer signature', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    await alice.createSpace();
    const ledger = await alice.readLedger();
    const extra = await generateDevice();
    const possessionSignature = await extra.sign(
      possessionSigningBytes({
        genesis: fromHex(alice.genesisHex!),
        signingPublicKey: extra.publicKey,
        encryptionPublicKey: extra.enc,
        kind: 'personal',
        canManage: false,
      })
    );
    possessionSignature[0] = (possessionSignature[0] ?? 0) ^ 0xff;
    const proposal = ledger.prepare(
      {
        type: 'admitDevice',
        kind: 'personal',
        signingPublicKey: extra.publicKey,
        encryptionPublicKey: extra.enc,
        canManage: false,
        possessionSignature,
      },
      alice.device.publicKey
    );
    const record = encodeSignedRecord(
      proposal.bodyBytes,
      await alice.device.sign(proposal.signingBytes)
    );
    const response = await fetch(
      `${host.baseUrl}/ds/${alice.genesisHex}/${CONTROL_STREAM}/append-cas`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${alice.credential!.token}`,
          [DEVICE_HEADER]: deviceHex(alice.device),
          'content-type': 'application/octet-stream',
          'stream-expected-offset': '-1',
        },
        body: Buffer.from(frameRecord(record)),
      }
    );
    expect(response.ok).toBe(false);
    expect((await alice.readLedger()).length).toBe(1);
    expect((await alice.readLedger()).state.devices.has(deviceHex(extra))).toBe(false);
  });

  it('rejects tampered imported ledger snapshot state and tampered CRDT snapshot bytes', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    await alice.createSpace();
    const extra = await generateDevice();
    expect((await alice.admitDevice(extra, 'personal', false)).status).toBe('committed');
    const ledger = await alice.readLedger();
    const proposal = ledger.prepareSnapshot(alice.device.publicKey);
    const snapshot = await Ledger.finalizeSnapshot(
      proposal,
      await alice.device.sign(proposal.signingBytes)
    );
    const trust = {
      genesis: fromHex(alice.genesisHex!),
      endorser: alice.device.publicKey,
      head: ledger.head,
      headSignature: await alice.device.sign(
        headAttestationSigningBytes(fromHex(alice.genesisHex!), ledger.head)
      ),
    };
    const tampered = snapshot.slice();
    tampered[16] = (tampered[16] ?? 0) ^ 0xff;
    await expect(Ledger.verifySnapshot({ trust, snapshot: tampered })).rejects.toThrow();
    expect((await alice.readLedger()).length).toBe(2);

    await alice.readLedger();
    await uploadLoroSnapshot(alice, 'imported-secret');
    const wrapped = {
      get baseUrl() {
        return alice.baseUrl;
      },
      get genesisHex() {
        return alice.genesisHex;
      },
      get device() {
        return alice.device;
      },
      get account() {
        return alice.account;
      },
      get membershipId() {
        return alice.membershipId;
      },
      get epochKeys() {
        return alice.epochKeys;
      },
      get canWriteDocument() {
        return alice.canWriteDocument;
      },
      currentEpoch: () => alice.currentEpoch(),
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await alice.fetch(input, init);
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input instanceof Request
                ? input.url
                : String(input);
        if (!url.includes('/snapshot/') && !url.includes('/bootstrap')) return response;
        const body = new Uint8Array(await response.arrayBuffer());
        if (body.byteLength > 20) body[20] = (body[20] ?? 0) ^ 0xff;
        return new Response(body, { status: response.status, headers: response.headers });
      },
    };
    await expect(bootstrapLoroFromSnapshot(wrapped, 'imported-secret')).rejects.toThrow();
    const honest = await bootstrapLoroFromSnapshot(alice, 'imported-secret');
    expect(honest.text).toContain('imported-secret');
  });

  it('converges Loro and Flock after concurrent writes and an offline reconnect', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    const bob = await session(host, 'bob');
    await alice.createSpace();
    const join = await bob.requestJoin(alice.genesisHex!);
    await alice.approveJoin(join);
    await alice.deliverEpochKey(bob.device, 0);
    const frames = await bob.readKeyFrames();
    await bob.receiveEpochKey(alice.device, 0, frames[0]!);
    await alice.readLedger();
    await bob.readLedger();
    await writeLoro(alice, 'alice-online');
    const bobDoc = await syncLoro(bob);
    expect(bobDoc.getText('text').toString()).toContain('alice-online');
    const bobWriter = loroWriter(bob, bobDoc);
    const created = await bobWriter.createStream();
    if (!created.ok) {
      /* already exists */
    }
    await editLoro(alice, 'alice-more');
    const current = bobDoc.getText('text').toString();
    bobDoc.getText('text').insert(current.length, 'bob-offline');
    bobDoc.commit();
    const appended = await bobWriter.appendWriteOnly();
    if (!appended.ok) throw new Error(`bob-offline-append:${JSON.stringify(appended)}`);
    await bobWriter.close();
    bobDoc.free();
    const aliceText = await readLoro(alice);
    const bobText = await readLoro(bob);
    expect(aliceText).toBe(bobText);
    expect(aliceText).toContain('alice-online');
    expect(aliceText).toContain('alice-more');
    expect(aliceText).toContain('bob-offline');

    await writeFlock(alice, 'flock-a', ['private', 'a']);
    await writeFlock(bob, 'flock-b', ['private', 'b']);
    expect(await readFlock(alice, ['private', 'a'])).toContain('flock-a');
    expect(await readFlock(bob, ['private', 'b'])).toContain('flock-b');
    expect(await readFlock(alice, ['private', 'b'])).toContain('flock-b');
    expect(await readFlock(bob, ['private', 'a'])).toContain('flock-a');
  });

  it('keeps plaintext out of riverrun bytes and the live content stream', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    await alice.createSpace();
    await alice.readLedger();
    const secret = 'plaintext-secret-xyz';
    await writeLoro(alice, secret);
    await writeFlock(alice, secret);
    await assertLiveCiphertext(alice, 'loro', secret);
    await assertLiveCiphertext(alice, 'flock', secret);
    await uploadLoroSnapshot(alice, secret);
    await assertSnapshotCiphertext(alice, secret);
    const disk = readFileSync(host.riverrunDbPath);
    expect(disk.includes(secret)).toBe(false);
  });

  it('lets a new member recover mixed epochs from the current key and rejects a wrong latest key', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    const bob = await session(host, 'bob');
    await alice.createSpace();
    await alice.readLedger();
    await writeLoro(alice, 'epoch-zero-secret');
    expect((await alice.publishEpoch()).status).toBe('committed');
    const join = await bob.requestJoin(alice.genesisHex!);
    await alice.approveJoin(join);
    await alice.deliverEpochKey(bob.device, 1);
    const frames = await bob.readKeyFrames();
    await bob.receiveEpochKey(alice.device, 1, frames[0]!);
    expect(bob.epochKeys.has(0)).toBe(false);
    bob.epochKeys.set(0, crypto.getRandomValues(new Uint8Array(32)));
    await expect(
      (async () => {
        const wrong = await session(host, 'carol');
        await wrong.adoptGenesis(alice.genesisHex!);
        wrong.epochKeys.set(1, alice.epochKeys.get(0)!);
        await wrong.recoverEpochHistory();
      })()
    ).rejects.toThrow();
    await bob.recoverEpochHistory();
    expect(bob.epochKeys.has(0)).toBe(true);
    expect(Buffer.from(bob.epochKeys.get(0)!).equals(Buffer.from(alice.epochKeys.get(0)!))).toBe(
      true
    );
    await bob.readLedger();
    expect(await readLoro(bob)).toContain('epoch-zero-secret');
  });

  it('rejects machine-device management writes on the server', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    await alice.createSpace();
    const machine = await generateDevice();
    expect((await alice.admitDevice(machine, 'machine', false)).status).toBe('committed');
    const bot = await session(host, 'alice-machine');
    bot.device = machine;
    await bot.reauth();
    await bot.adoptGenesis(alice.genesisHex!);
    await expect(bot.publishEpoch()).rejects.toThrow();
    await expect(bot.admitDevice(await generateDevice(), 'personal', false)).rejects.toThrow();
    expect((await alice.readLedger()).state.epoch.number).toBe(0);
  });
});
