import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LoroRepo,
  ResourceBusyError,
  type TransportAdapter,
  type TransportSubscription,
} from 'loro-repo';
import { getWorkspaceFlockDocId, type WorkspaceId } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { WorkspaceCatalogSyncLegacy } from './workspace-catalog-sync-legacy';

const workspaceId = 'promise-catalog-test' as WorkspaceId;
const logger = { debug: () => {} } as Logger;

describe('Promise Repo catalog readers', () => {
  afterEach(() => vi.useRealTimers());

  it('retains readers after timeout, remembers baseline after detach, and releases before Repo close', async () => {
    vi.useFakeTimers();
    const repo = await LoroRepo.create({});
    const catalog = new WorkspaceCatalogSyncLegacy(repo, workspaceId, logger, true);
    const live = new Set<string>();
    const baselines = new Map<string, () => void>();
    const join = (id: string): TransportSubscription => {
      live.add(id);
      const firstSyncedWithRemote = new Promise<void>((resolve) => baselines.set(id, resolve));
      return {
        status: 'joined',
        firstSyncedWithRemote,
        waitUntilSynced: () => firstSyncedWithRemote,
        onStatusChange: () => () => {},
        unsubscribe: () => {
          live.delete(id);
        },
      };
    };
    const adapter: TransportAdapter = {
      connect: async () => {},
      close: async () => {},
      isConnected: () => true,
      getStatus: () => 'connected',
      onStatusChange: () => () => {},
      syncMeta: async () => ({ ok: true }),
      syncDoc: async () => ({ ok: true }),
      joinMetaRoom: () => join('meta'),
      joinDocRoom: (id) => join(id),
      joinFlockDocRoom: (id) => join(id),
    };
    try {
      const id = getWorkspaceFlockDocId(workspaceId);
      expect(await catalog.ready(id, 0)).toBe(false);
      await repo.addTransport('streams', adapter);
      await Promise.all([catalog.hold(id), catalog.hold(id)]);
      const pending = catalog.ready(id, 100);
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).toBe(false);
      expect(live).toEqual(new Set(['meta', id]));
      baselines.get(id)?.();
      expect(await catalog.ready(id, 100)).toBe(true);
      await repo.removeTransport('streams');
      expect(await catalog.ready(id, 0)).toBe(true);
      expect(await catalog.ready(undefined, 0)).toBe(false);
      await repo.addTransport('streams', adapter);
      baselines.get('meta')?.();
      expect(await catalog.ready(undefined, 100)).toBe(true);
    } finally {
      await catalog.close();
      await repo.destroy();
    }
    expect(live.size).toBe(0);
  });

  it('keeps slow joins off hold and bounds readiness, then retries a failed acquisition', async () => {
    vi.useFakeTimers();
    const repo = await LoroRepo.create({});
    const join = repo.joinFlockDocRoom.bind(repo);
    let rejectJoin: (error: Error) => void = () => {};
    vi.spyOn(repo, 'joinFlockDocRoom').mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectJoin = reject;
        })
    );
    const catalog = new WorkspaceCatalogSyncLegacy(repo, workspaceId, logger, false);
    try {
      const id = getWorkspaceFlockDocId(workspaceId);
      await catalog.hold(id);
      const pending = catalog.ready(id, 100);
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).toBe(false);
      rejectJoin(new Error('temporary local load failure'));
      await vi.advanceTimersByTimeAsync(0);
      vi.mocked(repo.joinFlockDocRoom).mockImplementation(join);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await catalog.ready(id, 0)).toBe(true);
      await expect(repo.unloadFlockDoc(id)).rejects.toBeInstanceOf(ResourceBusyError);
      await catalog.close();
      await repo.unloadFlockDoc(id);
      expect(repo.transportRooms('streams')).toEqual([]);
    } finally {
      await catalog.close();
      await repo.destroy();
    }
  });
});
