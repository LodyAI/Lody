/**
 * Integration pins for the native multi-transport migration, against the REAL
 * loro-repo (no mocks). This is the test class whose absence let a
 * zero-transport startup break ship: unit tests fake the repo, so nothing
 * exercised what `joinMetaRoom()` / room bindings actually do while no
 * transport is registered.
 *
 * Pinned semantics:
 * 1. Joining rooms with ZERO registered transports succeeds — the room is
 *    PENDING, its per-transport 'streams' binding reports 'detached', and the
 *    classic single-value surface must not be relied on (it throws while no
 *    transport is routed and maps 'detached' to 'disconnected').
 *    Requires loro-repo >=0.19.1 (0.19.0 threw "Transport adapter not
 *    configured" here — the break this test class exists to catch).
 * 2. A binding handle is stable across removeTransport/addTransport cycles:
 *    it reports 'detached' while the transport is absent (the CLI must treat
 *    that as healthy-idle, not recover-spin) and resumes live status on
 *    re-attach.
 * 3. After `repo.addTransport('streams', ...)`, pending/detached rooms attach:
 *    the binding reaches 'joined' and sync waits confirm again.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EphemeralStore } from 'loro-crdt';
import { LoroRepo } from 'loro-repo';
import type {
  RepoTransportRoomStatus,
  RepoTransportRoomSubscription,
  TransportAdapter,
  TransportConnectionStatus,
  TransportSubscription,
  TransportSyncResult,
} from 'loro-repo';
import type { WorkspaceId } from '@lody/shared';

import { LoroDocumentManager } from '../src/lib/loro/doc';
import type { Logger } from '../src/utils/logger';

const OK: TransportSyncResult = { ok: true };

const joinedSubscription = (): TransportSubscription => ({
  unsubscribe: () => {},
  firstSyncedWithRemote: Promise.resolve(),
  waitUntilSynced: async () => {},
  status: 'joined',
  onStatusChange: (listener) => {
    listener('joined');
    return () => {};
  },
});

/**
 * Minimal always-connected in-memory transport adapter. This fakes the
 * NETWORK, not loro-repo: the repo under test is the real implementation.
 */
class FakeStreamsAdapter implements TransportAdapter {
  private connected = false;

  async connect(): Promise<void> {
    this.connected = true;
  }
  async close(): Promise<void> {
    this.connected = false;
  }
  isConnected(): boolean {
    return this.connected;
  }
  getStatus(): TransportConnectionStatus {
    return this.connected ? 'connected' : 'disconnected';
  }
  onStatusChange(): () => void {
    return () => {};
  }
  async syncMeta(): Promise<TransportSyncResult> {
    return OK;
  }
  joinMetaRoom(): TransportSubscription {
    return joinedSubscription();
  }
  async syncDoc(): Promise<TransportSyncResult> {
    return OK;
  }
  joinDocRoom(): TransportSubscription {
    return joinedSubscription();
  }
  async syncFlockDoc(): Promise<TransportSyncResult> {
    return OK;
  }
  joinFlockDocRoom(): TransportSubscription {
    return joinedSubscription();
  }
  async forgetFlockDoc(): Promise<void> {}
  joinEphemeralRoom(): TransportSubscription & { store: EphemeralStore } {
    return { ...joinedSubscription(), store: new EphemeralStore(30_000) };
  }
}

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

const createManager = (
  repo: LoroRepo,
  metaSub: TransportSubscription,
  workspaceId: string
): LoroDocumentManager =>
  new LoroDocumentManager({
    repo,
    workspaceId: workspaceId as WorkspaceId,
    userId: 'user-1',
    metaSub,
    logger: createSilentLogger(),
    initialTransportStatus: 'connected',
    initialMetaSyncPromise: Promise.resolve(false),
    initialMetaSyncCompleted: false,
  });

const bindingStatusReached = (
  binding: RepoTransportRoomSubscription,
  wanted: RepoTransportRoomStatus
): Promise<void> =>
  new Promise((resolve) => {
    const detach = binding.onStatusChange((status) => {
      if (status === wanted) {
        detach();
        resolve();
      }
    });
    if (binding.status === wanted) {
      detach();
      resolve();
    }
  });

const originalWaitMetaTimeoutEnv = process.env.LODY_LORO_WAIT_META_SYNC_TIMEOUT_MS;
const originalReconnectIntervalEnv = process.env.LODY_LORO_AUTO_RECONNECT_INTERVAL_MS;

describe('native multi-transport against real loro-repo', () => {
  beforeEach(() => {
    // A regressed detached fast-path would burn this timeout and trip the test
    // timeout instead of silently passing.
    process.env.LODY_LORO_WAIT_META_SYNC_TIMEOUT_MS = '60000';
    process.env.LODY_LORO_AUTO_RECONNECT_INTERVAL_MS = '0';
  });

  afterEach(() => {
    if (originalWaitMetaTimeoutEnv === undefined) {
      delete process.env.LODY_LORO_WAIT_META_SYNC_TIMEOUT_MS;
    } else {
      process.env.LODY_LORO_WAIT_META_SYNC_TIMEOUT_MS = originalWaitMetaTimeoutEnv;
    }
    if (originalReconnectIntervalEnv === undefined) {
      delete process.env.LODY_LORO_AUTO_RECONNECT_INTERVAL_MS;
    } else {
      process.env.LODY_LORO_AUTO_RECONNECT_INTERVAL_MS = originalReconnectIntervalEnv;
    }
  });

  it('binding stays stable across removeTransport/addTransport and detached is healthy-idle', async () => {
    const repo = await LoroRepo.create({});
    await repo.addTransport('streams', new FakeStreamsAdapter(), { ephemeral: true });
    const metaSub = await repo.joinMetaRoom();
    const manager = createManager(repo, metaSub, 'workspace-cycle');
    try {
      const binding = metaSub.subscription('streams');
      await binding.firstSyncedWithRemote;
      expect(binding.status).toBe('joined');
      await expect(manager.waitUntilMetaSynced({ reason: 'attached' })).resolves.toBe(true);
      expect(manager.hasCompletedInitialMetaSync()).toBe(true);

      // Deliberate detach: the SAME binding handle reports 'detached', the
      // manager must treat local-only as healthy (no recovery spin), and sync
      // waits answer "not confirmed" fast instead of burning the (60s) timeout.
      await repo.removeTransport('streams', { close: true });
      expect(binding.status).toBe('detached');
      expect(metaSub.transportIds()).toEqual([]);
      expect(manager.isTransportRecovering()).toBe(false);
      await expect(manager.waitUntilMetaSynced({ reason: 'detached' })).resolves.toBe(false);

      // Re-attach: the same handle resumes live reporting and sync confirms.
      await repo.addTransport('streams', new FakeStreamsAdapter(), { ephemeral: true });
      await bindingStatusReached(binding, 'joined');
      await expect(manager.waitUntilMetaSynced({ reason: 're-attached' })).resolves.toBe(true);
    } finally {
      await manager.cleanUp({ fast: true });
    }
  });

  it('joins rooms as pending with zero transports; bindings report detached', async () => {
    const repo = await LoroRepo.create({});
    try {
      const metaSub = await repo.joinMetaRoom();
      expect(metaSub.transportIds()).toEqual([]);
      expect(metaSub.subscription('streams').status).toBe('detached');

      const docSub = await repo.joinDocRoom('doc-zero-transport');
      expect(docSub.subscription('streams').status).toBe('detached');
      docSub.unsubscribe();
      metaSub.unsubscribe();
    } finally {
      await repo.destroy();
    }
  });

  it('manager over a zero-transport repo is healthy offline and answers sync waits fast', async () => {
    const repo = await LoroRepo.create({});
    const metaSub = await repo.joinMetaRoom();
    const manager = createManager(repo, metaSub, 'workspace-integration');
    try {
      // Local-only is healthy-idle, not a degraded transport needing recovery.
      expect(manager.isTransportRecovering()).toBe(false);
      // Detached fast-path: "not confirmed" without consuming the timeout.
      await expect(manager.waitUntilMetaSynced({ reason: 'integration-offline' })).resolves.toBe(
        false
      );
      expect(manager.hasCompletedInitialMetaSync()).toBe(false);
    } finally {
      await manager.cleanUp({ fast: true });
    }
  });

  it('attaches pending rooms once addTransport registers streams', async () => {
    const repo = await LoroRepo.create({});
    const metaSub = await repo.joinMetaRoom();
    const manager = createManager(repo, metaSub, 'workspace-attach');
    try {
      const docSub = await repo.joinDocRoom('doc-attach');
      const metaBinding = metaSub.subscription('streams');
      const docBinding = docSub.subscription('streams');
      expect(metaBinding.status).toBe('detached');
      expect(docBinding.status).toBe('detached');

      await repo.addTransport('streams', new FakeStreamsAdapter(), { ephemeral: true });

      // The stable binding handles resume live reporting and settle their
      // first-sync promises — explicit completion signals, no polling.
      await metaBinding.firstSyncedWithRemote;
      await docBinding.firstSyncedWithRemote;
      expect(metaBinding.status).toBe('joined');
      expect(docBinding.status).toBe('joined');
      expect(metaSub.transportIds()).toEqual(['streams']);

      // The recovery controller followed the same binding: pending writes
      // can now be confirmed through the attached transport.
      await expect(manager.waitUntilMetaSynced({ reason: 'integration-attached' })).resolves.toBe(
        true
      );
      expect(manager.hasCompletedInitialMetaSync()).toBe(true);

      docSub.unsubscribe();
    } finally {
      await manager.cleanUp({ fast: true });
    }
  });
});
