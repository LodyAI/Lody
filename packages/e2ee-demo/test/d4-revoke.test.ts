import { describe, expect, it } from 'vitest';
import { createRecoveryDeviceSecret, importRecoveryDevice } from '@lody/e2ee-core';
import { exportBackup, restoreBackup } from '../src/backup';
import { readLoro, writeLoro } from '../src/content-session';
import { generateDevice } from '../src/device';
import { launchHost, session } from './helpers';

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

  it('restores a new device from a recovery file without sharing the old private key', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    await alice.createSpace();
    const recovery = await createRecoveryDeviceSecret();
    const handle = await importRecoveryDevice(recovery.secret);
    const recoveryDevice = {
      publicKey: handle.publicKey,
      enc: handle.enc,
      signing: handle.recipientKeyPair,
      encryption: handle.recipientKeyPair,
      sign: (bytes: Uint8Array) => handle.sign(bytes),
    };
    const admitted = await alice.admitDevice(recoveryDevice, 'recovery', false);
    expect(admitted.status).toBe('committed');
    const file = await exportBackup(alice, {
      secret: recovery.secret,
      publicKey: recovery.publicKey,
    });
    const restored = await session(host, 'alice-restored');
    const opened = await restoreBackup(restored, file);
    expect(opened.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const phone = await generateDevice();
    restored.device = {
      publicKey: opened.recovery.publicKey,
      enc: opened.recovery.enc,
      signing: opened.recovery.recipientKeyPair,
      encryption: opened.recovery.recipientKeyPair,
      sign: opened.recovery.sign.bind(opened.recovery),
    };
    await restored.reauth();
    const added = await restored.admitDevice(phone, 'personal', false);
    expect(added.status === 'committed' || added.status === 'conflict').toBe(true);
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
});
