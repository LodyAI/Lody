import { createStore } from 'jotai';
import { describe, expect, it, vi } from 'vitest';
import { LoroRepo } from 'loro-repo';
import {
  getAgentConfigRoomId,
  getMachineRoomId,
  getSessionRoomId,
  type AgentConfigId,
  type MachineId,
  type SessionId,
} from '@lody/shared';

vi.mock('@/lib/auth-bootstrap', () => ({
  readStoredAuthToken: () => null,
}));

import {
  archivedSessionListAtom,
  docMetaCacheReadyAtom,
  docMetaSubscriptionAtom,
  agentConfigMetaCacheAtom,
  machineMetaCacheAtom,
  sessionListAtom,
  sessionMetaCacheAtom,
} from '../src/atoms/doc-meta';
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';

type RepoWithSyncRunner = LoroRepo & {
  syncRunner: {
    ensureMetaLiveMonitor(): Promise<void>;
    metaHydrationQueue: Promise<void>;
  };
};

type RepoWatchEvent =
  | {
      kind: 'doc-metadata';
      docId: string;
      patch: Record<string, unknown>;
      by: 'live';
    }
  | {
      kind: 'doc-existence-changed';
      docId: string;
      from: 'missing' | 'active' | 'deleted';
      to: 'missing' | 'active' | 'deleted';
      by: 'live';
    };

type CompatRepoEntry = Record<string, unknown> & { docId: string; meta: Record<string, unknown> };

class CompatRepoDouble {
  private readonly listeners = new Set<(event: RepoWatchEvent) => void>();

  constructor(
    private readonly entries: CompatRepoEntry[],
    private readonly snapshots = new Map<string, Record<string, unknown> | undefined>()
  ) {}

  async listDoc(): Promise<CompatRepoEntry[]> {
    return this.entries.map((entry) => ({ ...entry, meta: { ...entry.meta } }));
  }

  async getDocMeta(
    docId: string
  ): Promise<(Record<string, unknown> & { meta: Record<string, unknown> }) | undefined> {
    const snapshot = this.snapshots.get(docId);
    if (!snapshot) return undefined;
    return { ...snapshot, meta: { ...(snapshot.meta as Record<string, unknown>) } };
  }

  watch(listener: (event: RepoWatchEvent) => void): { unsubscribe(): void } {
    this.listeners.add(listener);
    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  emit(event: RepoWatchEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

/** Emits a live event from inside the bootstrap scan, after the snapshot is captured. */
class ScanRacingRepoDouble extends CompatRepoDouble {
  constructor(
    entries: CompatRepoEntry[],
    private readonly duringScan: () => void
  ) {
    super(entries);
  }

  override async listDoc(): Promise<CompatRepoEntry[]> {
    const snapshot = await super.listDoc();
    this.duringScan();
    return snapshot;
  }
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const flushMetaHydration = async (repo: RepoWithSyncRunner): Promise<void> => {
  await Promise.resolve();
  await repo.syncRunner.metaHydrationQueue;
  await flush();
};

const importRemoteMeta = async (
  repo: RepoWithSyncRunner,
  remote: LoroRepo,
  mutateRemote?: () => void
): Promise<void> => {
  mutateRemote?.();
  repo.getMeta().importJson(remote.getMeta().exportJson());
  await flushMetaHydration(repo);
};

const createRuntime = (repo: LoroRepo): WorkspaceRuntime =>
  ({
    workspaceSlug: 'workspace-slug',
    workspaceId: 'workspace-id',
    repo,
    setLocalMachineId: () => {},
    setAuthToken: async () => {},
    ensureDocStream: async () => {},
    withSessionStore: async () => {
      throw new Error('Not implemented in test');
    },
    releaseSessionStore: async () => {},
    acquireSessionStore: async () => {
      throw new Error('Not implemented in test');
    },
    releaseSessionStoreRef: () => {},
    sendControl: () => {},
    waitForSessionCreateResponse: async () => null,
    waitForSessionCancelResponse: async () => null,
    waitForSessionChatResponse: async () => null,
    waitForMachineStatusResponse: async () => null,
    requestMachineAcpCapabilitiesRefresh: async () => null,
    dispose: async () => {},
  }) as WorkspaceRuntime;

describe('docMetaSubscriptionAtom', () => {
  it('observes archive updates that land while the bootstrap snapshot is being read', async () => {
    const sessionId = 'archived-during-bootstrap' as SessionId;
    const docId = getSessionRoomId(sessionId);
    const repo: ScanRacingRepoDouble = new ScanRacingRepoDouble(
      [
        {
          docId,
          exists: true,
          meta: {
            id: sessionId,
            title: 'Archived during bootstrap',
            createdAt: '2026-08-12T00:00:00.000Z',
            isArchived: false,
          },
        },
      ],
      () => {
        repo.emit({ kind: 'doc-metadata', docId, patch: { isArchived: true }, by: 'live' });
      }
    );

    const store = createStore();
    const unmount = store.sub(docMetaSubscriptionAtom, () => {});

    try {
      store.set(runtimeAtom, createRuntime(repo as unknown as LoroRepo));
      await flush();

      expect(store.get(docMetaCacheReadyAtom)).toBe(true);
      expect(store.get(sessionMetaCacheAtom)[docId]?.isArchived).toBe(true);
      expect(store.get(sessionListAtom).map((session) => session.id)).not.toContain(sessionId);
      expect(store.get(archivedSessionListAtom).map((session) => session.id)).toContain(sessionId);
    } finally {
      unmount();
    }
  });

  it('immediately projects same-repo archive and restore writes into session lists', async () => {
    const repo = await LoroRepo.create({});
    const sessionId = 'local-archive-session' as SessionId;
    const docId = getSessionRoomId(sessionId);

    await repo.upsertDocMeta(docId, {
      id: sessionId,
      title: 'Local archive session',
      createdAt: '2026-07-21T00:00:00.000Z',
      isArchived: false,
    });

    const store = createStore();
    const unmount = store.sub(docMetaSubscriptionAtom, () => {});

    try {
      store.set(runtimeAtom, createRuntime(repo));
      await flush();

      expect(store.get(sessionListAtom).map((session) => session.id)).toContain(sessionId);
      expect(store.get(archivedSessionListAtom).map((session) => session.id)).not.toContain(
        sessionId
      );

      await repo.upsertDocMeta(docId, { isArchived: true });

      expect(store.get(sessionMetaCacheAtom)[docId]?.isArchived).toBe(true);
      expect(store.get(sessionListAtom).map((session) => session.id)).not.toContain(sessionId);
      expect(store.get(archivedSessionListAtom).map((session) => session.id)).toContain(sessionId);

      await repo.upsertDocMeta(docId, { isArchived: false });

      expect(store.get(sessionMetaCacheAtom)[docId]?.isArchived).toBe(false);
      expect(store.get(sessionListAtom).map((session) => session.id)).toContain(sessionId);
      expect(store.get(archivedSessionListAtom).map((session) => session.id)).not.toContain(
        sessionId
      );
    } finally {
      unmount();
      await repo.destroy();
    }
  });

  it('bootstraps and updates machine metadata from real loro-repo watch events', async () => {
    const repo = (await LoroRepo.create({})) as RepoWithSyncRunner;
    const remote = await LoroRepo.create({});
    const machineId = 'machine-1' as MachineId;
    const docId = getMachineRoomId(machineId);

    // Electron local-first mode imports renderer metadata directly into the
    // CLI repo's meta Flock while no cloud transport is registered. The repo
    // must hydrate its metadata cache and emit watch events in that state.
    await importRemoteMeta(repo, remote, () => {
      remote.getMeta().put(['e', docId], true);
      remote.getMeta().put(['m', docId], { id: machineId, name: 'dev-box', lastSeen: 1 });
    });

    const store = createStore();
    const unmount = store.sub(docMetaSubscriptionAtom, () => {});

    try {
      store.set(runtimeAtom, createRuntime(repo));
      await flush();

      expect(store.get(docMetaCacheReadyAtom)).toBe(true);
      expect(store.get(machineMetaCacheAtom)).toEqual({
        [docId]: { id: machineId, name: 'dev-box', lastSeen: 1 },
      });

      for (let lastSeen = 2; lastSeen <= 200; lastSeen += 1) {
        remote.getMeta().put(['m', docId, 'lastSeen'], lastSeen);
        repo.getMeta().importJson(remote.getMeta().exportJson());
      }
      await flushMetaHydration(repo);

      expect(store.get(machineMetaCacheAtom)[docId]).toEqual({
        id: machineId,
        name: 'dev-box',
        lastSeen: 200,
      });
    } finally {
      unmount();
      await Promise.all([remote.destroy(), repo.destroy()]);
    }
  });

  it('clears deleted docs and restores full metadata after deleted-to-active transitions', async () => {
    const repo = (await LoroRepo.create({})) as RepoWithSyncRunner;
    const remote = await LoroRepo.create({});
    const machineId = 'machine-2' as MachineId;
    const docId = getMachineRoomId(machineId);

    await importRemoteMeta(repo, remote, () => {
      remote.getMeta().put(['e', docId], true);
      remote.getMeta().put(['m', docId], { id: machineId, name: 'ci-box', lastSeen: 10 });
    });

    const store = createStore();
    const unmount = store.sub(docMetaSubscriptionAtom, () => {});

    try {
      store.set(runtimeAtom, createRuntime(repo));
      await flush();

      expect(store.get(machineMetaCacheAtom)[docId]).toEqual({
        id: machineId,
        name: 'ci-box',
        lastSeen: 10,
      });

      await importRemoteMeta(repo, remote, () => {
        remote.getMeta().put(['e', docId], false);
      });
      expect(store.get(machineMetaCacheAtom)[docId]).toBeUndefined();

      await importRemoteMeta(repo, remote, () => {
        remote.getMeta().put(['e', docId], true);
        remote.getMeta().put(['m', docId, 'lastSeen'], 11);
      });
      expect(store.get(machineMetaCacheAtom)[docId]).toEqual({
        id: machineId,
        name: 'ci-box',
        lastSeen: 11,
      });
    } finally {
      unmount();
      await Promise.all([remote.destroy(), repo.destroy()]);
    }
  });

  it('honors exists/e compatibility flags during bootstrap and existence refreshes', async () => {
    const machineId = 'machine-compat' as MachineId;
    const docId = getMachineRoomId(machineId);
    const repo = new CompatRepoDouble(
      [
        {
          docId,
          exists: false,
          meta: { id: machineId, name: 'ghost-box', lastSeen: 1 },
        },
      ],
      new Map([
        [
          docId,
          {
            exists: false,
            meta: { id: machineId, name: 'ghost-box', lastSeen: 1 },
          },
        ],
      ])
    );

    const store = createStore();
    const unmount = store.sub(docMetaSubscriptionAtom, () => {});

    try {
      store.set(runtimeAtom, createRuntime(repo as unknown as LoroRepo));
      await flush();

      expect(store.get(docMetaCacheReadyAtom)).toBe(true);
      expect(store.get(machineMetaCacheAtom)[docId]).toBeUndefined();

      repo.emit({
        kind: 'doc-existence-changed',
        docId,
        from: 'deleted',
        to: 'active',
        by: 'live',
      });
      await flush();

      expect(store.get(machineMetaCacheAtom)[docId]).toBeUndefined();
    } finally {
      unmount();
    }
  });

  it('defers live metadata patches to a macrotask so reconnect bursts can paint', async () => {
    const machineId = 'machine-yield' as MachineId;
    const docId = getMachineRoomId(machineId);
    const repo = new CompatRepoDouble([
      {
        docId,
        exists: true,
        meta: { id: machineId, name: 'phone-box', lastSeen: 1 },
      },
    ]);

    const store = createStore();
    const unmount = store.sub(docMetaSubscriptionAtom, () => {});

    try {
      store.set(runtimeAtom, createRuntime(repo as unknown as LoroRepo));
      await flush();

      repo.emit({
        kind: 'doc-metadata',
        docId,
        patch: { lastSeen: 2 },
        by: 'live',
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(store.get(machineMetaCacheAtom)[docId]).toEqual({
        id: machineId,
        name: 'phone-box',
        lastSeen: 1,
      });

      await flush();

      expect(store.get(machineMetaCacheAtom)[docId]).toEqual({
        id: machineId,
        name: 'phone-box',
        lastSeen: 2,
      });
    } finally {
      unmount();
    }
  });

  it('fetches full agent config metadata when a metadata patch arrives for an uncached doc', async () => {
    const agentId = 'agent-created-from-settings' as AgentConfigId;
    const docId = getAgentConfigRoomId(agentId);
    const fullMeta = {
      id: agentId,
      name: 'Codex Settings Agent',
      description: undefined,
      cliType: 'builtin',
      agentType: 'codex',
      env: {},
      prompt: 'Use Codex.',
    };
    const repo = new CompatRepoDouble([], new Map([[docId, { exists: true, meta: fullMeta }]]));

    const store = createStore();
    const unmount = store.sub(docMetaSubscriptionAtom, () => {});

    try {
      store.set(runtimeAtom, createRuntime(repo as unknown as LoroRepo));
      await flush();

      expect(store.get(docMetaCacheReadyAtom)).toBe(true);
      expect(store.get(agentConfigMetaCacheAtom)[docId]).toBeUndefined();

      repo.emit({
        kind: 'doc-metadata',
        docId,
        patch: { name: 'Codex Settings Agent' },
        by: 'live',
      });
      await flush();

      expect(store.get(agentConfigMetaCacheAtom)[docId]).toEqual(fullMeta);
    } finally {
      unmount();
    }
  });
});
