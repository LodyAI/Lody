import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { launchHost, session } from './helpers';
import { startDemoHost } from '../src/host';
import { DemoSession } from '../src/session';
import { tempDir } from './helpers';

describe('D1 signed HTTP control path', () => {
  it('creates a space with a real genesis signature and persists riverrun bytes', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    const created = await alice.createSpace();
    expect(created.genesisHex).toMatch(/^[0-9a-f]{64}$/);
    const ledger = await alice.readLedger();
    expect(ledger.length).toBe(1);
    expect(existsSync(host.riverrunDbPath)).toBe(true);
    const anonymous = await fetch(`${host.baseUrl}/ds/${created.genesisHex}/control`);
    expect(anonymous.status === 401 || anonymous.status === 403).toBe(true);
  });

  it('rejects an unjoined ordinary POST to the control stream without advancing offset', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    const outsider = await session(host, 'outsider');
    const { genesisHex } = await alice.createSpace();
    const path = `/ds/${genesisHex}/control`;
    const before = await alice.fetch(path, { method: 'HEAD' });
    const injected = await outsider.fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from([0, 0, 0, 1, 255]),
    });
    const deleted = await outsider.fetch(path, { method: 'DELETE' });
    const after = await alice.fetch(path, { method: 'HEAD' });
    expect(injected.status === 401 || injected.status === 403).toBe(true);
    expect(deleted.status === 401 || deleted.status === 403).toBe(true);
    expect(before.headers.get('stream-next-offset')).toBe(after.headers.get('stream-next-offset'));
    expect((await alice.readLedger()).length).toBe(1);
  });

  it('rejects a stranger control write on the server', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    const bob = await session(host, 'bob');
    const { genesisHex } = await alice.createSpace();
    await bob.adoptGenesis(genesisHex);
    await expect(bob.revokeDevice(alice.device.publicKey)).rejects.toThrow();
    expect((await alice.readLedger()).length).toBe(1);
  });

  it('recovers the same head after host restart', async () => {
    const dir = tempDir('e2ee-demo-persist-');
    const host = await startDemoHost({ dataDir: dir, host: '127.0.0.1', port: 0, testMode: true });
    const alice = new DemoSession({
      baseUrl: host.baseUrl,
      clientDir: tempDir('e2ee-demo-alice-'),
      account: 'alice',
      testMode: true,
    });
    await alice.start();
    await alice.createSpace();
    const bob = await session(host, 'bob');
    const join = await bob.requestJoin(alice.genesisHex!);
    const approved = await alice.approveJoin(join);
    expect(approved.status).toBe('committed');
    const head = (await alice.readLedger()).head;
    await host.close();

    const restarted = await startDemoHost({
      dataDir: dir,
      host: '127.0.0.1',
      port: 0,
      testMode: true,
    });
    const alice2 = new DemoSession({
      baseUrl: restarted.baseUrl,
      clientDir: alice.clientDir,
      account: 'alice',
      testMode: true,
      device: alice.device,
    });
    await alice2.start();
    await alice2.adoptGenesis(alice.genesisHex!);
    const recovered = await alice2.readLedger();
    expect(recovered.length).toBe(2);
    expect(Buffer.from(recovered.head).equals(Buffer.from(head))).toBe(true);
    await restarted.close();
  });
});
