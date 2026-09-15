import { describe, expect, it } from 'vitest';
import { createRecoveryDeviceSecret, importRecoveryDevice } from '@lody/e2ee-core';
import { exportBackup, recoveryAsDevice, restoreBackup } from '../src/backup';
import {
  bootstrapLoroFromSnapshot,
  readLoro,
  uploadLoroSnapshot,
  writeLoro,
} from '../src/content-session';
import { generateDevice } from '../src/device';
import { launchHost, session, tempDir } from './helpers';
import { DemoSession } from '../src/session';

describe('D4 revoke, rotation, history, file restore', () => {
  it('rotates after revoke so the revoked device cannot extend the new epoch', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    const bob = await session(host, 'bob');
    await alice.createSpace();
    const join = await bob.requestJoin(alice.genesisHex!);
    const approved = await alice.approveJoin(join);
    await alice.deliverEpochKey(bob.device, 0);
    const revoked = await alice.removeMember(approved.membershipId);
    expect(revoked.status).toBe('committed');
    const rotated = await alice.publishEpoch();
    expect(rotated.status).toBe('committed');
    await expect(bob.publishEpoch()).rejects.toThrow();
    expect((await alice.readLedger()).state.epoch.number).toBe(1);
  });

  it('restores a new device from a recovery file and decrypts prior ciphertext', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    await alice.createSpace();
    await alice.readLedger();
    await writeLoro(alice, 'restore-secret');
    const recovery = await createRecoveryDeviceSecret();
    const recoveryDevice = recoveryAsDevice(await importRecoveryDevice(recovery.secret));
    expect((await alice.admitDevice(recoveryDevice, 'recovery', false)).status).toBe('committed');
    const file = await exportBackup(alice, {
      secret: recovery.secret,
      publicKey: recovery.publicKey,
    });
    const restored = await session(host, 'alice-restored');
    const opened = await restoreBackup(restored, file);
    restored.device = recoveryAsDevice(opened.recovery);
    await restored.reauth();
    const phone = await generateDevice();
    const added = await restored.admitDevice(phone, 'personal', false);
    expect(added.status).toBe('committed');
    restored.device = phone;
    await restored.reauth();
    await restored.readLedger();
    expect(await readLoro(restored)).toContain('restore-secret');
  });

  it('keeps previously written encrypted history readable after the author is removed', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    const bob = await session(host, 'bob');
    await alice.createSpace();
    const join = await bob.requestJoin(alice.genesisHex!);
    const approved = await alice.approveJoin(join);
    await alice.deliverEpochKey(bob.device, 0);
    const frames = await bob.readKeyFrames();
    await bob.receiveEpochKey(alice.device, 0, frames[0]!);
    await bob.readLedger();
    await writeLoro(bob, 'bob-history');
    expect((await alice.removeMember(approved.membershipId)).status).toBe('committed');
    await expect(writeLoro(bob, 'after-revoke')).rejects.toThrow();
    await alice.readLedger();
    expect(await readLoro(alice)).toContain('bob-history');
  });

  it('bootstraps an admitted snapshot on a fresh client after restart and blocks revoked publication', async () => {
    const dir = tempDir('e2ee-demo-rev-snap-');
    const host = await launchHost({ dataDir: dir });
    const alice = await session(host, 'alice');
    const bob = await session(host, 'bob');
    await alice.createSpace();
    const join = await bob.requestJoin(alice.genesisHex!);
    const approved = await alice.approveJoin(join);
    await alice.deliverEpochKey(bob.device, 0);
    const frames = await bob.readKeyFrames();
    await bob.receiveEpochKey(alice.device, 0, frames[0]!);
    await bob.readLedger();
    await uploadLoroSnapshot(bob, 'snapshot-from-bob');
    expect((await alice.removeMember(approved.membershipId)).status).toBe('committed');
    await bob.readLedger();
    await expect(uploadLoroSnapshot(bob, 'new-after-revoke')).rejects.toThrow();
    const genesisHex = alice.genesisHex!;
    const device = alice.device;
    const clientDir = alice.clientDir;
    const epochKeys = new Map(alice.epochKeys);
    await host.close();

    const restarted = await launchHost({ dataDir: dir });
    const fresh = new DemoSession({
      baseUrl: restarted.baseUrl,
      clientDir,
      account: 'alice',
      testMode: true,
      device,
    });
    await fresh.start();
    await fresh.adoptGenesis(genesisHex);
    fresh.epochKeys = epochKeys;
    await fresh.readLedger();
    const bootstrapped = await bootstrapLoroFromSnapshot(fresh, 'snapshot-from-bob');
    expect(bootstrapped.text).toContain('snapshot-from-bob');
    expect(
      bootstrapped.fetches.some(
        (entry) => entry.includes('/snapshot/') || entry.includes('/bootstrap')
      )
    ).toBe(true);
  });
});
