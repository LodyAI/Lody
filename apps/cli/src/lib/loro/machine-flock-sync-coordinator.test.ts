import { describe, expect, it, vi } from 'vitest';
import type { LoroRepo } from 'loro-repo';
import type { MachineId, WorkspaceId } from '@lody/shared';
import { machineFlockKeys, writeMachineFlockRowToFlock } from '@lody/shared';
import { Flock } from '@loro-dev/flock-wasm';
import { MachineFlockSyncCoordinator } from './machine-flock-sync-coordinator';

const noopLogger = {
  debug: vi.fn(),
  trace: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const makeCoordinator = (syncOnce: () => Promise<unknown>) => {
  const binding = {
    transportId: 'streams',
    status: 'joined' as const,
    onStatusChange: vi.fn(() => vi.fn()),
    firstSyncedWithRemote: Promise.resolve(),
    waitUntilSynced: vi.fn(async () => {}),
    rejoin: vi.fn(async () => {}),
  };
  const joinRoom = vi.fn(async () => ({
    unsubscribe: vi.fn(),
    firstSyncedWithRemote: Promise.resolve(),
    waitUntilSynced: vi.fn(async () => {}),
    transportIds: () => ['streams'],
    subscription: () => binding,
    subscriptions: () => [binding],
    status: 'joined' as const,
    onStatusChange: vi.fn(() => vi.fn()),
    rejoin: vi.fn(async () => {}),
  }));
  const openFlockDoc = vi.fn(async () => ({
    flock: { scan: vi.fn(() => []), subscribe: vi.fn(() => vi.fn()) },
    syncOnce: vi.fn(syncOnce),
    joinRoom,
  }));
  const coordinator = new MachineFlockSyncCoordinator({
    repo: { openFlockDoc } as unknown as LoroRepo,
    workspaceId: 'workspace-1' as WorkspaceId,
    logger: noopLogger as never,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 2,
    random: () => 0.5,
  });
  return coordinator;
};

describe('MachineFlockSyncCoordinator sync confirmation', () => {
  it('observes loaded project registrations without acquiring, syncing or rewriting a catalog', async () => {
    const machineId = 'machine-1' as MachineId;
    const projectId = 'synthetic-project' as import('@lody/shared').LocalProjectId;
    const flock = new Flock();
    let allowIo = false;
    const handle = {
      flock,
      joinRoom: async () => {
        if (!allowIo) throw new Error('query tried to join');
        return {
          unsubscribe() {},
          firstSyncedWithRemote: Promise.resolve(),
          status: 'detached',
          onStatusChange: () => () => {},
          subscription: () => ({
            status: 'detached',
            firstSyncedWithRemote: Promise.resolve(),
            onStatusChange: () => () => {},
          }),
        };
      },
    };
    const coordinator = new MachineFlockSyncCoordinator({
      repo: {
        openFlockDoc: async () => {
          if (!allowIo) throw new Error('query tried to open storage');
          return handle;
        },
      } as unknown as LoroRepo,
      workspaceId: 'workspace-1' as WorkspaceId,
      logger: noopLogger as never,
    });
    expect(coordinator.peekLocalProjectRootPath(machineId, projectId)).toBeNull();
    writeMachineFlockRowToFlock(
      flock,
      {
        key: machineFlockKeys.localProject(projectId),
        value: {
          id: projectId,
          name: 'Synthetic',
          rootPath: '/synthetic/first',
          createdAtMs: 1,
        },
      },
      1
    );
    try {
      allowIo = true;
      await coordinator.ensureJoined(machineId);
      allowIo = false;
      expect(coordinator.peekLocalProjectRootPath(machineId, projectId)).toBe('/synthetic/first');
      writeMachineFlockRowToFlock(
        flock,
        {
          key: machineFlockKeys.localProject(projectId),
          value: {
            id: projectId,
            name: 'Synthetic',
            rootPath: '/synthetic/current',
            createdAtMs: 1,
          },
        },
        2
      );
      const before = await flock.exportFile();
      expect(coordinator.peekLocalProjectRootPath(machineId, projectId)).toBe('/synthetic/current');
      expect(await flock.exportFile()).toEqual(before);
    } finally {
      await coordinator.cleanUp();
    }
    expect(coordinator.peekLocalProjectRootPath(machineId, projectId)).toBeNull();
  });
  it('confirms only a non-empty ok report', async () => {
    const coordinator = makeCoordinator(async () => ({
      ok: true,
      transports: [{ transportId: 'streams', ok: true, failures: [] }],
    }));
    const machineId = 'machine-1' as MachineId;
    coordinator.markDirty(machineId, { scheduleRetry: false });
    await expect(coordinator.syncNow(machineId, { scheduleRetry: false })).resolves.toBe(true);
    await coordinator.cleanUp();
  });

  it('treats a zero-transport (offline) resolve as unconfirmed and keeps the doc dirty', async () => {
    // A vacuous resolve with no attached transports must never count as cloud
    // confirmation — that lie was exactly the "offline claimed as synced"
    // failure class this migration removes.
    const coordinator = makeCoordinator(async () => ({ ok: true, transports: [] }));
    const machineId = 'machine-1' as MachineId;
    coordinator.markDirty(machineId, { scheduleRetry: false });
    await expect(coordinator.syncNow(machineId, { scheduleRetry: false })).resolves.toBe(false);
    // Still dirty: a later retryDirtyNow (fired on meta-room-synced after the
    // transport attaches) re-attempts this doc.
    const retried = vi.spyOn(coordinator, 'syncNow');
    coordinator.retryDirtyNow('meta-room-synced');
    expect(retried).toHaveBeenCalledWith(
      machineId,
      expect.objectContaining({ reason: 'meta-room-synced' })
    );
    await coordinator.cleanUp();
  });
});
