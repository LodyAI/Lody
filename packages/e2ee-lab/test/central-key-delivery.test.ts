import { afterEach, describe, expect, it } from 'vitest';
import { cleanupLab, labClient, launchLab, tempDir } from '../src/fixtures';
import { exportDevice, generateDevice } from '../src/platform/device';
import { toHex } from '../src/platform/bytes';

afterEach(() => cleanupLab());
async function request(client: Awaited<ReturnType<typeof labClient>>, body: unknown) {
  const res = await client.fetch(`/v1/spaces/${client.genesisHex}/key-mailbox`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as { items?: { recipient: string }[]; status?: string },
  };
}
describe('central key mailbox on the real Lab HTTP host', () => {
  it('runs explicit finite rounds over SQLite mailbox while permission/content stay on Riverrun', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    await alice.createSpace();
    const phoneDevice = await generateDevice(),
      rDevice = await generateDevice();
    await alice.admitDevice(phoneDevice, 'personal');
    await alice.admitDevice(rDevice, 'recovery');
    expect((await alice.centralKeyRound()).scheduled).toBe(2);
    const before = await request(alice, {
      op: 'list',
      kind: 'awaitingInstallationReport',
      cursor: null,
      limit: 100,
    });
    expect(before.body.items?.map((t) => t.recipient).sort()).toEqual(
      [toHex(phoneDevice.publicKey), toHex(rDevice.publicKey)].sort()
    );
    expect((await alice.centralKeyRound()).scheduled).toBe(0);
    const phone = await labClient({
      host,
      account: 'alice',
      device: await exportDevice(phoneDevice),
    });
    await phone.adoptGenesis(alice.genesisHex!);
    expect((await phone.centralKeyRound()).received).toBe(1);
    expect(phone.epochKeys.get(0)).toEqual(alice.epochKeys.get(0));
    const installed = await request(alice, {
      op: 'status',
      slot: { genesis: alice.genesisHex, epoch: 0, recipient: toHex(phoneDevice.publicKey) },
    });
    expect(installed.body.status).toBe('InstallationReported');
    await alice.revokeDevice(phoneDevice.publicKey);
    await alice.publishEpoch();
    await alice.centralKeyRound();
    const recovery = await labClient({
      host,
      account: 'alice',
      device: await exportDevice(rDevice),
    });
    await recovery.adoptGenesis(alice.genesisHex!);
    await recovery.centralKeyRound();
    expect(recovery.epochKeys.get(1)).toEqual(alice.epochKeys.get(1));
    expect((await recovery.centralKeyRound()).scheduled).toBe(0);
    expect((await request(phone, { op: 'fetch', epoch: 1, cursor: null, limit: 100 })).status).toBe(
      403
    );
  });
  it('reopens host and client stores with retained offline ciphertext, authenticated fetch and durable results', async () => {
    const dataDir = tempDir('e2ee-central-host-');
    let host = await launchLab(dataDir);
    const alice = await labClient({ host, account: 'alice' });
    await alice.createSpace();
    const genesis = alice.genesisHex!,
      device = await exportDevice(alice.device),
      clientDir = alice.clientDir;
    const phoneDevice = await generateDevice();
    await alice.admitDevice(phoneDevice, 'personal');
    await alice.centralKeyRound();
    await alice.close();
    await host.close();
    host = await launchLab(dataDir);
    const reopened = await labClient({ host, account: 'alice', device, clientDir });
    await reopened.adoptGenesis(genesis);
    const round = await reopened.centralKeyRound();
    expect(round.scheduled).toBe(0);
    expect(round.results.items.some((r) => r.outcome === 'Observed')).toBe(true);
    const phone = await labClient({
      host,
      account: 'alice',
      device: await exportDevice(phoneDevice),
    });
    await phone.adoptGenesis(genesis);
    await phone.centralKeyRound();
    expect(phone.epochKeys.get(0)).toEqual(reopened.epochKeys.get(0));
    expect((await request(phone, { op: 'fetch', epoch: 0, cursor: null, limit: 101 })).status).toBe(
      403
    );
    // Caller-supplied recipient cannot impersonate the device bound to its credential.
    expect(
      (
        await request(phone, {
          op: 'repair',
          slot: { genesis, epoch: 0, recipient: toHex(reopened.device.publicKey) },
          requestId: 'impersonation',
        })
      ).status
    ).toBe(403);
  });
});
