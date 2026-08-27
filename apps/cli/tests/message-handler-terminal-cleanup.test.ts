import { describe, expect, it, vi } from 'vitest';

import {
  getMachineRoomId,
  getSessionRoomId,
  machineFlockKeys,
  SessionStatusFactory,
  type LocalProjectId,
  type MachineFlockScanRow,
  type NeedToDeleteSessionQueueItem,
  type AcpSessionNotification,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { MessageHandler } from '../src/lib/message-handler';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import type { SessionManager } from '../src/session/session-manager';
import type { Logger } from '../src/utils/logger';
import { createTestCloudPort } from './test-cloud-port';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

type MessageHandlerInternals = {
  archiveSessionResources: (
    sessionId: SessionId,
    options?: { preserveWorktree?: boolean }
  ) => Promise<void>;
  deleteLocalProjectResources: (
    localProjectId: LocalProjectId,
    command: { v: 1; requestedAt: number }
  ) => Promise<void>;
  resolveWorktreeCleanupTarget: (...args: unknown[]) => unknown;
  deleteSessionResources: (sessionId: SessionId) => Promise<{ keptWorktreePath?: string }>;
  writeKeptWorktreePath: (
    sessionId: SessionId,
    request: NeedToDeleteSessionQueueItem | undefined,
    keptWorktreePath: string
  ) => Promise<void>;
  enqueueACPUpdate: (sessionId: SessionId, update: AcpSessionNotification) => void;
  quiesceACPFlushForDeletion: (sessionId: SessionId) => Promise<void>;
  codeCollabV2PendingEvidenceWrites: Map<SessionId, Set<Promise<void>>>;
  codeCollabV2TurnDiffs: Map<string, unknown[]>;
  deletedSessionIds: Set<SessionId>;
  deleteInFlight: Set<SessionId>;
  store: {
    has: (sessionId: SessionId) => boolean;
    get: (sessionId: SessionId) => { acpFlushInFlight: Promise<void> | null };
  };
  previewService: {
    closeSessionPreviewForCleanup: (sessionId: SessionId, reason: string) => Promise<void>;
  };
};

function createHarness(options?: {
  sessionId?: SessionId;
  childSessionIds?: SessionId[];
  closeSessionTerminals?: (sessionId: SessionId) => void;
  machineFlockRows?: MachineFlockScanRow[];
  sessionMetas?: SessionMeta[];
  activeSessionIds?: SessionId[];
  includeLegacySessionDeleteRequest?: boolean;
}) {
  const sessionId = options?.sessionId ?? ('session-1' as SessionId);
  const childSessionIds = options?.childSessionIds ?? [];
  const machineId = 'machine-1';
  const sessionRoomId = getSessionRoomId(sessionId);
  const machineRoomId = getMachineRoomId(machineId);
  const machineFlockRows = [...(options?.machineFlockRows ?? [])];
  const sessionMetas = new Map(
    (options?.sessionMetas ?? []).map((meta) => [getSessionRoomId(meta.id), meta] as const)
  );
  const activeSessionIds = new Set(options?.activeSessionIds ?? []);
  const events: string[] = [];
  const flockSet = vi.fn((key: readonly unknown[], value: unknown) => {
    const rowIndex = machineFlockRows.findIndex(
      (row) => JSON.stringify(row.key) === JSON.stringify(key)
    );
    const nextRow = { key, value };
    if (rowIndex >= 0) {
      machineFlockRows[rowIndex] = nextRow;
    } else {
      machineFlockRows.push(nextRow);
    }
  });
  const flockCommit = vi.fn();
  const flockDelete = vi.fn((key: readonly unknown[]) => {
    events.push(`flock-delete:${JSON.stringify(key)}`);
    const rowIndex = machineFlockRows.findIndex(
      (row) => JSON.stringify(row.key) === JSON.stringify(key)
    );
    if (rowIndex >= 0) machineFlockRows.splice(rowIndex, 1);
  });
  const sessionDoc = {
    updateHistory: vi.fn(async (updater: (history: unknown[]) => unknown[]) => {
      updater([]);
    }),
    waitUntilSynced: vi.fn(async () => {}),
    setLastMessageAt: vi.fn(async () => {}),
  };
  const repo = {
    watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
    getDocMeta: vi.fn(async (roomId: string) => {
      const localSessionMeta = sessionMetas.get(roomId);
      if (localSessionMeta) {
        return { meta: localSessionMeta };
      }
      if (roomId === sessionRoomId) {
        return { meta: { isArchived: true } };
      }
      if (roomId === machineRoomId) {
        return {
          meta: {
            needToArchiveSessions: {},
            needToDeleteSessions:
              options?.includeLegacySessionDeleteRequest === false ? {} : { [sessionId]: true },
          },
        };
      }
      return { meta: {} };
    }),
    getMeta: vi.fn(() => ({
      scan: vi.fn(async ({ prefix }: { prefix: readonly unknown[] }) =>
        prefix[0] === 'e'
          ? [...sessionMetas.keys()].map((roomId) => ({ key: ['e', roomId], value: true }))
          : []
      ),
    })),
    openFlockDoc: vi.fn(async () => ({
      flock: {
        scan: () => machineFlockRows,
        set: flockSet,
        delete: flockDelete,
        commit: flockCommit,
      },
      syncOnce: vi.fn(async () => {}),
    })),
    upsertDocMeta: vi.fn(async (roomId: string, patch: Partial<SessionMeta>) => {
      events.push(`meta:${roomId}:${patch.isArchived === true ? 'archived' : 'other'}`);
      const current = sessionMetas.get(roomId);
      if (current) sessionMetas.set(roomId, { ...current, ...patch });
    }),
    deleteDoc: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
  };
  const workspaceDocument = {
    sessions: new Map<SessionId, unknown>(),
    repo,
    getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
    isTransportConnected: vi.fn(() => true),
    markMachineFlockDocDirty: vi.fn(),
  };
  const sessionManager = {
    on: vi.fn(),
    setRequestPermissionHandler: vi.fn(),
    getActiveChildSessionIds: vi.fn(() => childSessionIds),
    hasSession: vi.fn((id: SessionId) => activeSessionIds.has(id)),
    terminateSession: vi.fn(async (id: SessionId) => {
      activeSessionIds.delete(id);
    }),
    archiveSession: vi.fn(async () => {}),
    cleanUp: vi.fn(async () => {}),
    setSessionError: vi.fn(async () => {}),
  };
  const closeSessionTerminals = options?.closeSessionTerminals ?? vi.fn();

  const handler = new MessageHandler(
    sessionManager as unknown as SessionManager,
    workspaceDocument as unknown as LoroDocumentManager,
    createSilentLogger(),
    {
      token: 'token',
      workspaceId: 'workspace-1' as WorkspaceId,
      userId: 'user-1',
      machineId,
      machineName: 'machine',
      cliVersion: '0.0.0',
      closeSessionTerminals,
      cloudPort: createTestCloudPort(),
    }
  );
  const internal = handler as unknown as MessageHandlerInternals;
  internal.previewService = {
    closeSessionPreviewForCleanup: vi.fn(async () => {}),
  };

  return {
    handler: internal,
    sessionId,
    childSessionIds,
    closeSessionTerminals,
    sessionManager,
    repo,
    events,
    machineFlockRows,
    flockSet,
    flockCommit,
  };
}

describe('MessageHandler terminal cleanup', () => {
  it('closes session terminals when archiving resources even without an active session', async () => {
    const { handler, sessionId, closeSessionTerminals, sessionManager } = createHarness();

    await handler.archiveSessionResources(sessionId);

    expect(closeSessionTerminals).toHaveBeenCalledWith(sessionId);
    expect(sessionManager.terminateSession).not.toHaveBeenCalled();
  });

  it('closes parent and active child terminals before permanent deletion cleanup', async () => {
    const childSessionId = 'child-1' as SessionId;
    const { handler, sessionId, closeSessionTerminals } = createHarness({
      childSessionIds: [childSessionId],
    });

    await handler.deleteSessionResources(sessionId);

    expect(closeSessionTerminals).toHaveBeenCalledWith(childSessionId);
    expect(closeSessionTerminals).toHaveBeenCalledWith(sessionId);
  });

  it('drops transient ACP retry state before deletion and rejects late output', async () => {
    const { handler, sessionId, repo } = createHarness();

    await handler.deleteSessionResources(sessionId);

    expect(repo.deleteDoc).toHaveBeenCalledWith(getSessionRoomId(sessionId));
    expect(handler.store.has(sessionId)).toBe(false);

    handler.enqueueACPUpdate(sessionId, {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'late output' },
      },
    });

    expect(handler.store.has(sessionId)).toBe(false);
  });

  it('keeps a failed session-doc deletion retryable', async () => {
    const { handler, sessionId, repo } = createHarness();
    await vi.waitFor(() => expect(handler.deleteInFlight.size).toBe(0));
    handler.deletedSessionIds.clear();
    repo.deleteDoc.mockClear();
    repo.deleteDoc.mockRejectedValueOnce(new Error('temporary delete failure'));

    await expect(handler.deleteSessionResources(sessionId)).rejects.toThrow(
      'temporary delete failure'
    );
    expect(handler.deletedSessionIds.has(sessionId)).toBe(false);
    const callsAfterFailure = repo.deleteDoc.mock.calls.length;

    await expect(handler.deleteSessionResources(sessionId)).resolves.toEqual({});
    expect(repo.deleteDoc.mock.calls.length).toBeGreaterThan(callsAfterFailure);
    expect(handler.deletedSessionIds.has(sessionId)).toBe(true);
  });

  it('waits for an in-flight ACP write before dropping deletion state', async () => {
    const { handler, sessionId } = createHarness();
    let releaseWrite: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    handler.store.get(sessionId).acpFlushInFlight = inFlight;
    let quiesced = false;

    const quiesce = handler.quiesceACPFlushForDeletion(sessionId).then(() => {
      quiesced = true;
    });
    await Promise.resolve();

    expect(quiesced).toBe(false);
    expect(handler.store.has(sessionId)).toBe(true);

    releaseWrite?.();
    await quiesce;

    expect(handler.store.has(sessionId)).toBe(false);
  });

  it('waits for an in-flight evidence collector before dropping deletion state', async () => {
    const { handler, sessionId } = createHarness();
    const key = `${sessionId}\0turn-delete`;
    let releaseCollector: (() => void) | undefined;
    let trackedCollector: Promise<void>;
    const pending = new Set<Promise<void>>();
    const collector = new Promise<void>((resolve) => {
      releaseCollector = () => {
        handler.codeCollabV2TurnDiffs.set(key, [{ path: 'a.txt', oldText: 'old', newText: 'new' }]);
        resolve();
      };
    });
    trackedCollector = collector.finally(() => {
      pending.delete(trackedCollector);
      if (pending.size === 0) {
        handler.codeCollabV2PendingEvidenceWrites.delete(sessionId);
      }
    });
    pending.add(trackedCollector);
    handler.codeCollabV2PendingEvidenceWrites.set(sessionId, pending);
    let quiesced = false;

    const quiesce = handler.quiesceACPFlushForDeletion(sessionId).then(() => {
      quiesced = true;
    });
    await Promise.resolve();

    expect(quiesced).toBe(false);

    releaseCollector?.();
    await quiesce;

    expect(handler.codeCollabV2TurnDiffs.has(key)).toBe(false);
    expect(handler.store.has(sessionId)).toBe(false);
  });

  it('archives root and child sessions before removing their local project without touching worktrees', async () => {
    const localProjectId = 'local-project-remove' as LocalProjectId;
    const rootSessionId = 'session-project-root' as SessionId;
    const childSessionId = 'session-project-child' as SessionId;
    const project = { kind: 'local', localProjectId } as const;
    const sessionMetas = [
      {
        id: rootSessionId,
        machineId: 'machine-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        userId: 'user-1',
        cliType: 'codex',
        agentType: 'codex',
        status: SessionStatusFactory.running(),
        project,
      },
      {
        id: childSessionId,
        machineId: 'machine-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        userId: 'user-1',
        cliType: 'codex',
        agentType: 'codex',
        status: SessionStatusFactory.running(),
        project,
        parentSessionId: rootSessionId,
      },
    ] as SessionMeta[];
    const localProjectKey = machineFlockKeys.localProject(localProjectId);
    const { handler, repo, sessionManager, events, machineFlockRows } = createHarness({
      sessionId: rootSessionId,
      childSessionIds: [childSessionId],
      sessionMetas,
      activeSessionIds: [rootSessionId, childSessionId],
      includeLegacySessionDeleteRequest: false,
      machineFlockRows: [
        {
          key: localProjectKey,
          value: {
            id: localProjectId,
            name: 'Project',
            rootPath: '/repo',
            createdAtMs: 1,
          },
        },
      ],
    });
    const resolveWorktreeCleanupTarget = vi.fn(() => {
      throw new Error('project removal must not resolve worktree cleanup');
    });
    handler.resolveWorktreeCleanupTarget = resolveWorktreeCleanupTarget;

    await handler.deleteLocalProjectResources(localProjectId, { v: 1, requestedAt: 2 });

    const archivedPatch = {
      isArchived: true,
      status: SessionStatusFactory.idle(),
    };
    expect(repo.upsertDocMeta).toHaveBeenCalledWith(getSessionRoomId(rootSessionId), archivedPatch);
    expect(repo.upsertDocMeta).toHaveBeenCalledWith(
      getSessionRoomId(childSessionId),
      archivedPatch
    );
    expect(sessionManager.terminateSession).toHaveBeenCalledWith(rootSessionId, true);
    expect(sessionManager.terminateSession).toHaveBeenCalledWith(childSessionId, true);
    expect(resolveWorktreeCleanupTarget).not.toHaveBeenCalled();

    const projectDeleteEvent = `flock-delete:${JSON.stringify(localProjectKey)}`;
    const projectDeleteIndex = events.indexOf(projectDeleteEvent);
    expect(projectDeleteIndex).toBeGreaterThan(-1);
    expect(events.indexOf(`meta:${getSessionRoomId(rootSessionId)}:archived`)).toBeLessThan(
      projectDeleteIndex
    );
    expect(events.indexOf(`meta:${getSessionRoomId(childSessionId)}:archived`)).toBeLessThan(
      projectDeleteIndex
    );
    expect(machineFlockRows).not.toContainEqual(expect.objectContaining({ key: localProjectKey }));
  });

  it('stops an active child session whose parent is already archived', async () => {
    const localProjectId = 'local-project-orphan-child' as LocalProjectId;
    const childSessionId = 'session-project-orphan-child' as SessionId;
    const localProjectKey = machineFlockKeys.localProject(localProjectId);
    const { handler, repo, sessionManager } = createHarness({
      sessionId: childSessionId,
      sessionMetas: [
        {
          id: childSessionId,
          machineId: 'machine-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          userId: 'user-1',
          cliType: 'codex',
          agentType: 'codex',
          status: SessionStatusFactory.running(),
          project: { kind: 'local', localProjectId },
          parentSessionId: 'session-project-archived-parent' as SessionId,
        } as SessionMeta,
      ],
      activeSessionIds: [childSessionId],
      includeLegacySessionDeleteRequest: false,
      machineFlockRows: [
        {
          key: localProjectKey,
          value: {
            id: localProjectId,
            name: 'Project',
            rootPath: '/repo',
            createdAtMs: 1,
          },
        },
      ],
    });
    const resolveWorktreeCleanupTarget = vi.fn();
    handler.resolveWorktreeCleanupTarget = resolveWorktreeCleanupTarget;

    await handler.deleteLocalProjectResources(localProjectId, { v: 1, requestedAt: 2 });

    expect(sessionManager.terminateSession).toHaveBeenCalledWith(childSessionId, true);
    expect(repo.upsertDocMeta).toHaveBeenCalledWith(getSessionRoomId(childSessionId), {
      isArchived: true,
      status: SessionStatusFactory.idle(),
    });
    expect(resolveWorktreeCleanupTarget).not.toHaveBeenCalled();
  });

  it('keeps the project and delete command when session archival fails, then retries', async () => {
    const localProjectId = 'local-project-retry' as LocalProjectId;
    const rootSessionId = 'session-project-retry' as SessionId;
    const localProjectKey = machineFlockKeys.localProject(localProjectId);
    const deleteCommandKey = machineFlockKeys.deleteLocalProjectCommand(localProjectId);
    const deleteCommand = { v: 1 as const, requestedAt: 2 };
    const { handler, sessionManager, machineFlockRows } = createHarness({
      sessionId: rootSessionId,
      includeLegacySessionDeleteRequest: false,
      sessionMetas: [
        {
          id: rootSessionId,
          machineId: 'machine-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          userId: 'user-1',
          cliType: 'codex',
          agentType: 'codex',
          status: SessionStatusFactory.running(),
          project: { kind: 'local', localProjectId },
        } as SessionMeta,
      ],
      machineFlockRows: [
        {
          key: localProjectKey,
          value: {
            id: localProjectId,
            name: 'Project',
            rootPath: '/repo',
            createdAtMs: 1,
          },
        },
      ],
    });
    machineFlockRows.push({ key: deleteCommandKey, value: deleteCommand });
    sessionManager.archiveSession.mockRejectedValueOnce(new Error('archive failed'));

    await expect(
      handler.deleteLocalProjectResources(localProjectId, deleteCommand)
    ).rejects.toThrow('archive failed');
    expect(machineFlockRows).toContainEqual(expect.objectContaining({ key: localProjectKey }));
    expect(machineFlockRows).toContainEqual(expect.objectContaining({ key: deleteCommandKey }));

    await handler.deleteLocalProjectResources(localProjectId, deleteCommand);

    expect(machineFlockRows).not.toContainEqual(expect.objectContaining({ key: localProjectKey }));
  });

  it('preserves kept worktree path by creating a Flock command for legacy-only delete requests', async () => {
    const sessionId = 'session-legacy-delete' as SessionId;
    const { handler, flockSet, flockCommit, repo } = createHarness({ sessionId });
    const request = {
      branchName: 'lody/session-legacy-delete',
      baseBranchName: 'main',
      isWorktree: true,
      localProjectId: 'local-1',
      originalRootPath: '/repo/app',
      requestedAt: 123,
    } satisfies NeedToDeleteSessionQueueItem;

    await handler.writeKeptWorktreePath(sessionId, request, '/repo/app/.lody/worktrees/session');

    expect(flockSet).toHaveBeenCalledWith(
      machineFlockKeys.deleteSessionCommand(sessionId),
      {
        v: 1,
        branchName: 'lody/session-legacy-delete',
        baseBranchName: 'main',
        localProjectId: 'local-1',
        originalRootPath: '/repo/app',
        requestedAt: 123,
        keptWorktreePath: '/repo/app/.lody/worktrees/session',
        isWorktree: true,
      },
      expect.any(Number)
    );
    expect(flockCommit).toHaveBeenCalled();
    expect(repo.flush).toHaveBeenCalled();
  });
});
