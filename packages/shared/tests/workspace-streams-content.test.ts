import { LoroDoc } from 'loro-crdt';
import { describe, expect, it, vi } from 'vitest';
import { getMachineFlockDocId } from '../src/machine-flock';
import { getWorkspaceFlockDocId } from '../src/workspace-flock';
import type { MachineId, WorkspaceId } from '../src/ids';
import {
  encryptedWorkspaceRoom,
  createWorkspaceEpochTransitionLegacy,
} from '../src/workspace-streams-content';

describe('encrypted workspace room domains', () => {
  const workspace = 'room-owner' as WorkspaceId;
  it('accepts the actual shared Meta, session and configuration room identifiers', () => {
    expect(encryptedWorkspaceRoom(workspace, { kind: 'meta' })).toEqual({
      resource: 'meta',
      model: 'flock',
    });
    expect(encryptedWorkspaceRoom(workspace, { kind: 'doc', docId: 'session-id' })).toEqual({
      resource: 'doc:session-id',
      model: 'loro',
    });
    for (const flockDocId of [
      getMachineFlockDocId(workspace, 'local' as MachineId),
      getWorkspaceFlockDocId(workspace),
    ])
      expect(encryptedWorkspaceRoom(workspace, { kind: 'flock', flockDocId })).toEqual({
        resource: `flock:${flockDocId}`,
        model: 'flock',
      });
  });
  it('rejects other workspaces and all unimplemented Flock domains', () => {
    for (const flockDocId of [
      getMachineFlockDocId('other' as WorkspaceId, 'local' as MachineId),
      getWorkspaceFlockDocId('other' as WorkspaceId),
      'wf',
      'mf:local',
      `${workspace}:schedule:registry`,
      `${workspace}:collab:index`,
    ])
      expect(() => encryptedWorkspaceRoom(workspace, { kind: 'flock', flockDocId })).toThrow(
        'Encrypted workspace room is unavailable'
      );
  });
});

const request = {
  context: {
    protocol: 'loro-streams-crdt-payload-protection',
    version: 2,
    kind: 'update_batch',
  } as const,
  plaintext: new Uint8Array([7]),
  additionalData: () => new Uint8Array(),
};
const status = { epoch: 1, rotationRequired: false, hasCurrentKey: true };
const native = (epoch: number) => ({
  maxSealOverheadBytes: 4096,
  seal: async () => ({ header: new Uint8Array([3]), sealed: new Uint8Array([epoch]) }),
  open: async () => new Uint8Array([epoch]),
});
describe('availability-first epoch selection', () => {
  it('keeps rotation hints and pending reception available on the same room provider', async () => {
    const gate = createWorkspaceEpochTransitionLegacy({ epoch: 0, rotationRequired: true });
    const provider = gate.provider(native);
    expect((await provider.seal(request)).sealed).toEqual(new Uint8Array([0]));
    gate.observe(status);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const work = gate.transition({
      install: async () => {
        entered.resolve();
        await release.promise;
        return status;
      },
    });
    await entered.promise;
    const other = createWorkspaceEpochTransitionLegacy({ epoch: 0 });
    expect((await other.provider(native).seal(request)).sealed).toEqual(new Uint8Array([0]));
    await other.close();
    expect((await provider.seal(request)).sealed).toEqual(new Uint8Array([0]));
    release.resolve();
    expect(await work).toBe(true);
    expect((await provider.seal(request)).sealed).toEqual(new Uint8Array([1]));
    await gate.close();
  });
  it('keeps local edits and both workspaces sending after failed reception, then retries', async () => {
    const gate = createWorkspaceEpochTransitionLegacy({ epoch: 0 });
    const other = createWorkspaceEpochTransitionLegacy({ epoch: 0 });
    const doc = new LoroDoc();
    const provider = gate.provider(native);
    try {
      doc.getText('draft').insert(0, 'saved edit');
      doc.commit();
      gate.observe(status);
      await expect(
        gate.transition({
          install: async () => {
            throw new Error('temporary');
          },
        })
      ).rejects.toThrow('temporary');
      expect(gate.phase()).toBe('failed');
      expect((await provider.seal(request)).sealed).toEqual(new Uint8Array([0]));
      expect((await other.provider(native).seal(request)).sealed).toEqual(new Uint8Array([0]));
      expect(doc.getText('draft').toString()).toBe('saved edit');
      expect(await gate.transition({ install: async () => status })).toBe(true);
      expect((await provider.seal(request)).sealed).toEqual(new Uint8Array([1]));
    } finally {
      doc.free();
      await gate.close();
      await other.close();
    }
  });
  it('times out without stopping sends and discards a late installation receipt', async () => {
    vi.useFakeTimers();
    const gate = createWorkspaceEpochTransitionLegacy({ epoch: 0, timeoutMs: 20 });
    const release = Promise.withResolvers<typeof status>();
    try {
      gate.observe(status);
      const work = gate.transition({ install: () => release.promise });
      const result = work.catch((error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(20);
      expect(await result).toBe('e2ee_key_update_timeout');
      await expect(
        gate.transition({
          install: async () => {
            throw new Error('duplicate installation owner');
          },
        })
      ).resolves.toBe(false);
      expect((await gate.provider(native).seal(request)).sealed).toEqual(new Uint8Array([0]));
      release.resolve(status);
      await release.promise;
      await Promise.resolve();
      expect(gate.epoch()).toBe(0);
      expect(await gate.transition({ install: async () => status })).toBe(true);
      expect(gate.epoch()).toBe(1);
    } finally {
      release.resolve(status);
      await gate.close();
      vi.useRealTimers();
    }
  });
  it('never selects a keyless or superseded epoch and can retry the newer verified status', async () => {
    const gate = createWorkspaceEpochTransitionLegacy({ epoch: 0 });
    gate.observe(status);
    expect(
      await gate.transition({ install: async () => ({ ...status, hasCurrentKey: false }) })
    ).toBe(false);
    expect((await gate.provider(native).seal(request)).sealed).toEqual(new Uint8Array([0]));
    const release = Promise.withResolvers<typeof status>();
    const work = gate.transition({ install: () => release.promise });
    gate.observe({ ...status, epoch: 2 });
    release.resolve(status);
    expect(await work).toBe(false);
    expect(gate.epoch()).toBe(0);
    expect(await gate.transition({ install: async () => ({ ...status, epoch: 2 }) })).toBe(true);
    await gate.close();
  });
});
