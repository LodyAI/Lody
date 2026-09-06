import {
  getSessionAccountBinding,
  clearSessionAccountBinding,
  updateSessionAccountNativeId,
} from './session-account-binding-store';
import { describe, expect, it, vi } from 'vitest';
import {
  getSessionRoomId,
  SessionStatusFactory,
  type AgentConfigId,
  type MachineId,
  type McpServerId,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { cloneHistoryThroughTurn, SessionForkService } from './session-fork-service';
import type {
  SessionForkOperationCleanup,
  SessionForkOperationMarker,
} from './session-fork-operation-store';

const sourceSessionId = 'source-session' as SessionId;
const targetSessionId = 'target-session' as SessionId;
const machineId = 'machine-1' as MachineId;
const agentConfigId = 'agent-config-1' as AgentConfigId;

const sourceHistory: SessionHistoryInput[] = [
  {
    id: 'user-1',
    timestamp: '2026-07-27T00:00:00.000Z',
    role: 'user',
    items: [{ type: 'text', text: 'hello' }],
    fileDiff: [],
    finished: true,
    read: true,
    status: 'handled',
    sendStatus: undefined,
  },
  {
    id: 'assistant-1',
    timestamp: '2026-07-27T00:00:01.000Z',
    role: 'assistant',
    items: [{ type: 'text', text: 'world' }],
    fileDiff: [],
    finished: true,
    read: true,
    status: undefined,
    sendStatus: undefined,
  },
];

function createForkHarness(
  failPersistReason?: string,
  options: {
    sourceBusy?: boolean;
    supportsActiveTurnFork?: boolean;
    sourceHistory?: SessionHistoryInput[];
    worktree?: { dirty: boolean; headSha: string };
    forkOperation?: unknown;
    targetMeta?: unknown;
    targetHistory?: SessionHistoryInput[];
    targetDocMetaRecord?: unknown;
    markers?: SessionForkOperationMarker[];
    aliveRoomIds?: string[];
    storeRecordFails?: boolean;
    storeListGate?: Promise<void>;
    createSessionGate?: Promise<void>;
  } = {}
) {
  const sourceMeta = {
    id: sourceSessionId,
    machineId,
    createdAt: '2026-07-27T00:00:00.000Z',
    lastMessageAt: 1,
    title: 'Original',
    userId: 'user-1',
    status: SessionStatusFactory.idle(),
    isArchived: false,
    cliType: 'builtin',
    agentType: 'codex',
    agentConfigId,
    acpSessionId: 'acp-source',
    ...(options.worktree
      ? {
          project: {
            kind: 'local' as const,
            localProjectId: 'local-project-1' as never,
          },
        }
      : {}),
  } as unknown as SessionMeta;
  const sourceDoc = {
    getMetaState: vi.fn(async () => sourceMeta),
    getHistory: vi.fn(async () => options.sourceHistory ?? sourceHistory),
  };
  let forkOperation: unknown = options.forkOperation;
  const targetDoc = {
    updateHistory: vi.fn(async () => undefined),
    waitUntilSynced: vi.fn(async () => false),
    getMetaState: vi.fn(async () => options.targetMeta),
    getHistory: vi.fn(async () => options.targetHistory ?? []),
    getForkOperation: vi.fn(() => forkOperation),
    setForkOperation: vi.fn((operation) => {
      forkOperation = operation;
    }),
  };
  const persistPendingChanges = vi.fn(async (reason: string) => {
    if (reason === failPersistReason) {
      throw new Error(`persist failed: ${reason}`);
    }
  });
  const repo = {
    getDocMeta: vi.fn(async (roomId: string) =>
      roomId === getSessionRoomId(targetSessionId) ? options.targetDocMetaRecord : undefined
    ),
    upsertDocMeta: vi.fn(async () => undefined),
    deleteDoc: vi.fn(async () => undefined),
    getMeta: vi.fn(() => ({
      scan: vi.fn(async () =>
        (options.aliveRoomIds ?? []).map((roomId) => ({ key: ['e', roomId], value: true }))
      ),
    })),
  };
  const workspaceDocument = {
    repo,
    getOrCreateSessionDoc: vi.fn(async (sessionId: SessionId) =>
      sessionId === sourceSessionId ? sourceDoc : targetDoc
    ),
    getAgentConfigById: vi.fn(async () => ({
      customAcp: undefined,
      runtimeOverrides: undefined,
      env: undefined,
    })),
    unloadDocRoom: vi.fn(async () => undefined),
    cleanSessionDoc: vi.fn(async () => undefined),
    persistPendingChanges,
  };
  const markers = [...(options.markers ?? [])];
  const forkOperationStore = {
    record: vi.fn(async (marker: SessionForkOperationMarker) => {
      if (options.storeRecordFails === true) {
        throw new Error('store write failed');
      }
      const index = markers.findIndex((entry) => entry.targetSessionId === marker.targetSessionId);
      if (index >= 0) {
        markers.splice(index, 1, marker);
      } else {
        markers.push(marker);
      }
    }),
    read: vi.fn(
      async (requestedTargetSessionId: SessionId) =>
        markers.find((entry) => entry.targetSessionId === requestedTargetSessionId) ?? null
    ),
    clear: vi.fn(async (requestedTargetSessionId: SessionId) => {
      const index = markers.findIndex(
        (marker) => marker.targetSessionId === requestedTargetSessionId
      );
      if (index >= 0) {
        markers.splice(index, 1);
      }
    }),
    list: vi.fn(async () => {
      // Capture BEFORE the gate so tests can hand recovery a stale snapshot.
      const snapshot = [...markers];
      await options.storeListGate;
      return snapshot;
    }),
  };
  const sessionManager = {
    createSession: vi.fn(async () => {
      await options.createSessionGate;
    }),
    getSession: vi.fn((sessionId: SessionId) =>
      sessionId === sourceSessionId
        ? {
            acpSessionId: 'acp-source',
            agentClient: {
              supportsActiveTurnFork: () => options.supportsActiveTurnFork === true,
            },
          }
        : { acpSessionId: 'acp-target', getWorkdir: () => process.cwd() }
    ),
    terminateSession: vi.fn(async () => undefined),
    resolveSessionWorkdir: vi.fn(async () => '/source/workdir'),
    resolveLocalProjectRootPath: vi.fn(async () => '/source/project-root'),
    cleanupForkWorktree: vi.fn(async () => undefined),
  };
  const logger = { error: vi.fn(), warn: vi.fn() };
  const service = new SessionForkService({
    workspaceDocument: workspaceDocument as never,
    sessionManager: sessionManager as never,
    userResolver: {
      resolve: vi.fn(async () => ({ name: 'User', email: 'user@example.com' })),
    } as never,
    logger: logger as never,
    workspaceId: 'workspace-1',
    machineId,
    forkOperationStore,
    isSourceBusy: () => options.sourceBusy === true,
    inspectGitWorkdir: options.worktree
      ? vi.fn(async () => ({
          dirty: options.worktree!.dirty,
          headSha: options.worktree!.headSha,
        }))
      : undefined,
    resolveGitBranch: vi.fn(async () => 'lody/target-session'),
  });

  return {
    service,
    persistPendingChanges,
    repo,
    sessionManager,
    targetDoc,
    workspaceDocument,
    forkOperationStore,
    markers,
  };
}

const forkSpec = {
  sourceSessionId,
  sourceTurnId: 'assistant-1',
  targetSessionId,
  requestedByUserId: 'user-1',
};

describe('cloneHistoryThroughTurn', () => {
  it('clones through the latest completed assistant turn and records the origin', () => {
    const history: SessionHistoryInput[] = [
      {
        id: 'user-1',
        timestamp: '2026-07-27T00:00:00.000Z',
        role: 'user',
        items: [{ type: 'text', text: 'hello' }],
        fileDiff: [],
        finished: true,
        read: false,
        status: 'handled',
        sendStatus: undefined,
      },
      {
        id: 'assistant-1',
        timestamp: '2026-07-27T00:00:01.000Z',
        role: 'assistant',
        items: [{ type: 'text', text: 'world' }],
        fileDiff: [{ filePath: 'src/a.ts', add: 1, del: 0 }],
        finished: true,
        read: false,
        status: undefined,
        sendStatus: undefined,
      },
    ];

    const result = cloneHistoryThroughTurn(
      history,
      'assistant-1',
      sourceSessionId,
      'Original',
      targetSessionId
    );

    expect(result).not.toBeNull();
    expect(result?.warnings.map((warning) => warning.code)).toEqual([
      'HISTORICAL_TURN_DIFF_UNAVAILABLE',
    ]);
    expect(result?.history[1]?.fileDiff).toEqual([]);
    expect(result?.history.at(-1)?.items).toEqual([
      {
        type: 'system_notice',
        name: 'session_fork_origin',
        meta: {
          sourceSessionId,
          sourceTurnId: 'assistant-1',
          sourceTitle: 'Original',
        },
      },
    ]);
  });

  it('rejects a non-latest assistant turn', () => {
    const assistant = (id: string): SessionHistoryInput => ({
      id,
      timestamp: '2026-07-27T00:00:00.000Z',
      role: 'assistant',
      items: [{ type: 'text', text: id }],
      fileDiff: [],
      finished: true,
      read: true,
      status: undefined,
      sendStatus: undefined,
    });
    expect(
      cloneHistoryThroughTurn(
        [assistant('assistant-1'), assistant('assistant-2')],
        'assistant-1',
        sourceSessionId,
        'Original',
        targetSessionId
      )
    ).toBeNull();
  });

  it('clones through an older assistant turn with an exact ACP turn boundary', () => {
    const assistant = (id: string, acpTurnId?: string): SessionHistoryInput => ({
      id,
      timestamp: '2026-07-27T00:00:00.000Z',
      role: 'assistant',
      items: [{ type: 'text', text: id }],
      fileDiff: [],
      finished: true,
      read: true,
      status: undefined,
      sendStatus: undefined,
      acpTurnId,
    });

    const result = cloneHistoryThroughTurn(
      [assistant('assistant-1', 'turn-answer-1'), assistant('assistant-2')],
      'assistant-1',
      sourceSessionId,
      'Original',
      targetSessionId
    );

    expect(result?.history.map((entry) => entry.id)).toEqual([
      'assistant-1',
      `session-fork-origin:${targetSessionId}`,
    ]);
    expect(result?.history[0]?.acpTurnId).toBe('turn-answer-1');
    expect(result?.acpTurnId).toBe('turn-answer-1');
  });

  it('clones the completed prefix while an unfinished assistant turn is active', () => {
    const history: SessionHistoryInput[] = [
      ...sourceHistory,
      {
        id: 'user-2',
        timestamp: '2026-07-27T00:00:02.000Z',
        role: 'user',
        items: [{ type: 'text', text: 'next' }],
        fileDiff: [],
        finished: true,
        read: true,
        status: 'pending',
        sendStatus: undefined,
      },
      {
        id: 'assistant-2',
        timestamp: '2026-07-27T00:00:03.000Z',
        role: 'assistant',
        items: [{ type: 'text', text: 'streaming' }],
        fileDiff: [],
        finished: false,
        read: true,
        status: undefined,
        sendStatus: undefined,
      },
    ];

    const result = cloneHistoryThroughTurn(
      history,
      'assistant-1',
      sourceSessionId,
      'Original',
      targetSessionId,
      { allowActiveTurnSuffix: true }
    );

    expect(result?.history.map((entry) => entry.id)).toEqual([
      'user-1',
      'assistant-1',
      `session-fork-origin:${targetSessionId}`,
    ]);
  });
});

describe('SessionForkService durability boundary', () => {
  it('commits after local persistence without requiring a cloud sync acknowledgement', async () => {
    const harness = createForkHarness();

    const result = await harness.service.fork(forkSpec);

    expect(result.success).toBe(true);
    expect(harness.persistPendingChanges.mock.calls.map(([reason]) => reason)).toEqual([
      'session-fork-prepare',
      'session-fork-commit',
    ]);
    expect(harness.targetDoc.waitUntilSynced).not.toHaveBeenCalled();
    expect(harness.sessionManager.terminateSession).not.toHaveBeenCalled();
  });

  it('persists a side-panel placement without changing workspace ownership', async () => {
    const harness = createForkHarness();

    const result = await harness.service.fork({
      ...forkSpec,
      targetPlacement: 'side-panel',
    });

    expect(result.success).toBe(true);
    expect(harness.repo.upsertDocMeta).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({
        parentSessionId: sourceSessionId,
        childSessionPlacement: 'side-panel',
      })
    );
    expect(updateSessionAccountNativeId).toHaveBeenCalledWith(
      { workspaceId: 'workspace-1', machineId: 'machine-1', sessionId: targetSessionId },
      'acp-target'
    );
    expect(harness.sessionManager.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ parentSessionId: sourceSessionId }),
      expect.any(Object)
    );
  });

  it('forks through the persisted ACP turn boundary before an active turn', async () => {
    const harness = createForkHarness(undefined, {
      sourceBusy: true,
      supportsActiveTurnFork: true,
      sourceHistory: [
        sourceHistory[0]!,
        {
          ...sourceHistory[1]!,
          acpTurnId: 'turn-previous-answer',
        },
      ],
    });

    const result = await harness.service.fork(forkSpec);

    expect(result.success).toBe(true);
    expect(harness.sessionManager.createSession).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        forkSessionId: 'acp-source',
        forkSessionTurnId: 'turn-previous-answer',
      })
    );
  });

  it('forks an older completed assistant turn through its persisted ACP turn id', async () => {
    const historicalSource: SessionHistoryInput[] = [
      {
        ...sourceHistory[0]!,
      },
      {
        ...sourceHistory[1]!,
        acpTurnId: 'turn-answer-1',
      },
      {
        id: 'assistant-2',
        timestamp: '2026-07-27T00:00:02.000Z',
        role: 'assistant',
        items: [{ type: 'text', text: 'later' }],
        fileDiff: [],
        finished: true,
        read: true,
      },
    ];
    const harness = createForkHarness(undefined, { sourceHistory: historicalSource });

    const result = await harness.service.fork(forkSpec);

    expect(result.success).toBe(true);
    expect(harness.sessionManager.createSession).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        forkSessionId: 'acp-source',
        forkSessionTurnId: 'turn-answer-1',
      })
    );
  });

  it('keeps the busy rejection for agents without active-turn fork points', async () => {
    const harness = createForkHarness(undefined, {
      sourceBusy: true,
      supportsActiveTurnFork: false,
    });

    const result = await harness.service.fork(forkSpec);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'SOURCE_SESSION_BUSY' },
    });
    expect(harness.sessionManager.createSession).not.toHaveBeenCalled();
  });

  it('does not start ACP when the target cannot be prepared durably', async () => {
    const harness = createForkHarness('session-fork-prepare');

    const result = await harness.service.fork(forkSpec);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'TARGET_WRITE_FAILED' },
    });
    expect(harness.sessionManager.createSession).not.toHaveBeenCalled();
    expect(harness.repo.deleteDoc).toHaveBeenCalledTimes(1);
    expect(harness.persistPendingChanges).toHaveBeenLastCalledWith('session-fork-rollback');
  });

  it('compensates the ACP fork when the final durable commit fails', async () => {
    const harness = createForkHarness('session-fork-commit');

    const result = await harness.service.fork(forkSpec);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'TARGET_WRITE_FAILED' },
    });
    expect(harness.sessionManager.createSession).toHaveBeenCalledTimes(1);
    expect(harness.sessionManager.terminateSession).toHaveBeenCalledWith(targetSessionId, true);
    expect(harness.repo.deleteDoc).toHaveBeenCalledTimes(1);
    expect(harness.persistPendingChanges).toHaveBeenLastCalledWith('session-fork-rollback');
  });

  it('requires confirmation for a dirty source without reserving the target', async () => {
    const harness = createForkHarness(undefined, {
      worktree: { dirty: true, headSha: 'a'.repeat(40) },
    });

    const result = await harness.service.fork({
      ...forkSpec,
      targetContext: { kind: 'new-worktree' },
    });

    expect(result).toMatchObject({
      success: false,
      disposition: 'confirmation-required',
      reason: 'SOURCE_WORKTREE_DIRTY',
    });
    expect(harness.targetDoc.setForkOperation).not.toHaveBeenCalled();
    expect(harness.sessionManager.createSession).not.toHaveBeenCalled();
  });

  it('accepts durably before creating an independent worktree from captured HEAD', async () => {
    const capturedHead = 'b'.repeat(40);
    const selectedMcpServerId = 'mcp-server-1' as McpServerId;
    const harness = createForkHarness(undefined, {
      worktree: { dirty: true, headSha: capturedHead },
      sourceHistory: [
        {
          ...sourceHistory[0]!,
          inputConfig: {
            prompt: 'hello',
            cliType: 'builtin',
            agentType: 'codex',
            mcpServerIds: [selectedMcpServerId],
          },
        },
        sourceHistory[1]!,
      ],
    });

    const result = await harness.service.fork({
      ...forkSpec,
      targetContext: { kind: 'new-worktree', acknowledgeDirtySource: true },
    });

    expect(result).toMatchObject({
      success: true,
      disposition: 'accepted',
      operationId: `session-fork:${targetSessionId}`,
    });
    expect(harness.persistPendingChanges).toHaveBeenCalledWith('session-fork-prepare');
    expect(harness.targetDoc.setForkOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        capturedHeadSha: capturedHead,
        sourceWasDirty: true,
        state: 'preparing',
      })
    );
    expect(harness.sessionManager.createSession).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(harness.sessionManager.createSession).toHaveBeenCalledTimes(1));
    expect(harness.sessionManager.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeStartPoint: capturedHead,
        deferWorktreeMetaPersistence: true,
        workdir: '/source/project-root',
        project: expect.objectContaining({ kind: 'local', useWorktree: true }),
        mcpServerIds: [selectedMcpServerId],
      }),
      expect.objectContaining({ forkSessionId: 'acp-source' })
    );
    expect(harness.sessionManager.createSession.mock.calls[0]?.[0]).not.toHaveProperty(
      'parentSessionId'
    );
    await vi.waitFor(() =>
      expect(harness.persistPendingChanges).toHaveBeenCalledWith('session-fork-commit')
    );
    expect(harness.targetDoc.updateHistory).toHaveBeenCalledTimes(1);
    expect(harness.targetDoc.setForkOperation).toHaveBeenLastCalledWith(undefined);
    // The recovery marker lives exactly as long as the durable preparing operation.
    expect(harness.forkOperationStore.record).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionId,
        operationId: `session-fork:${targetSessionId}`,
      })
    );
    // The saga back-fills the real branch name once git answers.
    await vi.waitFor(() =>
      expect(harness.forkOperationStore.record).toHaveBeenCalledWith(
        expect.objectContaining({ branchName: 'lody/target-session' })
      )
    );
    await vi.waitFor(() => expect(harness.markers).toEqual([]));
  });

  it('fails closed when the fork operation store cannot record the operation', async () => {
    const harness = createForkHarness(undefined, {
      worktree: { dirty: false, headSha: 'a'.repeat(40) },
      storeRecordFails: true,
    });

    const result = await harness.service.fork({
      ...forkSpec,
      targetContext: { kind: 'new-worktree' },
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: 'TARGET_WRITE_FAILED' },
    });
    expect(harness.targetDoc.setForkOperation).not.toHaveBeenCalled();
    expect(harness.sessionManager.createSession).not.toHaveBeenCalled();
    expect(harness.markers).toEqual([]);
  });

  it('clears the recovery marker when the prepare persist fails', async () => {
    const harness = createForkHarness('session-fork-prepare', {
      worktree: { dirty: false, headSha: 'a'.repeat(40) },
    });

    const result = await harness.service.fork({
      ...forkSpec,
      targetContext: { kind: 'new-worktree' },
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: 'TARGET_WRITE_FAILED' },
    });
    expect(harness.markers).toEqual([]);
  });
});

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SessionForkService fork operation recovery', () => {
  const cleanupPayload: SessionForkOperationCleanup = {
    project: { kind: 'local', localProjectId: 'local-project-1' as never },
    branch: 'main',
    workdir: '/source/project-root',
    requesterUserId: 'user-1',
    agentConfigId,
    cliType: 'builtin',
    agentType: 'codex',
  };
  const preparingOperation = {
    id: `session-fork:${targetSessionId}`,
    sourceSessionId,
    sourceTurnId: 'assistant-1',
    requestedByUserId: 'user-1',
    targetContext: 'new-worktree' as const,
    capturedHeadSha: 'a'.repeat(40),
    state: 'preparing' as const,
    phase: 'preparing-worktree' as const,
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
  };
  const staleMarker: SessionForkOperationMarker = {
    version: 1,
    workspaceId: 'workspace-1',
    machineId,
    targetSessionId,
    operationId: preparingOperation.id,
    createdAt: preparingOperation.createdAt,
    title: '(fork) Original',
    branchName: 'lody/target-ses',
    cleanup: cleanupPayload,
  };
  const forkOriginNotice = {
    id: `session-fork-origin:${targetSessionId}`,
    timestamp: '2026-08-16T00:01:00.000Z',
    role: 'system',
    items: [
      {
        type: 'system_notice',
        name: 'session_fork_origin',
        meta: { sourceSessionId, sourceTurnId: 'assistant-1', sourceTitle: 'Original' },
      },
    ],
    fileDiff: [],
    finished: true,
    read: true,
  } as SessionHistoryInput;

  it('recovers an interrupted worktree fork without opening unrelated session docs', async () => {
    const harness = createForkHarness(undefined, {
      forkOperation: preparingOperation,
      // Even a durable acpSessionId in the meta record must not count as
      // completion — its write is not flush-atomic with the doc's history.
      targetDocMetaRecord: {
        meta: { acpSessionId: 'acp-target', status: SessionStatusFactory.idle() },
      },
      markers: [staleMarker],
      aliveRoomIds: [
        getSessionRoomId(targetSessionId),
        getSessionRoomId('old-session-1' as SessionId),
        getSessionRoomId('old-session-2' as SessionId),
      ],
    });

    await harness.service.recoverPendingForks();

    // Compensation is built from the marker payload — the source doc is never opened.
    expect(harness.sessionManager.cleanupForkWorktree).toHaveBeenCalledTimes(1);
    expect(harness.sessionManager.cleanupForkWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: targetSessionId,
        project: cleanupPayload.project,
        branch: 'main',
        workdir: '/source/project-root',
      })
    );
    expect(harness.sessionManager.terminateSession).not.toHaveBeenCalled();
    expect(harness.targetDoc.setForkOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'failed' })
    );
    expect(harness.persistPendingChanges).toHaveBeenCalledWith('session-fork-rollback');
    expect(harness.markers).toEqual([]);
    // The point of the store: discovery never opens docs it was not pointed at.
    expect(harness.workspaceDocument.getOrCreateSessionDoc.mock.calls.map(([id]) => id)).toEqual([
      targetSessionId,
    ]);
    // And it never tears down manager-cached docs out from under other holders.
    expect(harness.workspaceDocument.cleanSessionDoc).not.toHaveBeenCalled();
    expect(harness.workspaceDocument.unloadDocRoom).not.toHaveBeenCalled();
  });

  it('recovers even when the marker createdAt is unparseable', async () => {
    const harness = createForkHarness(undefined, {
      forkOperation: preparingOperation,
      markers: [{ ...staleMarker, createdAt: 'not-a-date' }],
      aliveRoomIds: [getSessionRoomId(targetSessionId)],
    });

    await harness.service.recoverPendingForks();

    expect(harness.sessionManager.cleanupForkWorktree).toHaveBeenCalledTimes(1);
    expect(harness.markers).toEqual([]);
  });

  it('treats a cleared flag with a landed origin notice as complete', async () => {
    const harness = createForkHarness(undefined, {
      forkOperation: undefined,
      targetHistory: [forkOriginNotice],
      targetDocMetaRecord: {
        meta: { acpSessionId: 'acp-target', status: SessionStatusFactory.idle() },
      },
      markers: [staleMarker],
      aliveRoomIds: [getSessionRoomId(targetSessionId)],
    });

    await harness.service.recoverPendingForks();

    expect(harness.sessionManager.cleanupForkWorktree).not.toHaveBeenCalled();
    expect(harness.targetDoc.setForkOperation).not.toHaveBeenCalled();
    expect(harness.repo.upsertDocMeta).not.toHaveBeenCalled();
    expect(harness.persistPendingChanges).not.toHaveBeenCalled();
    expect(harness.markers).toEqual([]);
  });

  it('clears a stale preparing flag when the cloned history already landed', async () => {
    const harness = createForkHarness(undefined, {
      forkOperation: preparingOperation,
      targetHistory: [forkOriginNotice],
      targetDocMetaRecord: {
        meta: { acpSessionId: 'acp-target', status: SessionStatusFactory.idle() },
      },
      markers: [staleMarker],
      aliveRoomIds: [getSessionRoomId(targetSessionId)],
    });

    await harness.service.recoverPendingForks();

    // The worktree belongs to a visible session — clear the flag, never the worktree.
    expect(harness.sessionManager.cleanupForkWorktree).not.toHaveBeenCalled();
    expect(harness.repo.upsertDocMeta).not.toHaveBeenCalled();
    expect(harness.targetDoc.setForkOperation).toHaveBeenLastCalledWith(undefined);
    expect(harness.persistPendingChanges).toHaveBeenCalledWith('session-fork-commit');
    expect(harness.markers).toEqual([]);
  });

  it('republishes meta from the marker when the doc landed but meta was never published', async () => {
    const harness = createForkHarness(undefined, {
      forkOperation: preparingOperation,
      targetHistory: [forkOriginNotice],
      markers: [staleMarker],
      aliveRoomIds: [getSessionRoomId(targetSessionId)],
    });

    await harness.service.recoverPendingForks();

    expect(harness.sessionManager.cleanupForkWorktree).not.toHaveBeenCalled();
    expect(harness.repo.upsertDocMeta).toHaveBeenCalledTimes(1);
    const republished = harness.repo.upsertDocMeta.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(republished).toMatchObject({
      id: targetSessionId,
      machineId,
      title: '(fork) Original',
      branchName: 'lody/target-ses',
      userId: 'user-1',
      isWorktree: true,
    });
    // Unrecoverable in the repair: the next prompt starts a fresh ACP session.
    expect(republished.acpSessionId).toBeUndefined();
    expect(harness.targetDoc.setForkOperation).toHaveBeenLastCalledWith(undefined);
    expect(harness.persistPendingChanges).toHaveBeenCalledWith('session-fork-commit');
    expect(harness.markers).toEqual([]);
  });

  it('republishes meta even when the flag clear did land but meta did not', async () => {
    const harness = createForkHarness(undefined, {
      forkOperation: undefined,
      targetHistory: [forkOriginNotice],
      markers: [staleMarker],
      aliveRoomIds: [getSessionRoomId(targetSessionId)],
    });

    await harness.service.recoverPendingForks();

    expect(harness.repo.upsertDocMeta).toHaveBeenCalledTimes(1);
    expect(harness.targetDoc.setForkOperation).not.toHaveBeenCalled();
    expect(harness.persistPendingChanges).toHaveBeenCalledWith('session-fork-commit');
    expect(harness.markers).toEqual([]);
  });

  it('drops the marker without compensating when the prepare write never landed', async () => {
    const harness = createForkHarness(undefined, {
      markers: [staleMarker],
      aliveRoomIds: [getSessionRoomId(targetSessionId)],
    });

    await harness.service.recoverPendingForks();

    expect(harness.sessionManager.cleanupForkWorktree).not.toHaveBeenCalled();
    expect(harness.targetDoc.setForkOperation).not.toHaveBeenCalled();
    expect(harness.markers).toEqual([]);
  });

  it('drops the marker when the doc already holds a compensated failed receipt', async () => {
    const harness = createForkHarness(undefined, {
      forkOperation: { ...preparingOperation, state: 'failed' },
      markers: [staleMarker],
      aliveRoomIds: [getSessionRoomId(targetSessionId)],
    });

    await harness.service.recoverPendingForks();

    expect(harness.sessionManager.cleanupForkWorktree).not.toHaveBeenCalled();
    expect(harness.targetDoc.setForkOperation).not.toHaveBeenCalled();
    expect(harness.markers).toEqual([]);
  });

  it('clears the marker without opening a doc when the target room no longer exists', async () => {
    const harness = createForkHarness(undefined, {
      markers: [staleMarker],
      aliveRoomIds: [],
    });

    await harness.service.recoverPendingForks();

    expect(harness.workspaceDocument.getOrCreateSessionDoc).not.toHaveBeenCalled();
    expect(harness.sessionManager.cleanupForkWorktree).not.toHaveBeenCalled();
    expect(harness.markers).toEqual([]);
  });

  it('retains a missing-room marker until its orphaned account binding can be removed', async () => {
    const harness = createForkHarness(undefined, {
      markers: [staleMarker],
      aliveRoomIds: [],
    });
    vi.mocked(clearSessionAccountBinding).mockRejectedValueOnce(new Error('disk unavailable'));
    await harness.service.recoverPendingForks();
    expect(harness.markers).toEqual([staleMarker]);
    expect(harness.workspaceDocument.getOrCreateSessionDoc).not.toHaveBeenCalled();

    await harness.service.recoverPendingForks();
    expect(clearSessionAccountBinding).toHaveBeenLastCalledWith({
      workspaceId: 'workspace-1',
      machineId,
      sessionId: targetSessionId,
    });
    expect(harness.markers).toEqual([]);
  });

  it('ignores markers from other machines or workspaces without deleting them', async () => {
    const harness = createForkHarness(undefined, {
      markers: [
        { ...staleMarker, targetSessionId: 'other-workspace-target', workspaceId: 'workspace-2' },
        { ...staleMarker, targetSessionId: 'other-machine-target', machineId: 'machine-2' },
      ],
      aliveRoomIds: [getSessionRoomId(targetSessionId)],
    });

    await harness.service.recoverPendingForks();

    expect(harness.workspaceDocument.getOrCreateSessionDoc).not.toHaveBeenCalled();
    expect(harness.markers).toHaveLength(2);
  });

  it('does not roll back a fork this process is currently running', async () => {
    const createSessionGate = createDeferred();
    const harness = createForkHarness(undefined, {
      worktree: { dirty: false, headSha: 'a'.repeat(40) },
      createSessionGate: createSessionGate.promise,
      aliveRoomIds: [getSessionRoomId(targetSessionId)],
    });

    const accepted = await harness.service.fork({
      ...forkSpec,
      targetContext: { kind: 'new-worktree' },
    });
    expect(accepted).toMatchObject({ success: true, disposition: 'accepted' });
    await vi.waitFor(() => expect(harness.sessionManager.createSession).toHaveBeenCalled());

    // Recovery starts with the live saga mid-flight (blocked in createSession):
    // it must not terminate, compensate, or fail the operation.
    await harness.service.recoverPendingForks();
    expect(harness.sessionManager.cleanupForkWorktree).not.toHaveBeenCalled();
    expect(harness.sessionManager.terminateSession).not.toHaveBeenCalled();
    expect(harness.targetDoc.setForkOperation).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'failed' })
    );
    expect(harness.markers).toHaveLength(1);

    createSessionGate.resolve();
    await vi.waitFor(() =>
      expect(harness.persistPendingChanges).toHaveBeenCalledWith('session-fork-commit')
    );
    await vi.waitFor(() => expect(harness.markers).toEqual([]));
  });

  it('ignores a stale listing snapshot after a same-target retry rewrites the marker', async () => {
    const listGate = createDeferred();
    const createSessionGate = createDeferred();
    const harness = createForkHarness(undefined, {
      worktree: { dirty: false, headSha: 'a'.repeat(40) },
      markers: [staleMarker],
      storeListGate: listGate.promise,
      createSessionGate: createSessionGate.promise,
      aliveRoomIds: [getSessionRoomId(targetSessionId)],
    });

    // Recovery captures its listing snapshot (the crashed attempt's marker) and
    // parks on the gate; the client's same-target retry then lands first.
    const recovery = harness.service.recoverPendingForks();
    const accepted = await harness.service.fork({
      ...forkSpec,
      targetContext: { kind: 'new-worktree' },
    });
    expect(accepted).toMatchObject({ success: true, disposition: 'accepted' });
    await vi.waitFor(() => expect(harness.sessionManager.createSession).toHaveBeenCalled());

    listGate.resolve();
    await recovery;

    expect(harness.sessionManager.cleanupForkWorktree).not.toHaveBeenCalled();
    expect(harness.sessionManager.terminateSession).not.toHaveBeenCalled();
    expect(harness.targetDoc.setForkOperation).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'failed' })
    );
    expect(harness.markers).toHaveLength(1);

    createSessionGate.resolve();
    await vi.waitFor(() =>
      expect(harness.persistPendingChanges).toHaveBeenCalledWith('session-fork-commit')
    );
    await vi.waitFor(() => expect(harness.markers).toEqual([]));
  });
});

// Fixtures model trusted local bindings; filesystem authority has separate regression coverage.
vi.mock('./session-account-binding-store', () => ({
  resolveSessionAccountMeta: vi.fn(async (_scope: unknown, meta: SessionMeta) => meta),
  getSessionAccountBinding: vi.fn(async () => null),
  setSessionAccountBinding: vi.fn(async () => {}),
  updateSessionAccountNativeId: vi.fn(async () => {}),
  clearSessionAccountBinding: vi.fn(async () => {}),
}));

it('does not overwrite or clear an existing target local account binding', async () => {
  const harness = createForkHarness();
  vi.mocked(getSessionAccountBinding).mockResolvedValueOnce({ accountProfileId: 'system-default' });
  vi.mocked(clearSessionAccountBinding).mockClear();
  const result = await harness.service.fork(forkSpec);
  expect(result.success).toBe(false);
  expect(harness.sessionManager.createSession).not.toHaveBeenCalled();
  expect(clearSessionAccountBinding).not.toHaveBeenCalled();
});
