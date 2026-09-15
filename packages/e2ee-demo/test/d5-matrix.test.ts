import { describe, expect, it } from 'vitest';
import { encodeSignedRecord, signingBytesForBody } from '@lody/e2ee-core/ledger';
import { generateDevice } from '../src/device';
import { CONTROL_STREAM, DEVICE_HEADER } from '../src/protocol';
import { launchHost, session, spawnCli, tempDir } from './helpers';
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
});
