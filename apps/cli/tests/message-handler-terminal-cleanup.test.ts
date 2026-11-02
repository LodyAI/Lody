import { withHistoryPort } from './history-port-fixture';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect, Exit, Scope } from 'effect';
import type { SessionEntry } from '@lody/shared/session-data';
import type { NotificationPresentation } from '@lody/shared/notifications';
import type { SessionActivePresenceControllerLegacy } from '../src/lib/loro/session-active-presence-legacy';

import {
  getMachineRoomId,
  getWorkspaceFlockDocId,
  workspaceFlockKeys,
  type WorkspaceProject,
  type ProjectId,
  type ProjectMemberId,
  getSessionRoomId,
  machineFlockKeys,
  SessionStatusFactory,
  type LocalProjectId,
  type LocalProjectWorktreeCleanupResult,
  type MachineDeleteLocalProjectCommand,
  type MachineFlockScanRow,
  type AcpSessionNotification,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { deriveRepoIdFromLocalProjectPath } from '@lody/shared/node/worktree-paths';
import { MessageHandler } from '../src/lib/message-handler';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import { SessionManager } from '../src/session/session-manager';
import { Session } from '../src/session/session';
import type { WorktreeOwnerState } from '../src/session/worktree/worktree-gc';
import { getWorktreeManager } from '../src/session/worktree/worktree-manager';
import type { Logger } from '../src/utils/logger';
import { createTestCloudPort } from './test-cloud-port';
import { createLocalRepo, runGit } from './worktree-manager-test-helpers';

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

type MessageHandlerInternals = {
  buildNotificationPresentation: (
    sessionId: SessionId,
    origins: readonly string[],
    assistantTurnId?: string
  ) => Promise<NotificationPresentation | undefined>;
  cleanup: () => Promise<void>;
  codeCollabV2DiffStore: { close: () => Promise<void> };
  sessionActivePresence: SessionActivePresenceControllerLegacy;
  handleSessionArchived: (sessionId: SessionId) => Promise<void>;
  readWorktreeOwnerState: (sessionId: SessionId) => Promise<WorktreeOwnerState>;
  handleSessionDeleted: (sessionId: SessionId) => Promise<void>;
  discardLegacySessionCommands: () => Promise<void>;
  worktreeGc: { schedule: () => Promise<{ removed: SessionId[] }> };
  deleteLocalProjectResources: (
    localProjectId: LocalProjectId,
    command: MachineDeleteLocalProjectCommand
  ) => Promise<LocalProjectWorktreeCleanupResult | undefined>;
  enqueueACPUpdate: (sessionId: SessionId, update: AcpSessionNotification) => void;
  quiesceACPFlushForDeletion: (sessionId: SessionId) => Promise<void>;
  codeCollabV2PendingEvidenceWrites: Map<SessionId, Set<Promise<void>>>;
  codeCollabV2TurnDiffs: Map<string, unknown[]>;
  deletedSessionIds: Set<SessionId>;
  store: {
    has: (sessionId: SessionId) => boolean;
    get: (sessionId: SessionId) => { acpFlushInFlight: Promise<void> | null };
  };
  previewService: {
    closeSessionPreviewForCleanup: (sessionId: SessionId, reason: string) => Promise<void>;
    closeAllActiveTunnelsForCleanup: (reason: string) => Promise<void>;
  };
};

function createHarness(options?: {
  workspaceProjects?: WorkspaceProject[];
  catalogReady?: () => Promise<boolean>;
  history?: SessionEntry[];
  sessionId?: SessionId;
  childSessionIds?: SessionId[];
  closeSessionTerminals?: (sessionId: SessionId) => void;
  machineFlockRows?: MachineFlockScanRow[];
  sessionMetas?: SessionMeta[];
  activeSessionIds?: SessionId[];
  includeLegacySessionDeleteRequest?: boolean;
  includeLegacySessionArchiveRequest?: boolean;
  deletedSessionIds?: SessionId[];
  localProjectRootPaths?: Record<LocalProjectId, string>;
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
  const sessionDoc = withHistoryPort({
    getHistory: () => options?.history ?? [],
    getMetaState: async () => ({ title: 'Fix sign-in', repoFullName: 'team/lody' }),
    updateHistory: vi.fn(async (updater: (history: unknown[]) => unknown[]) => {
      updater([]);
    }),
    waitUntilSynced: vi.fn(async () => {}),
    setLastMessageAt: vi.fn(async () => {}),
  });
  const repo = {
    watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
    getDocMeta: vi.fn(async (roomId: string) => {
      const localSessionMeta = sessionMetas.get(roomId);
      if (localSessionMeta) {
        const deleted = (options?.deletedSessionIds ?? []).some(
          (id) => getSessionRoomId(id) === roomId
        );
        return { meta: localSessionMeta, deleted };
      }
      if (roomId === sessionRoomId) {
        return { meta: { isArchived: true, machineId } };
      }
      if (roomId === machineRoomId) {
        return {
          meta: {
            needToArchiveSessions:
              options?.includeLegacySessionArchiveRequest === true ? { [sessionId]: true } : {},
            needToDeleteSessions:
              options?.includeLegacySessionDeleteRequest === false ? {} : { [sessionId]: true },
            localProjects: Object.fromEntries(
              Object.entries(options?.localProjectRootPaths ?? {}).map(([id, rootPath]) => [
                id,
                { id, name: 'Project', rootPath, createdAtMs: 1 },
              ])
            ),
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
    openFlockDoc: vi.fn(async (docId: string) => ({
      flock: {
        scan: (query?: { prefix?: readonly unknown[] }) =>
          (docId === getWorkspaceFlockDocId('workspace-1' as WorkspaceId)
            ? (options?.workspaceProjects ?? []).map((project) => ({
                key: workspaceFlockKeys.project(project.id),
                value: project,
              }))
            : machineFlockRows
          ).filter((row) => (query?.prefix ?? []).every((part, index) => row.key[index] === part)),
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
  const presenceEntries = new Map<SessionId, unknown>();
  const workspaceDocument = {
    catalogBaselineReady: options?.catalogReady ?? (async () => true),
    publishSessionPresence: (id: SessionId, _machine: unknown, status: unknown) => {
      presenceEntries.set(id, status);
    },
    clearSessionPresence: (id: SessionId) => {
      presenceEntries.delete(id);
    },
    sessions: new Map<SessionId, unknown>(),
    repo,
    getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
    isTransportConnected: vi.fn(() => true),
    markMachineFlockDocDirty: vi.fn(),
  };
  const sessionManager = {
    on: vi.fn(),
    setRequestPermissionHandler: vi.fn(),
    getActiveChildSessionIds: vi.fn<SessionManager['getActiveChildSessionIds']>(
      () => childSessionIds
    ),
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
    closeAllActiveTunnelsForCleanup: vi.fn(async () => {}),
  };

  return {
    sessionDoc,
    handler: internal,
    presenceEntries,
    sessionId,
    childSessionIds,
    closeSessionTerminals,
    sessionManager,
    repo,
    events,
    machineFlockRows,
    getSessionMeta: (id: SessionId) => sessionMetas.get(getSessionRoomId(id)),
    isSessionActive: (id: SessionId) => activeSessionIds.has(id),
    flockSet,
    flockCommit,
  };
}

describe('MessageHandler terminal cleanup', () => {
  it('reads the completed assistant entry even after a newer reply exists', async () => {
    const history: SessionEntry[] = ['completed', 'newer'].map((id) => ({
      id,
      role: 'assistant',
      timestamp: '2026-10-23T00:00:00.000Z',
      items: [{ type: 'text', text: `${id} reply` }],
    }));
    const { handler, sessionId, sessionDoc } = createHarness({ history });
    expect(
      await handler.buildNotificationPresentation(sessionId, ['input'], 'completed')
    ).toMatchObject({
      conversationTitle: 'Fix sign-in',
      projectName: 'lody',
      replyPreview: 'completed reply',
    });
    expect(
      (await handler.buildNotificationPresentation(sessionId, ['input'], 'missing'))?.replyPreview
    ).toBeUndefined();
    expect(
      (await handler.buildNotificationPresentation(sessionId, ['input']))?.replyPreview
    ).toBeUndefined();
    const readTurn = sessionDoc.sessionData.history.readTurn;
    sessionDoc.sessionData.history.readTurn = (id) => {
      if (id === 'completed') throw new Error('Reply unavailable');
      return readTurn(id);
    };
    expect(
      await handler.buildNotificationPresentation(sessionId, ['input'], 'completed')
    ).toMatchObject({
      conversationTitle: 'Fix sign-in',
      projectName: 'lody',
    });
  });
  let isolatedDataRoot: string;
  let previousDataDir: string | undefined;
  let previousLocksDir: string | undefined;

  beforeEach(() => {
    isolatedDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-terminal-cleanup-'));
    previousDataDir = process.env.LODY_DATA_DIR;
    previousLocksDir = process.env.LODY_LOCKS_DIR;
    process.env.LODY_DATA_DIR = path.join(isolatedDataRoot, 'data');
    process.env.LODY_LOCKS_DIR = path.join(isolatedDataRoot, 'locks');
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.LODY_DATA_DIR;
    else process.env.LODY_DATA_DIR = previousDataDir;
    if (previousLocksDir === undefined) delete process.env.LODY_LOCKS_DIR;
    else process.env.LODY_LOCKS_DIR = previousLocksDir;
    fs.rmSync(isolatedDataRoot, { recursive: true, force: true });
  });

  it('keeps a native Turn lease through archive callbacks until its owning Scope releases', async () => {
    const { handler, sessionId, presenceEntries } = createHarness();
    const lease = Effect.runSync(Scope.make());
    await Effect.runPromise(
      Scope.provide(handler.sessionActivePresence.native.hold(sessionId), lease)
    );
    await handler.handleSessionArchived(sessionId);
    expect(presenceEntries.get(sessionId)).toEqual({ type: 'running' });
    expect(handler.sessionActivePresence.has(sessionId)).toBe(true);
    await Effect.runPromise(Scope.close(lease, Exit.void));
    expect(presenceEntries.has(sessionId)).toBe(false);
    await handler.sessionActivePresence.close();
  });

  it('waits for the native Turn lease before closing evidence stores and documents on shutdown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { handler, sessionId, presenceEntries, sessionManager } = createHarness();
    const lease = Effect.runSync(Scope.make());
    await Effect.runPromise(
      Scope.provide(handler.sessionActivePresence.native.hold(sessionId), lease)
    );
    const events: string[] = [];
    let producersStopped: () => void = () => {};
    const stopped = new Promise<void>((resolve) => {
      producersStopped = resolve;
    });
    let closeRequested: () => void = () => {};
    const closingStarted = new Promise<void>((resolve) => {
      closeRequested = resolve;
    });
    const originalClose = handler.sessionActivePresence.close.bind(handler.sessionActivePresence);
    vi.spyOn(handler.sessionActivePresence, 'close').mockImplementation(() => {
      closeRequested();
      return originalClose();
    });
    sessionManager.cleanUp.mockImplementation(
      async (options?: { keepWorkspaceDocumentOpen?: boolean }) => {
        if (options?.keepWorkspaceDocumentOpen) {
          events.push('producers-stopped');
          producersStopped();
        } else events.push('documents-closed');
      }
    );
    vi.spyOn(handler.codeCollabV2DiffStore, 'close').mockImplementation(async () => {
      events.push('evidence-store-closed');
    });
    const cleaning = handler.cleanup();
    try {
      await stopped;
      await closingStarted;
      expect(presenceEntries.has(sessionId)).toBe(true);
      expect(events).toEqual(['producers-stopped']);
      await Effect.runPromise(Scope.close(lease, Exit.void));
      events.push('lease-released');
      await cleaning;
      expect(presenceEntries.size).toBe(0);
      expect(events).toEqual([
        'producers-stopped',
        'lease-released',
        'evidence-store-closed',
        'documents-closed',
      ]);
    } finally {
      await Effect.runPromise(Scope.close(lease, Exit.void));
      await cleaning;
      vi.useRealTimers();
    }
  });

  it('releases the runtime when a session becomes archived, even without an active session', async () => {
    const { handler, sessionId, closeSessionTerminals, sessionManager } = createHarness();

    await handler.handleSessionArchived(sessionId);

    expect(closeSessionTerminals).toHaveBeenCalledWith(sessionId);
    expect(sessionManager.terminateSession).not.toHaveBeenCalled();
    expect(sessionManager.archiveSession).toHaveBeenCalledWith(sessionId);
  });

  it('releases only contained runtimes and keeps independently opened worktree owners active', async () => {
    const root = {
      id: 'session-1' as SessionId,
      machineId: 'machine-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      userId: 'user-1',
      cliType: 'codex',
      agentType: 'codex',
      status: SessionStatusFactory.running(),
      isArchived: true,
    } as SessionMeta;
    const child = { ...root, id: 'child-1' as SessionId, parentSessionId: root.id };
    const opened = {
      ...root,
      id: 'opened-1' as SessionId,
      openedBySessionId: root.id,
      isArchived: false,
    };
    const openedByTab = {
      ...opened,
      id: 'opened-by-tab' as SessionId,
      openedBySessionId: child.id,
      openedByRootSessionId: root.id,
    };
    const openedChild = {
      ...root,
      id: 'opened-child' as SessionId,
      parentSessionId: openedByTab.id,
      isArchived: false,
    };
    const independentSessions = [opened, openedByTab, openedChild];
    const sessions = [root, child, ...independentSessions];
    const terminalSessions = new Set(sessions.map((session) => session.id));
    const { handler, sessionManager, isSessionActive, getSessionMeta } = createHarness({
      activeSessionIds: sessions.map((session) => session.id),
      sessionMetas: sessions,
      closeSessionTerminals: (id) => {
        terminalSessions.delete(id);
      },
    });
    // Exercise the real containment selectors without creating processes or worktrees.
    const runtimeManager = {
      sessions: new Map(
        sessions.map((meta) => [
          meta.id,
          {
            getParentSessionId: () =>
              Session.prototype.getParentSessionId.call({ config: meta } as unknown as Session),
          },
        ])
      ),
    } as unknown as SessionManager;
    sessionManager.getActiveChildSessionIds.mockImplementation((id) =>
      SessionManager.prototype.getActiveChildSessionIds.call(runtimeManager, id)
    );
    // This test reads GC eligibility directly and must never scan the host data directory.
    handler.worktreeGc = { schedule: async () => ({ removed: [] }) };

    await handler.handleSessionArchived(root.id);

    expect(isSessionActive(root.id)).toBe(false);
    expect(isSessionActive(child.id)).toBe(false);
    expect(terminalSessions).toEqual(new Set(independentSessions.map((session) => session.id)));
    expect(getSessionMeta(root.id)).toMatchObject({ status: SessionStatusFactory.idle() });
    expect(await handler.readWorktreeOwnerState(root.id)).toMatchObject({ kind: 'archived' });
    // Child Tabs share their parent's directory, so even archived children own no GC target.
    expect(await handler.readWorktreeOwnerState(child.id)).toEqual({ kind: 'active' });
    for (const session of independentSessions) {
      expect(isSessionActive(session.id)).toBe(true);
      expect(getSessionMeta(session.id)).toEqual(session);
      expect(await handler.readWorktreeOwnerState(session.id)).toEqual({ kind: 'active' });
    }
  });

  // A process that survives SIGKILL (stuck in uninterruptible I/O) must not
  // leave the archive half done: the Session is released either way.
  it('finishes archiving when a session process tree cannot be terminated', async () => {
    const { handler, sessionId, sessionManager, getSessionMeta } = createHarness({
      activeSessionIds: ['session-1' as SessionId],
      sessionMetas: [
        {
          id: 'session-1' as SessionId,
          machineId: 'machine-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          userId: 'user-1',
          cliType: 'codex',
          agentType: 'codex',
          status: SessionStatusFactory.running(),
          isArchived: true,
        } as SessionMeta,
      ],
    });
    sessionManager.terminateSession.mockRejectedValueOnce(
      new Error('process group 4321 was still running 5000ms after SIGKILL')
    );

    await handler.handleSessionArchived(sessionId);

    expect(getSessionMeta(sessionId)).toMatchObject({ status: SessionStatusFactory.idle() });
    expect(sessionManager.archiveSession).toHaveBeenCalledWith(sessionId);
  });

  it('removes the worktree of an archived local-project session and keeps its branch', async () => {
    const localProjectId = 'local-project-archive' as LocalProjectId;
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-archive-project-'));
    const originalDataDir = process.env.LODY_DATA_DIR;
    const originalLocksDir = process.env.LODY_LOCKS_DIR;
    process.env.LODY_DATA_DIR = path.join(testDir, 'data');
    process.env.LODY_LOCKS_DIR = path.join(testDir, 'locks');
    const rootPath = createLocalRepo(testDir);
    const sessionId = 'session-archive-worktree' as SessionId;
    const sessionMeta = {
      id: sessionId,
      machineId: 'machine-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      userId: 'user-1',
      cliType: 'codex',
      agentType: 'codex',
      status: SessionStatusFactory.idle(),
      project: { kind: 'local', localProjectId },
      isWorktree: true,
      isArchived: true,
    } as SessionMeta;
    try {
      const manager = getWorktreeManager({
        repoId: deriveRepoIdFromLocalProjectPath(rootPath),
        source: { kind: 'local-shared', originalRootPath: rootPath },
        logger: createSilentLogger(),
      });
      const worktree = await manager.createWorktree(sessionId);
      // Project metadata is deliberately absent everywhere: reconciliation must
      // not depend on the local-project catalog (the gap behind #377).
      const { handler, repo } = createHarness({ sessionId, sessionMetas: [sessionMeta] });

      // A branch renamed in a terminal is known only to git until archive
      // reports it; restore reattaches by `branchName`.
      const renamed = `${worktree.branch}-renamed`;
      runGit(worktree.hostPath, ['branch', '-m', renamed]);

      await handler.handleSessionArchived(sessionId);
      await handler.worktreeGc.schedule();

      expect(fs.existsSync(worktree.hostPath)).toBe(false);
      expect(runGit(rootPath, ['branch', '--list', renamed])).toContain(renamed);
      expect(repo.upsertDocMeta).toHaveBeenCalledWith(
        getSessionRoomId(sessionId),
        expect.objectContaining({ branchName: renamed })
      );
    } finally {
      if (originalDataDir === undefined) delete process.env.LODY_DATA_DIR;
      else process.env.LODY_DATA_DIR = originalDataDir;
      if (originalLocksDir === undefined) delete process.env.LODY_LOCKS_DIR;
      else process.env.LODY_LOCKS_DIR = originalLocksDir;
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('ignores archived sessions that belong to another machine', async () => {
    const sessionId = 'session-elsewhere' as SessionId;
    const { handler, closeSessionTerminals, sessionManager } = createHarness({
      sessionId,
      sessionMetas: [
        {
          id: sessionId,
          machineId: 'machine-2',
          createdAt: '2026-01-01T00:00:00.000Z',
          userId: 'user-1',
          cliType: 'codex',
          agentType: 'codex',
          status: SessionStatusFactory.idle(),
          isArchived: true,
        } as SessionMeta,
      ],
    });

    await handler.handleSessionArchived(sessionId);
    await handler.handleSessionDeleted(sessionId);

    expect(closeSessionTerminals).not.toHaveBeenCalled();
    expect(sessionManager.archiveSession).not.toHaveBeenCalled();
    expect(handler.deletedSessionIds.has(sessionId)).toBe(false);
  });

  it('closes parent and active child terminals when the session doc is deleted', async () => {
    const childSessionId = 'child-1' as SessionId;
    const { handler, sessionId, closeSessionTerminals } = createHarness({
      childSessionIds: [childSessionId],
    });

    await handler.handleSessionDeleted(sessionId);

    expect(closeSessionTerminals).toHaveBeenCalledWith(childSessionId);
    expect(closeSessionTerminals).toHaveBeenCalledWith(sessionId);
  });

  it('drops transient ACP retry state after deletion and rejects late output', async () => {
    const { handler, sessionId } = createHarness();

    await handler.handleSessionDeleted(sessionId);

    expect(handler.deletedSessionIds.has(sessionId)).toBe(true);
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

  it('discards legacy archive and delete request records without acting on them', async () => {
    const sessionId = 'session-legacy-queued' as SessionId;
    const { handler, machineFlockRows, repo, sessionManager } = createHarness({
      sessionId,
      includeLegacySessionArchiveRequest: true,
      machineFlockRows: [
        { key: machineFlockKeys.archiveSessionCommand(sessionId), value: { v: 1, requestedAt: 1 } },
        { key: machineFlockKeys.deleteSessionCommand(sessionId), value: { v: 1, requestedAt: 1 } },
      ],
    });

    await handler.discardLegacySessionCommands();

    expect(machineFlockRows).toEqual([]);
    expect(repo.upsertDocMeta).toHaveBeenCalledWith(
      getMachineRoomId('machine-1'),
      expect.objectContaining({ needToArchiveSessions: {}, needToDeleteSessions: {} })
    );
    expect(sessionManager.archiveSession).not.toHaveBeenCalled();
    expect(repo.deleteDoc).not.toHaveBeenCalled();
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

  it.each(['local', 'github', 'session'] as const)(
    'retains a registration and running sessions referenced by %s',
    async (kind) => {
      const localProjectId = 'retained-project' as LocalProjectId;
      const sessionId = 'retained-session' as SessionId;
      const localSource = { kind: 'local' as const, machineId: 'machine-1', localProjectId };
      const group = {
        v: 1,
        id: '00000000-0000-4000-8000-000000000001' as ProjectId,
        name: 'Group',
        ownerUserId: 'user-1',
        createdAtMs: 1,
        revision: 1,
        members: [
          {
            id: 'member-1' as ProjectMemberId,
            source:
              kind === 'github'
                ? { kind: 'github', repoFullName: 'team/repo', preferLocal: true }
                : localSource,
            placement: { kind: 'root', dir: 'repo' },
          },
        ],
      } as WorkspaceProject;
      const session = {
        id: sessionId,
        machineId: 'machine-1',
        createdAt: '2026-01-01T00:00:00Z',
        status: SessionStatusFactory.running(),
        project: { kind: 'local', localProjectId },
        ...(kind === 'session'
          ? {
              projectRun: {
                id: group.id,
                name: group.name,
                root: '/group',
                members: {
                  member: {
                    o: 0,
                    src: { kind: 'github', repoFullName: 'team/repo', preferLocal: true },
                    repositoryCheckout: localSource,
                    placement: { kind: 'root', dir: 'repo' },
                    path: '/repo',
                    base: 'main',
                  },
                },
              },
            }
          : {}),
      } as SessionMeta;
      const key = machineFlockKeys.localProject(localProjectId);
      const { handler, machineFlockRows, getSessionMeta, isSessionActive } = createHarness({
        sessionId,
        sessionMetas: [session],
        activeSessionIds: [sessionId],
        workspaceProjects: kind === 'session' ? [] : [group],
        machineFlockRows: [
          {
            key,
            value: {
              id: localProjectId,
              name: 'Repo',
              rootPath: '/repo',
              createdAtMs: 1,
              githubRepoFullName: 'team/repo',
              standaloneVisible: true,
            },
          },
        ],
      });
      await handler.deleteLocalProjectResources(localProjectId, { v: 1, requestedAt: 2 });
      expect(
        machineFlockRows.find((row) => JSON.stringify(row.key) === JSON.stringify(key))?.value
      ).toMatchObject({
        id: localProjectId,
        standaloneVisible: false,
        githubRepoFullName: 'team/repo',
      });
      expect(getSessionMeta(sessionId)?.isArchived).not.toBe(true);
      expect(isSessionActive(sessionId)).toBe(true);
    }
  );

  it('does not delete or archive when the project catalog cannot be read', async () => {
    const localProjectId = 'catalog-unavailable' as LocalProjectId;
    const key = machineFlockKeys.localProject(localProjectId);
    const { handler, machineFlockRows } = createHarness({
      catalogReady: async () => false,
      machineFlockRows: [
        { key, value: { id: localProjectId, name: 'Repo', rootPath: '/repo', createdAtMs: 1 } },
      ],
    });
    await expect(
      handler.deleteLocalProjectResources(localProjectId, { v: 1, requestedAt: 2 })
    ).rejects.toThrow('Project catalog is not ready');
    expect(
      machineFlockRows.find((row) => JSON.stringify(row.key) === JSON.stringify(key))?.value
    ).toMatchObject({ id: localProjectId });
  });

  it.each(['none', 'other-machine', 'managed-clone'] as const)(
    'archives unreferenced local-project sessions with %s catalog entries',
    async (references) => {
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
      const { handler, events, machineFlockRows, getSessionMeta, isSessionActive } = createHarness({
        workspaceProjects:
          references === 'none'
            ? []
            : [
                {
                  v: 1,
                  id: '00000000-0000-4000-8000-000000000002' as ProjectId,
                  name: 'Other project',
                  ownerUserId: 'user-1',
                  createdAtMs: 1,
                  revision: 1,
                  members: [
                    {
                      id: 'repo' as ProjectMemberId,
                      source:
                        references === 'other-machine'
                          ? { kind: 'local', machineId: 'other-machine', localProjectId }
                          : { kind: 'github', repoFullName: 'team/repo' },
                      placement: { kind: 'root', dir: 'repo' },
                    },
                  ],
                } as WorkspaceProject,
              ],
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
              githubRepoFullName: 'team/repo',
              rootPath: '/repo',
              createdAtMs: 1,
            },
          },
        ],
      });
      await handler.deleteLocalProjectResources(localProjectId, { v: 1, requestedAt: 2 });

      expect(getSessionMeta(rootSessionId)).toMatchObject({
        isArchived: true,
        status: SessionStatusFactory.idle(),
      });
      expect(getSessionMeta(childSessionId)).toMatchObject({
        isArchived: true,
        status: SessionStatusFactory.idle(),
      });
      expect(isSessionActive(rootSessionId)).toBe(false);
      expect(isSessionActive(childSessionId)).toBe(false);

      const projectDeleteEvent = `flock-delete:${JSON.stringify(localProjectKey)}`;
      const projectDeleteIndex = events.indexOf(projectDeleteEvent);
      expect(projectDeleteIndex).toBeGreaterThan(-1);
      expect(events.indexOf(`meta:${getSessionRoomId(rootSessionId)}:archived`)).toBeLessThan(
        projectDeleteIndex
      );
      expect(events.indexOf(`meta:${getSessionRoomId(childSessionId)}:archived`)).toBeLessThan(
        projectDeleteIndex
      );
      expect(machineFlockRows).not.toContainEqual(
        expect.objectContaining({ key: localProjectKey })
      );
    }
  );

  it('stops an archived active child session whose parent is already archived', async () => {
    const localProjectId = 'local-project-orphan-child' as LocalProjectId;
    const childSessionId = 'session-project-orphan-child' as SessionId;
    const localProjectKey = machineFlockKeys.localProject(localProjectId);
    const { handler, getSessionMeta, isSessionActive } = createHarness({
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
          isArchived: true,
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
    await handler.deleteLocalProjectResources(localProjectId, { v: 1, requestedAt: 2 });

    expect(isSessionActive(childSessionId)).toBe(false);
    expect(getSessionMeta(childSessionId)).toMatchObject({
      isArchived: true,
      status: SessionStatusFactory.idle(),
    });
  });

  it('leaves a dirty session worktree untouched when removing its local project', async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-project-removal-worktree-'));
    const originalDataDir = process.env.LODY_DATA_DIR;
    const originalLocksDir = process.env.LODY_LOCKS_DIR;
    try {
      process.env.LODY_DATA_DIR = path.join(testDir, 'data');
      process.env.LODY_LOCKS_DIR = path.join(testDir, 'locks');
      const rootPath = createLocalRepo(testDir);
      const localProjectId = 'local-project-worktree' as LocalProjectId;
      const sessionId = 'session-project-worktree' as SessionId;
      const manager = getWorktreeManager({
        repoId: deriveRepoIdFromLocalProjectPath(rootPath),
        source: { kind: 'local-shared', originalRootPath: rootPath },
        logger: createSilentLogger(),
      });
      const worktree = await manager.createWorktree(sessionId);
      const dirtyPath = path.join(worktree.hostPath, 'dirty.txt');
      fs.writeFileSync(dirtyPath, 'preserve me\n', 'utf8');

      const { handler } = createHarness({
        sessionId,
        sessionMetas: [
          {
            id: sessionId,
            machineId: 'machine-1',
            createdAt: '2026-01-01T00:00:00.000Z',
            userId: 'user-1',
            cliType: 'codex',
            agentType: 'codex',
            status: SessionStatusFactory.idle(),
            project: { kind: 'local', localProjectId },
            isWorktree: true,
            branchName: worktree.branch,
          } as SessionMeta,
        ],
        includeLegacySessionDeleteRequest: false,
        localProjectRootPaths: { [localProjectId]: rootPath },
        machineFlockRows: [
          {
            key: machineFlockKeys.localProject(localProjectId),
            value: {
              id: localProjectId,
              name: 'Project',
              rootPath,
              createdAtMs: 1,
            },
          },
        ],
      });

      await handler.deleteLocalProjectResources(localProjectId, { v: 1, requestedAt: 2 });

      expect(fs.readFileSync(dirtyPath, 'utf8')).toBe('preserve me\n');
      expect(fs.existsSync(worktree.hostPath)).toBe(true);
    } finally {
      if (originalDataDir === undefined) delete process.env.LODY_DATA_DIR;
      else process.env.LODY_DATA_DIR = originalDataDir;
      if (originalLocksDir === undefined) delete process.env.LODY_LOCKS_DIR;
      else process.env.LODY_LOCKS_DIR = originalLocksDir;
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('optionally deletes clean worktrees, keeps dirty ones, and never deletes the original repo', async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-project-clean-worktrees-'));
    const originalDataDir = process.env.LODY_DATA_DIR;
    const originalLocksDir = process.env.LODY_LOCKS_DIR;
    try {
      process.env.LODY_DATA_DIR = path.join(testDir, 'data');
      process.env.LODY_LOCKS_DIR = path.join(testDir, 'locks');
      const rootPath = createLocalRepo(testDir);
      const localProjectId = 'local-project-clean-worktrees' as LocalProjectId;
      const cleanSessionId = 'session-project-clean' as SessionId;
      const dirtySessionId = 'session-project-dirty' as SessionId;
      const manager = getWorktreeManager({
        repoId: deriveRepoIdFromLocalProjectPath(rootPath),
        source: { kind: 'local-shared', originalRootPath: rootPath },
        logger: createSilentLogger(),
      });
      const cleanWorktree = await manager.createWorktree(cleanSessionId);
      const dirtyWorktree = await manager.createWorktree(dirtySessionId);
      fs.writeFileSync(path.join(dirtyWorktree.hostPath, 'dirty.txt'), 'preserve me\n', 'utf8');

      const project = { kind: 'local' as const, localProjectId };
      const { handler } = createHarness({
        sessionId: cleanSessionId,
        sessionMetas: [
          {
            id: cleanSessionId,
            machineId: 'machine-1',
            createdAt: '2026-01-01T00:00:00.000Z',
            status: SessionStatusFactory.idle(),
            project,
            isWorktree: true,
            branchName: cleanWorktree.branch,
          } as SessionMeta,
          {
            id: dirtySessionId,
            machineId: 'machine-1',
            createdAt: '2026-01-01T00:00:00.000Z',
            status: SessionStatusFactory.idle(),
            project,
            isWorktree: true,
            branchName: dirtyWorktree.branch,
          } as SessionMeta,
        ],
        includeLegacySessionDeleteRequest: false,
        localProjectRootPaths: { [localProjectId]: rootPath },
        machineFlockRows: [
          {
            key: machineFlockKeys.localProject(localProjectId),
            value: {
              id: localProjectId,
              name: 'Project',
              rootPath,
              createdAtMs: 1,
            },
          },
        ],
      });

      const result = await handler.deleteLocalProjectResources(localProjectId, {
        v: 1,
        requestedAt: 2,
        originalRootPath: rootPath,
        cleanupWorktrees: true,
      });

      expect(fs.existsSync(rootPath)).toBe(true);
      expect(fs.existsSync(cleanWorktree.hostPath)).toBe(false);
      expect(fs.existsSync(dirtyWorktree.hostPath)).toBe(true);
      expect(result?.deleted.map((item) => item.sessionId)).toEqual([cleanSessionId]);
      expect(result?.skippedDirty.map((item) => item.sessionId)).toEqual([dirtySessionId]);
      expect(result?.failed).toEqual([]);
    } finally {
      if (originalDataDir === undefined) delete process.env.LODY_DATA_DIR;
      else process.env.LODY_DATA_DIR = originalDataDir;
      if (originalLocksDir === undefined) delete process.env.LODY_LOCKS_DIR;
      else process.env.LODY_LOCKS_DIR = originalLocksDir;
      fs.rmSync(testDir, { recursive: true, force: true });
    }
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
});
