import { describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import type { Logger } from '../src/utils/logger';
import { SessionDispatchWatcher } from '../src/session/session-dispatch-watcher';
import type { SessionExecutionService } from '../src/session/session-execution-service';
import { SessionDocument, type LoroDocumentManager } from '../src/lib/loro/doc';
import { findNextDispatchableUserTurn } from '../src/session/session-dispatch-logic';
import {
  buildMissingEmail,
  getPendingUserTurnActivationId,
  hasPendingUserTurnActivation,
  type MessageContent,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';

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

const createAllowMachineAccess = () => vi.fn(async () => ({ outcome: 'allowed' as const }));

type WatcherDeps = ConstructorParameters<typeof SessionDispatchWatcher>[0];

const createTestUserResolver = () => ({
  resolve: vi.fn(async (userId: string) => ({
    id: userId,
    name: `${userId}@lody.test`,
    email: `${userId}@lody.test`,
  })),
  clear: vi.fn(),
});

const addPreparedDispatchShim = (
  executionService: SessionExecutionService
): SessionExecutionService => {
  const service = executionService as SessionExecutionService & {
    dispatchPreparedSessionTurn?: (options: {
      dispatchSource: string;
      accessPromise: Promise<{ outcome: string }>;
      requestPromise: Promise<{ mode: 'create' | 'continue'; request: unknown }>;
      onAccessAllowed: () => void | Promise<void>;
      onAccessDenied: (access: { outcome: 'denied'; reason: unknown }) => void | Promise<void>;
      onAccessIndeterminate: (access: {
        outcome: 'indeterminate';
        error?: unknown;
      }) => void | Promise<void>;
    }) => Promise<void>;
    startSession?: (request: unknown, options?: unknown) => Promise<void>;
    continueSession?: (request: unknown, options?: unknown) => Promise<void>;
    tryAcquireSessionRewriteConflictLease?: () => (() => void) | null;
  };
  service.tryAcquireSessionRewriteConflictLease ??= () => () => {};
  if (service.dispatchPreparedSessionTurn) {
    return executionService;
  }
  service.dispatchPreparedSessionTurn = vi.fn(async (options) => {
    const access = await options.accessPromise;
    if (access.outcome === 'denied') {
      await options.onAccessDenied(access as { outcome: 'denied'; reason: unknown });
      return;
    }
    if (access.outcome === 'indeterminate') {
      await options.onAccessIndeterminate(access as { outcome: 'indeterminate'; error?: unknown });
      return;
    }
    await options.onAccessAllowed();
    const builtRequest = await options.requestPromise;
    if (builtRequest.mode === 'create') {
      await service.startSession?.(builtRequest.request, {
        dispatchSource: options.dispatchSource,
      });
      return;
    }
    await service.continueSession?.(builtRequest.request, {
      dispatchSource: options.dispatchSource,
    });
  });
  return service;
};

const createWatcher = (deps: WatcherDeps): SessionDispatchWatcher =>
  new SessionDispatchWatcher({
    userResolver: createTestUserResolver(),
    ...deps,
    executionService: addPreparedDispatchShim(deps.executionService),
  });

const runMaybeHandleSession = (watcher: SessionDispatchWatcher, sessionId: SessionId) =>
  (
    watcher as unknown as {
      maybeHandleSession: (sessionId: SessionId) => Promise<void>;
    }
  ).maybeHandleSession(sessionId);

const flushMicrotasks = async (count = 8) => {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
};

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('SessionDispatchWatcher', () => {
  const createPendingUserTurn = (id: string, text: string): SessionHistoryInput => ({
    id,
    role: 'user',
    items: [{ type: 'text', text }] satisfies MessageContent[],
    timestamp: new Date().toISOString(),
    status: 'pending',
    read: false,
    userId: 'user-1',
  });

  it('processes pending user turns for an idle owned session', async () => {
    const continueSession = vi.fn(async () => {});
    const startSession = vi.fn(async () => {});
    const cancelSession = vi.fn(async () => ({ success: true }));
    const sessionId = 'session-1' as SessionId;
    const roomId = `session-${sessionId}`;

    const sessionDoc = {
      mirror: {
        subscribe: vi.fn(() => vi.fn()),
      },
      getMetaState: vi.fn(async () => ({
        id: sessionId,
        machineId: 'machine-1',
        userId: 'user-1',
        createdAt: new Date().toISOString(),
        cliType: 'builtin',
        agentType: 'codex',
        status: { type: 'idle' },
        parentSessionId: 'parent-session-1',
        latestUserMsgId: 'turn-1',
      })),
      getHistory: vi.fn(async () => [createPendingUserTurn('turn-1', 'hello')]),
      updateHistory: vi.fn(async () => {}),
      setStatus: vi.fn(async () => {}),
      waitForRemoteSync: vi.fn(async () => {}),
    };

    const workspaceDocument = {
      repo: {
        getMeta: () => ({
          scan: vi.fn(async () => [{ key: ['e', roomId], value: true }]),
        }),
        getDocMeta: vi.fn(async () => ({
          meta: {
            id: sessionId,
            machineId: 'machine-1',
            userId: 'user-1',
            createdAt: new Date().toISOString(),
            cliType: 'builtin',
            agentType: 'codex',
            status: { type: 'idle' },
            parentSessionId: 'parent-session-1',
            latestUserMsgId: 'turn-1',
          },
        })),
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
      },
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      onMetaRoomSynced: vi.fn(() => vi.fn()),
    } as unknown as LoroDocumentManager;

    const watcher = createWatcher({
      logger: createSilentLogger(),
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      workspaceDocument,
      executionService: {
        getExecutionSnapshot: vi.fn(() => ({
          hasActiveTurn: false,
          hasBlockingPendingCreate: false,
          hasReusableSession: false,
        })),
        continueSession,
        startSession,
        cancelSession,
      } as unknown as SessionExecutionService,
      canUseMachine: createAllowMachineAccess(),
    });

    await watcher.start();

    await vi.waitFor(
      () => {
        expect(startSession).toHaveBeenCalledTimes(1);
      },
      { timeout: 3_000 }
    );
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session/create',
        sessionId,
        userTurnId: 'turn-1',
        parentSessionId: 'parent-session-1',
      }),
      { dispatchSource: 'crdt' }
    );
  });

  it('does not block pure chat dispatch on remote user profile lookup', async () => {
    const continueSession = vi.fn(async () => {});
    const startSession = vi.fn(async () => {});
    const cancelSession = vi.fn(async () => ({ success: true }));
    const sessionId = 'session-pure-chat-user-lookup' as SessionId;
    const userId = 'user-1';
    const sessionMeta: SessionMeta = {
      id: sessionId,
      machineId: 'machine-1',
      userId,
      createdAt: new Date().toISOString(),
      cliType: 'builtin',
      agentType: 'codex',
      status: { type: 'idle' },
      acpSessionId: 'acp-existing',
    };

    const sessionDoc = {
      mirror: {
        subscribe: vi.fn(() => vi.fn()),
      },
      getMetaState: vi.fn(async () => sessionMeta),
      getHistory: vi.fn(async () => [createPendingUserTurn('turn-chat-1', 'hello')]),
      updateHistory: vi.fn(async () => {}),
      setStatus: vi.fn(async () => {}),
      waitForRemoteSync: vi.fn(async () => {}),
    };

    const workspaceDocument = {
      repo: {
        getDocMeta: vi.fn(async () => ({ meta: sessionMeta })),
        upsertDocMeta: vi.fn(async () => {}),
        openFlockDoc: vi.fn(async () => ({
          flock: { scan: () => [] },
        })),
      },
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      onMetaRoomSynced: vi.fn(() => vi.fn()),
    } as unknown as LoroDocumentManager;
    const userResolver = {
      resolve: vi.fn(() => new Promise<never>(() => {})),
      clear: vi.fn(),
    };

    const watcher = createWatcher({
      logger: createSilentLogger(),
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      workspaceDocument,
      executionService: {
        getExecutionSnapshot: vi.fn(() => ({
          hasActiveTurn: false,
          hasBlockingPendingCreate: false,
          hasReusableSession: true,
        })),
        continueSession,
        startSession,
        cancelSession,
      } as unknown as SessionExecutionService,
      canUseMachine: createAllowMachineAccess(),
      userResolver,
    });

    await runMaybeHandleSession(watcher, sessionId);

    expect(userResolver.resolve).toHaveBeenCalledWith(userId);
    expect(continueSession).toHaveBeenCalledTimes(1);
    expect(continueSession).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session/chat',
        sessionId,
        userTurnId: 'turn-chat-1',
        userName: buildMissingEmail('lody', userId),
        userEmail: buildMissingEmail('lody', userId),
      }),
      { dispatchSource: 'crdt' }
    );
    expect(startSession).not.toHaveBeenCalled();
  });

  it('dispatches a stashed RPC turn before its history entry syncs', async () => {
    const continueSession = vi.fn(async () => {});
    const startSession = vi.fn(async () => {});
    const cancelSession = vi.fn(async () => ({ success: true }));
    const sessionId = 'session-rpc-push' as SessionId;
    const sessionMeta = {
      id: sessionId,
      machineId: 'machine-1',
      userId: 'user-1',
      createdAt: new Date().toISOString(),
      cliType: 'builtin',
      agentType: 'codex',
      status: { type: 'idle' as const },
    };

    const sessionDoc = {
      mirror: {
        subscribe: vi.fn(() => vi.fn()),
      },
      getMetaState: vi.fn(async () => sessionMeta),
      getHistory: vi.fn(async () => []),
      updateHistory: vi.fn(async () => {}),
      setStatus: vi.fn(async () => {}),
      waitForRemoteSync: vi.fn(async () => {}),
    };

    const workspaceDocument = {
      repo: {
        getDocMeta: vi.fn(async () => ({ meta: sessionMeta })),
        upsertDocMeta: vi.fn(async () => {}),
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
      },
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      onMetaRoomSynced: vi.fn(() => vi.fn()),
    } as unknown as LoroDocumentManager;

    const watcher = createWatcher({
      logger: createSilentLogger(),
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      workspaceDocument,
      executionService: {
        getExecutionSnapshot: vi.fn(() => ({
          hasActiveTurn: false,
          hasBlockingPendingCreate: false,
          hasReusableSession: false,
        })),
        continueSession,
        startSession,
        cancelSession,
      } as unknown as SessionExecutionService,
      canUseMachine: createAllowMachineAccess(),
    });

    const disposition = await watcher.offerRpcTurn({
      sessionId,
      userTurnId: 'rpc-turn-1',
      userId: 'user-1',
      timestamp: new Date().toISOString(),
      inputConfig: { prompt: 'hello from rpc' },
    });
    expect(disposition).toBe('accepted');

    await vi.waitFor(
      () => {
        expect(startSession).toHaveBeenCalledTimes(1);
      },
      { timeout: 3_000 }
    );
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session/create',
        sessionId,
        userTurnId: 'rpc-turn-1',
        acpSessionConfig: expect.objectContaining({ prompt: 'hello from rpc' }),
      }),
      { dispatchSource: 'rpc' }
    );
    // Offering the same turn again after dispatch is idempotent.
    const again = await watcher.offerRpcTurn({
      sessionId,
      userTurnId: 'rpc-turn-1',
      userId: 'user-1',
      timestamp: new Date().toISOString(),
      inputConfig: { prompt: 'hello from rpc' },
    });
    expect(again === 'accepted' || again === 'duplicate' || again === 'already-terminal').toBe(
      true
    );
  });

  it('keeps a stashed RPC turn while session meta is unknown and dispatches once meta syncs', async () => {
    const startSession = vi.fn(async () => {});
    const sessionId = 'session-rpc-before-meta' as SessionId;
    const sessionMeta = {
      id: sessionId,
      machineId: 'machine-1',
      userId: 'user-1',
      createdAt: new Date().toISOString(),
      cliType: 'builtin',
      agentType: 'codex',
      status: { type: 'idle' as const },
    };
    // The session was just created on another client: its meta has not synced
    // to this machine yet, but the dispatch RPC already targeted it.
    let metaRecord: { meta: typeof sessionMeta } | undefined;
    let metadataWatchCallback: ((event: { kind: string; docId: string }) => void) | undefined;

    const sessionDoc = {
      mirror: {
        subscribe: vi.fn(() => vi.fn()),
      },
      getMetaState: vi.fn(async () => metaRecord?.meta),
      getHistory: vi.fn(async () => []),
      updateHistory: vi.fn(async () => {}),
      setStatus: vi.fn(async () => {}),
      waitForRemoteSync: vi.fn(async () => {}),
    };

    const getDocMeta = vi.fn(async () => metaRecord);
    const workspaceDocument = {
      repo: {
        getMeta: () => ({ scan: vi.fn(async () => []) }),
        getDocMeta,
        upsertDocMeta: vi.fn(async () => {}),
        watch: vi.fn((callback: (event: { kind: string; docId: string }) => void) => {
          metadataWatchCallback = callback;
          return { unsubscribe: vi.fn() };
        }),
      },
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      onMetaRoomSynced: vi.fn(() => vi.fn()),
    } as unknown as LoroDocumentManager;

    const watcher = createWatcher({
      logger: createSilentLogger(),
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      workspaceDocument,
      executionService: {
        getExecutionSnapshot: vi.fn(() => ({
          hasActiveTurn: false,
          hasBlockingPendingCreate: false,
          hasReusableSession: false,
        })),
        continueSession: vi.fn(async () => {}),
        startSession,
        cancelSession: vi.fn(async () => ({ success: true })),
      } as unknown as SessionExecutionService,
      canUseMachine: createAllowMachineAccess(),
    });

    await watcher.start();

    await expect(
      watcher.offerRpcTurn({
        sessionId,
        userTurnId: 'rpc-turn-early',
        userId: 'user-1',
        timestamp: new Date().toISOString(),
        inputConfig: { prompt: 'created before meta sync' },
      })
    ).resolves.toBe('accepted');

    // A metadata reconcile while meta is still absent must treat the session
    // as unknown, not foreign: the stashed turn survives, nothing dispatches.
    const reconcileReadsBefore = getDocMeta.mock.calls.length;
    metadataWatchCallback?.({ kind: 'doc-metadata', docId: `session-${sessionId}` });
    await vi.waitFor(
      () => {
        expect(getDocMeta.mock.calls.length).toBeGreaterThan(reconcileReadsBefore);
      },
      { timeout: 3_000 }
    );
    await flushMicrotasks(16);
    expect(startSession).not.toHaveBeenCalled();

    // Meta arrival fires the metadata watch again; the kept stash dispatches.
    metaRecord = { meta: sessionMeta };
    metadataWatchCallback?.({ kind: 'doc-metadata', docId: `session-${sessionId}` });
    await vi.waitFor(
      () => {
        expect(startSession).toHaveBeenCalledTimes(1);
      },
      { timeout: 3_000 }
    );
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session/create',
        sessionId,
        userTurnId: 'rpc-turn-early',
        acpSessionConfig: expect.objectContaining({ prompt: 'created before meta sync' }),
      }),
      { dispatchSource: 'rpc' }
    );
    watcher.stop();
  });

  it('preempts an in-flight Doc Room join when an RPC turn arrives', async () => {
    const sessionId = 'session-rpc-during-doc-join' as SessionId;
    const userTurnId = 'rpc-turn-during-doc-join';
    const sessionMeta = {
      id: sessionId,
      machineId: 'machine-1',
      userId: 'user-1',
      createdAt: new Date().toISOString(),
      cliType: 'builtin',
      agentType: 'codex',
      status: { type: 'idle' as const },
      latestUserMsgId: userTurnId,
    } satisfies SessionMeta;
    let hasActiveTurn = false;
    const startSession = vi.fn(async () => {
      hasActiveTurn = true;
    });
    const waitUntilSynced = vi.fn(async () => true);
    const ensureDocRoomJoined = vi.fn(() => new Promise<void>(() => {}));
    const sessionDoc = {
      mirror: {
        subscribe: vi.fn(() => vi.fn()),
      },
      getMetaState: vi.fn(async () => sessionMeta),
      getHistory: vi.fn(async () => []),
      updateHistory: vi.fn(async () => {}),
      setStatus: vi.fn(async () => {}),
      waitForRemoteSync: vi.fn(async () => {}),
      waitUntilSynced,
      ensureDocRoomJoined,
      getDocRoomStatus: vi.fn(() => 'joined' as const),
      onDocRoomStatusChange: vi.fn(() => vi.fn()),
      rejoinDocRoom: vi.fn(async () => {}),
    };
    const workspaceDocument = {
      repo: {
        getDocMeta: vi.fn(async () => ({ meta: sessionMeta })),
        upsertDocMeta: vi.fn(async () => {}),
      },
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
    } as unknown as LoroDocumentManager;
    const watcher = createWatcher({
      logger: createSilentLogger(),
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      workspaceDocument,
      executionService: {
        getExecutionSnapshot: vi.fn(() => ({
          hasActiveTurn,
          hasBlockingPendingCreate: false,
          hasReusableSession: false,
        })),
        continueSession: vi.fn(async () => {}),
        startSession,
        cancelSession: vi.fn(async () => ({ success: true })),
      } as unknown as SessionExecutionService,
      canUseMachine: createAllowMachineAccess(),
    });

    void watcher.enqueueSessionCheck(sessionId);
    await vi.waitFor(() => expect(ensureDocRoomJoined).toHaveBeenCalledTimes(1));

    await expect(
      watcher.offerRpcTurn({
        sessionId,
        userTurnId,
        userId: 'user-1',
        timestamp: new Date().toISOString(),
        inputConfig: { prompt: 'arrived while joining' },
      })
    ).resolves.toBe('accepted');

    await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        userTurnId,
        acpSessionConfig: expect.objectContaining({ prompt: 'arrived while joining' }),
      }),
      { dispatchSource: 'rpc' }
    );
    expect(waitUntilSynced).not.toHaveBeenCalled();
    watcher.stop();
  });

  it('drops expired RPC stashes without touching session presence', async () => {
    const sessionId = 'session-rpc-expired' as SessionId;
    const otherSessionId = 'session-rpc-other' as SessionId;
    const publishSessionPresence = vi.fn();
    const clearSessionPresence = vi.fn();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(0);
    const workspaceDocument = {
      repo: {
        getDocMeta: vi.fn(async () => undefined),
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
      },
      getOrCreateSessionDoc: vi.fn(async () => ({
        getMetaState: vi.fn(async () => undefined),
      })),
      onMetaRoomSynced: vi.fn(() => vi.fn()),
      publishSessionPresence,
      clearSessionPresence,
    } as unknown as LoroDocumentManager;
    const executionService = {
      getExecutionSnapshot: vi.fn(() => ({
        hasActiveTurn: false,
        hasBlockingPendingCreate: false,
        hasReusableSession: false,
      })),
      continueSession: vi.fn(async () => {}),
      startSession: vi.fn(async () => {}),
      cancelSession: vi.fn(async () => ({ success: true })),
    } as unknown as SessionExecutionService;

    const watcher = createWatcher({
      logger: createSilentLogger(),
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      workspaceDocument,
      executionService,
      canUseMachine: createAllowMachineAccess(),
    });

    try {
      await expect(
        watcher.offerRpcTurn({
          sessionId,
          userTurnId: 'rpc-turn-expired',
          userId: 'user-1',
          timestamp: new Date().toISOString(),
          inputConfig: { prompt: 'expired before meta sync' },
        })
      ).resolves.toBe('accepted');
      expect(watcher.hasPendingDispatch(sessionId)).toBe(true);

      const stashTtlMs =
        (SessionDispatchWatcher as unknown as { RPC_TURN_STASH_TTL_MS: number })
          .RPC_TURN_STASH_TTL_MS ?? 10 * 60_000;
      nowSpy.mockReturnValue(stashTtlMs + 1);
      expect(watcher.hasPendingDispatch(sessionId)).toBe(false);

      await expect(
        watcher.offerRpcTurn({
          sessionId: otherSessionId,
          userTurnId: 'rpc-turn-other',
          userId: 'user-1',
          timestamp: new Date().toISOString(),
          inputConfig: { prompt: 'trigger sweep' },
        })
      ).resolves.toBe('accepted');

      expect(publishSessionPresence).not.toHaveBeenCalled();
      expect(clearSessionPresence).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('holds a stashed RPC turn while the missing-history marker names it, and never revives it once the turn is superseded', async () => {
    const continueSession = vi.fn(async () => {});
    const startSession = vi.fn(async () => {});
    const cancelSession = vi.fn(async () => ({ success: true }));
    const sessionId = 'session-rpc-marker-suppressed' as SessionId;
    const userTurnId = 'turn-missing';
    let currentMeta: SessionMeta = {
      id: sessionId,
      machineId: 'machine-1',
      userId: 'user-1',
      createdAt: new Date().toISOString(),
      cliType: 'builtin',
      agentType: 'codex',
      status: { type: 'idle' as const },
      latestUserMsgId: userTurnId,
      lastMissingHistoryUserMsgId: userTurnId,
    };
    let currentHistory: SessionHistoryInput[] = [];

    const sessionDoc = {
      roomId: `session-${sessionId}`,
      mirror: {
        subscribe: vi.fn(() => vi.fn()),
      },
      getMetaState: vi.fn(async () => currentMeta),
      getHistory: vi.fn(async () => currentHistory),
      updateHistory: vi.fn(async () => {}),
      setStatus: vi.fn(async () => {}),
      waitForRemoteSync: vi.fn(async () => {}),
    };

    const workspaceDocument = {
      repo: {
        getDocMeta: vi.fn(async () => ({ meta: currentMeta })),
        upsertDocMeta: vi.fn(async () => {}),
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
      },
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      onMetaRoomSynced: vi.fn(() => vi.fn()),
    } as unknown as LoroDocumentManager;

    const watcher = createWatcher({
      logger: createSilentLogger(),
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      workspaceDocument,
      executionService: {
        getExecutionSnapshot: vi.fn(() => ({
          hasActiveTurn: false,
          hasBlockingPendingCreate: false,
          hasReusableSession: false,
        })),
        continueSession,
        startSession,
        cancelSession,
      } as unknown as SessionExecutionService,
      canUseMachine: createAllowMachineAccess(),
    });

    await expect(
      watcher.offerRpcTurn({
        sessionId,
        userTurnId,
        userId: 'user-1',
        timestamp: new Date().toISOString(),
        inputConfig: { prompt: 'held by the marker' },
      })
    ).resolves.toBe('accepted');

    // A duplicate RPC offer alone must not resurrect the negatively
    // acknowledged turn: the stash keeps it, but no source may dispatch it.
    await runMaybeHandleSession(watcher, sessionId);
    expect(startSession).not.toHaveBeenCalled();
    expect(continueSession).not.toHaveBeenCalled();
    expect(watcher.hasPendingDispatch(sessionId)).toBe(true);

    // The user resent the content as a NEW message: an ordinary producer send
    // cleared the marker, and the abandoned entry was superseded to a terminal
    // status. The stashed copy of the old turn must be dropped, never
    // dispatched as a duplicate of the resend.
    currentMeta = {
      ...currentMeta,
      latestUserMsgId: 'turn-resent',
      lastHandledUserMsgId: 'turn-resent',
      lastMissingHistoryUserMsgId: undefined,
    };
    currentHistory = [
      {
        id: userTurnId,
        role: 'user',
        timestamp: new Date().toISOString(),
        items: [{ type: 'text', text: 'held by the marker' }],
        fileDiff: [],
        status: 'canceled',
        read: true,
      },
    ];
    await runMaybeHandleSession(watcher, sessionId);
    expect(startSession).not.toHaveBeenCalled();
    expect(continueSession).not.toHaveBeenCalled();
    expect(watcher.hasPendingDispatch(sessionId)).toBe(false);
  });

  it('repairs a late-arriving entry for an already-handled fast-path turn instead of re-dispatching', async () => {
    const continueSession = vi.fn(async () => {});
    const startSession = vi.fn(async () => {});
    const cancelSession = vi.fn(async () => ({ success: true }));
    const sessionId = 'session-rpc-repair' as SessionId;
    const sessionMeta = {
      id: sessionId,
      machineId: 'machine-1',
      userId: 'user-1',
      createdAt: new Date().toISOString(),
      cliType: 'builtin',
      agentType: 'codex',
      status: { type: 'idle' as const },
      latestUserMsgId: 'turn-late',
      lastHandledUserMsgId: 'turn-late',
    };
    let history: SessionHistoryInput[] = [createPendingUserTurn('turn-late', 'late entry')];

    const sessionDoc = {
      // No mirror: after the repair there is no dispatchable turn, and the
      // legacy realtime wait resolves immediately without one.
      mirror: undefined,
      getMetaState: vi.fn(async () => sessionMeta),
      getHistory: vi.fn(async () => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
      setStatus: vi.fn(async () => {}),
      waitForRemoteSync: vi.fn(async () => {}),
    };

    const workspaceDocument = {
      repo: {
        getDocMeta: vi.fn(async () => ({ meta: sessionMeta })),
        upsertDocMeta: vi.fn(async () => {}),
      },
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
    } as unknown as LoroDocumentManager;

    const watcher = createWatcher({
      logger: createSilentLogger(),
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      workspaceDocument,
      executionService: {
        getExecutionSnapshot: vi.fn(() => ({
          hasActiveTurn: false,
          hasBlockingPendingCreate: false,
          hasReusableSession: false,
        })),
        getTerminalUserTurnStatusWithoutEntry: vi.fn(() => 'handled' as const),
        clearTerminalUserTurnStatusWithoutEntry: vi.fn(),
        continueSession,
        startSession,
        cancelSession,
      } as unknown as SessionExecutionService,
      canUseMachine: createAllowMachineAccess(),
    });

    await runMaybeHandleSession(watcher, sessionId);
    await flushMicrotasks();

    expect(startSession).not.toHaveBeenCalled();
    expect(continueSession).not.toHaveBeenCalled();
    expect(history[0]?.status).toBe('handled');
  });

  it('repairs a late entry to failed (not handled) when the handled pointer advanced but no completed assistant entry exists', async () => {
    // Restart scenario: a denied/canceled fast-path turn advanced
    // lastHandledUserMsgId, then the CLI restarted (in-memory terminal record
    // lost) before the pending user entry synced. Without a completed assistant
    // entry, the turn did NOT succeed, so the late entry must become 'failed',
    // never 'handled', and must not re-dispatch.
    const continueSession = vi.fn(async () => {});
    const startSession = vi.fn(async () => {});
    const cancelSession = vi.fn(async () => ({ success: true }));
    const sessionId = 'session-restart-denied' as SessionId;
    const sessionMeta = {
      id: sessionId,
      machineId: 'machine-1',
      userId: 'user-1',
      createdAt: new Date().toISOString(),
      cliType: 'builtin',
      agentType: 'codex',
      status: { type: 'idle' as const },
      latestUserMsgId: 'turn-denied',
      lastHandledUserMsgId: 'turn-denied',
    };
    let history: SessionHistoryInput[] = [createPendingUserTurn('turn-denied', 'denied entry')];

    const sessionDoc = {
      mirror: undefined,
      getMetaState: vi.fn(async () => sessionMeta),
      getHistory: vi.fn(async () => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
      setStatus: vi.fn(async () => {}),
      waitForRemoteSync: vi.fn(async () => {}),
    };

    const workspaceDocument = {
      repo: {
        getDocMeta: vi.fn(async () => ({ meta: sessionMeta })),
        upsertDocMeta: vi.fn(async () => {}),
      },
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
    } as unknown as LoroDocumentManager;

    const watcher = createWatcher({
      logger: createSilentLogger(),
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      workspaceDocument,
      executionService: {
        getExecutionSnapshot: vi.fn(() => ({
          hasActiveTurn: false,
          hasBlockingPendingCreate: false,
          hasReusableSession: false,
        })),
        // In-memory record lost across the restart.
        getTerminalUserTurnStatusWithoutEntry: vi.fn(() => undefined),
        clearTerminalUserTurnStatusWithoutEntry: vi.fn(),
        continueSession,
        startSession,
        cancelSession,
      } as unknown as SessionExecutionService,
      canUseMachine: createAllowMachineAccess(),
    });

    await runMaybeHandleSession(watcher, sessionId);
    await flushMicrotasks();

    expect(startSession).not.toHaveBeenCalled();
    expect(continueSession).not.toHaveBeenCalled();
    expect(history[0]?.status).toBe('failed');
  });

  it('marks a pending turn failed when backend machine access denies it', async () => {
    const continueSession = vi.fn(async () => {});
    const startSession = vi.fn(async () => {});
    const cancelSession = vi.fn(async () => ({ success: true }));
    const sessionId = 'session-denied' as SessionId;
    const roomId = `session-${sessionId}`;
    let history = [createPendingUserTurn('turn-denied', 'hello')];
    const upsertDocMeta = vi.fn(async () => {});

    const sessionDoc = {
      mirror: {
        subscribe: vi.fn(() => vi.fn()),
      },
      getMetaState: vi.fn(async () => ({
        id: sessionId,
        machineId: 'machine-1',
        userId: 'user-2',
        createdAt: new Date().toISOString(),
        cliType: 'builtin',
        agentType: 'codex',
        status: { type: 'idle' },
        latestUserMsgId: 'turn-denied',
      })),
      getHistory: vi.fn(async () => history),
      updateHistory: vi.fn(
        async (updateFn: (items: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          history = updateFn(history);
        }
      ),
      setStatus: vi.fn(async () => {}),
      waitForRemoteSync: vi.fn(async () => {}),
    };

    const workspaceDocument = {
      repo: {
        getMeta: () => ({
          scan: vi.fn(async () => [{ key: ['e', roomId], value: true }]),
        }),
        getDocMeta: vi.fn(async () => ({
          meta: {
            id: sessionId,
            machineId: 'machine-1',
            userId: 'user-2',
            createdAt: new Date().toISOString(),
            cliType: 'builtin',
            agentType: 'codex',
            status: { type: 'idle' },
            latestUserMsgId: 'turn-denied',
          },
        })),
        upsertDocMeta,
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
      },
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      onMetaRoomSynced: vi.fn(() => vi.fn()),
    } as unknown as LoroDocumentManager;

    const canUseMachine = vi.fn(async () => ({
      outcome: 'denied' as const,
      reason: 'not_visible' as const,
    }));
    const recordChatFailure = vi.fn(async () => {});

    const watcher = createWatcher({
      logger: createSilentLogger(),
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      workspaceDocument,
      executionService: {
        getExecutionSnapshot: vi.fn(() => ({
          hasActiveTurn: false,
          hasBlockingPendingCreate: false,
          hasReusableSession: false,
        })),
        continueSession,
        startSession,
        cancelSession,
      } as unknown as SessionExecutionService,
      canUseMachine,
      recordChatFailure,
    });

    await watcher.start();

    await vi.waitFor(() => {
      expect(upsertDocMeta).toHaveBeenCalledTimes(1);
    });

    expect(startSession).not.toHaveBeenCalled();
    expect(continueSession).not.toHaveBeenCalled();
    expect(canUseMachine).toHaveBeenCalledWith({
      sessionId,
      requesterUserId: 'user-1',
    });
    expect(history[0]).toEqual(
      expect.objectContaining({
        id: 'turn-denied',
        status: 'failed',
        read: true,
      })
    );
    expect(upsertDocMeta).toHaveBeenCalledWith(roomId, {
      lastHandledUserMsgId: 'turn-denied',
      processingUserMsgId: undefined,
    });
    // A definitive denial must be surfaced to the user, not silently marked
    // "Delivered". The watcher emits a chat_failed notice for it.
    expect(recordChatFailure).toHaveBeenCalledWith(
      sessionDoc,
      'machine_access_denied',
      expect.any(String)
    );
  });

  // Minimal harness for the access-verification paths. The pending turn is already
  // in history, so dispatch reaches the canUseMachine gate without the 5-min wait.
  const createAccessHarness = (opts: {
    canUseMachine: WatcherDeps['canUseMachine'];
    accessPolicy?: WatcherDeps['accessPolicy'];
    currentUserId?: WatcherDeps['currentUserId'];
    recordOwnerAccessSnapshot?: WatcherDeps['recordOwnerAccessSnapshot'];
    recordChatFailure?: WatcherDeps['recordChatFailure'];
    onFatalAuthFailure?: WatcherDeps['onFatalAuthFailure'];
  }) => {
    const startSession = vi.fn(async () => {});
    const continueSession = vi.fn(async () => {});
    const cancelSession = vi.fn(async () => ({ success: true }));
    const sessionId = 'session-access' as SessionId;
    const roomId = `session-${sessionId}`;
    let history = [createPendingUserTurn('turn-x', 'hello')];
    const upsertDocMeta = vi.fn(async () => {});
    const meta = {
      id: sessionId,
      machineId: 'machine-1',
      userId: 'user-1',
      createdAt: new Date().toISOString(),
      cliType: 'builtin',
      agentType: 'codex',
      status: { type: 'idle' },
    };

    const sessionDoc = {
      mirror: { subscribe: vi.fn(() => vi.fn()) },
      getMetaState: vi.fn(async () => meta),
      getHistory: vi.fn(async () => history),
      updateHistory: vi.fn(
        async (updateFn: (items: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          history = updateFn(history);
        }
      ),
      setStatus: vi.fn(async () => {}),
      waitForRemoteSync: vi.fn(async () => {}),
    };

    const workspaceDocument = {
      repo: {
        getMeta: () => ({
          scan: vi.fn(async () => [{ key: ['e', roomId], value: true }]),
        }),
        getDocMeta: vi.fn(async () => ({ meta })),
        upsertDocMeta,
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
      },
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      onMetaRoomSynced: vi.fn(() => vi.fn()),
    } as unknown as LoroDocumentManager;

    const watcher = createWatcher({
      logger: createSilentLogger(),
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      ...(opts.currentUserId ? { currentUserId: opts.currentUserId } : {}),
      workspaceDocument,
      executionService: {
        getExecutionSnapshot: vi.fn(() => ({
          hasActiveTurn: false,
          hasBlockingPendingCreate: false,
          hasReusableSession: false,
        })),
        continueSession,
        startSession,
        cancelSession,
      } as unknown as SessionExecutionService,
      ...(opts.accessPolicy ? { accessPolicy: opts.accessPolicy } : {}),
      ...(opts.recordOwnerAccessSnapshot
        ? { recordOwnerAccessSnapshot: opts.recordOwnerAccessSnapshot }
        : {}),
      canUseMachine: opts.canUseMachine,
      recordChatFailure: opts.recordChatFailure,
      onFatalAuthFailure: opts.onFatalAuthFailure,
    });

    return {
      watcher,
      sessionId,
      roomId,
      startSession,
      continueSession,
      upsertDocMeta,
      getHistory: () => history,
    };
  };

  // NOTE: backoff/cap/escalation/timeout timing is covered deterministically by
  // the TestClock unit tests in session-access-retry.test.ts. These watcher tests
  // only verify the wiring: indeterminate forks a fiber (and doesn't drop the
  // turn), and the fiber's outcome routes back to dispatch or a visible failure.
  // The fiber's FIRST verify attempt is immediate (no backoff), so recover/deny
  // flows complete without waiting on timers.

  it('does not fail or retire a pending turn when access verification is indeterminate', async () => {
    const canUseMachine = vi.fn(async () => ({
      outcome: 'indeterminate' as const,
      cause: 'network' as const,
      error: 'fetch failed',
    }));
    const h = createAccessHarness({ canUseMachine });

    await runMaybeHandleSession(h.watcher, h.sessionId);

    // The user's message must NOT be dispatched, NOR dropped.
    expect(h.startSession).not.toHaveBeenCalled();
    expect(h.continueSession).not.toHaveBeenCalled();
    // Turn stays `pending` → still dispatchable (the bug used to mark it `failed`).
    expect(h.getHistory()[0]).toEqual(
      expect.objectContaining({ id: 'turn-x', status: 'pending', read: false })
    );
    // Dispatch bookkeeping must NOT advance, or the turn would be retired forever.
    expect(h.upsertDocMeta).not.toHaveBeenCalledWith(
      h.roomId,
      expect.objectContaining({ lastHandledUserMsgId: 'turn-x' })
    );

    h.watcher.stop(); // interrupt the background retry fiber
  });

  it('recovers and dispatches once access verification becomes available', async () => {
    let calls = 0;
    const canUseMachine = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? { outcome: 'indeterminate' as const, cause: 'network' as const, error: 'fetch failed' }
        : { outcome: 'allowed' as const };
    });
    const h = createAccessHarness({ canUseMachine });

    // Inline verify #1 → indeterminate → forks a retry fiber whose first
    // (immediate) attempt verifies allowed → re-enqueues → inline path dispatches.
    await runMaybeHandleSession(h.watcher, h.sessionId);
    await vi.waitFor(() => expect(h.startSession).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    expect(h.continueSession).not.toHaveBeenCalled();

    h.watcher.stop();
  });

  it('dispatches owner-cached turns without blocking on remote access', async () => {
    const canUseMachine = vi.fn(async () => ({
      outcome: 'indeterminate' as const,
      cause: 'network' as const,
      error: 'fetch failed',
    }));
    const accessPolicy = {
      decide: vi.fn(() => Effect.succeed({ outcome: 'allow' as const, source: 'owner-cached' })),
    };
    const h = createAccessHarness({
      canUseMachine,
      accessPolicy,
      currentUserId: 'user-1',
    });

    await runMaybeHandleSession(h.watcher, h.sessionId);

    expect(h.startSession).toHaveBeenCalledTimes(1);
    expect(h.continueSession).not.toHaveBeenCalled();
    // Dispatch itself must not wait on the remote check, but a background
    // re-verification fires so online revocations still refresh the snapshot.
    await vi.waitFor(() => expect(canUseMachine).toHaveBeenCalledTimes(1));

    h.watcher.stop();
  });

  it('re-verifies an owner-cached dispatch against the real backend and clears the snapshot on deny (F1)', async () => {
    // The dispatch-path call hits the owner fast-path (structural allow); the
    // background recheck must set `forceBackendVerification` so the REAL
    // backend verdict is observed — here a definitive deny, which must clear
    // the optimistic-allow snapshot (D11) without failing the dispatched turn.
    const canUseMachine = vi.fn(async (args: { forceBackendVerification?: boolean }) =>
      args.forceBackendVerification
        ? { outcome: 'denied' as const, reason: 'not_visible' as const }
        : { outcome: 'allowed' as const }
    );
    const recordOwnerAccessSnapshot = vi.fn(async () => {});
    const accessPolicy = {
      decide: vi.fn(() => Effect.succeed({ outcome: 'allow' as const, source: 'owner-cached' })),
    };
    const h = createAccessHarness({
      canUseMachine,
      accessPolicy,
      currentUserId: 'user-1',
      recordOwnerAccessSnapshot,
    });

    await runMaybeHandleSession(h.watcher, h.sessionId);

    // The owner-cached dispatch itself is never blocked by the recheck.
    expect(h.startSession).toHaveBeenCalledTimes(1);
    // The injected backend IS consulted (owner fast-path bypassed)...
    await vi.waitFor(() =>
      expect(canUseMachine).toHaveBeenCalledWith(
        expect.objectContaining({ forceBackendVerification: true })
      )
    );
    // ...and its definitive deny clears the cached allow.
    await vi.waitFor(() => expect(recordOwnerAccessSnapshot).toHaveBeenCalledWith('denied'));
    expect(recordOwnerAccessSnapshot).not.toHaveBeenCalledWith('allowed');

    h.watcher.stop();
  });

  it('does not touch the snapshot when the owner recheck is indeterminate (offline)', async () => {
    // Snapshot write discipline: only confirmed online verdicts may change the
    // snapshot. Offline (indeterminate) rechecks must write nothing — the
    // cached allow stays valid until a real backend verdict replaces it.
    const canUseMachine = vi.fn(async () => ({
      outcome: 'indeterminate' as const,
      cause: 'network' as const,
      error: 'fetch failed',
    }));
    const recordOwnerAccessSnapshot = vi.fn(async () => {});
    const accessPolicy = {
      decide: vi.fn(() => Effect.succeed({ outcome: 'allow' as const, source: 'owner-cached' })),
    };
    const h = createAccessHarness({
      canUseMachine,
      accessPolicy,
      currentUserId: 'user-1',
      recordOwnerAccessSnapshot,
    });

    await runMaybeHandleSession(h.watcher, h.sessionId);

    expect(h.startSession).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(canUseMachine).toHaveBeenCalledWith(
        expect.objectContaining({ forceBackendVerification: true })
      )
    );
    await flushMicrotasks();
    expect(recordOwnerAccessSnapshot).not.toHaveBeenCalled();

    h.watcher.stop();
  });

  it('seeds the snapshot from a real backend verdict after an inline owner fast-path allow', async () => {
    // First-ever dispatch: no snapshot yet, so the policy falls through to the
    // inline check (owner fast-path allow). The background recheck must still
    // consult the real backend and record the confirmed allow so future
    // dispatches can use the owner-cached policy path.
    const canUseMachine = vi.fn(async () => ({ outcome: 'allowed' as const }));
    const recordOwnerAccessSnapshot = vi.fn(async () => {});
    const accessPolicy = {
      decide: vi.fn(() => Effect.succeed({ outcome: 'remote' as const })),
    };
    const h = createAccessHarness({
      canUseMachine,
      accessPolicy,
      currentUserId: 'user-1',
      recordOwnerAccessSnapshot,
    });

    await runMaybeHandleSession(h.watcher, h.sessionId);

    expect(h.startSession).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(canUseMachine).toHaveBeenCalledWith(
        expect.objectContaining({ forceBackendVerification: true })
      )
    );
    await vi.waitFor(() => expect(recordOwnerAccessSnapshot).toHaveBeenCalledWith('allowed'));

    h.watcher.stop();
  });

  it('fails the turn visibly when the background retry reaches a definitive denial', async () => {
    let calls = 0;
    const canUseMachine = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? { outcome: 'indeterminate' as const, cause: 'network' as const, error: 'fetch failed' }
        : { outcome: 'denied' as const, reason: 'not_visible' as const };
    });
    const recordChatFailure = vi.fn(async () => {});
    const h = createAccessHarness({ canUseMachine, recordChatFailure });

    await runMaybeHandleSession(h.watcher, h.sessionId);
    await vi.waitFor(
      () =>
        expect(h.getHistory()[0]).toEqual(
          expect.objectContaining({ id: 'turn-x', status: 'failed', read: true })
        ),
      { timeout: 3_000 }
    );
    expect(h.startSession).not.toHaveBeenCalled();
    expect(recordChatFailure).toHaveBeenCalledWith(
      expect.anything(),
      'machine_access_denied',
      expect.any(String)
    );

    h.watcher.stop();
  });

  it('hydrates queued mq items into pending turns before dispatching', async () => {
    const continueSession = vi.fn(async () => {});
    const startSession = vi.fn(async () => {});
    const cancelSession = vi.fn(async () => ({ success: true }));
    const sessionId = 'session-mq-1' as SessionId;
    const roomId = `session-${sessionId}`;
    let history: SessionHistoryInput[] = [];
    let promotedPointer: string | undefined;
    const queue = [
      {
        $cid: 'mq-1',
        task: 'queued hello',
        userId: 'user-1',
        timestamp: new Date().toISOString(),
        project: undefined,
        acpSessionConfig: {
          prompt: 'queued hello',
          inputBlocks: [{ type: 'text', text: 'queued hello' }],
          cliType: 'builtin',
          agentType: 'codex',
          agentRoleId: 'role-reviewer',
          agentRoleRevision: 7,
        },
      },
    ];

    const sessionDoc = {
      mirror: {
        subscribe: vi.fn(() => vi.fn()),
      },
      getMetaState: vi.fn(async () => ({
        id: sessionId,
        machineId: 'machine-1',
        userId: 'user-1',
        createdAt: new Date().toISOString(),
        cliType: 'builtin',
        agentType: 'codex',
        status: { type: 'idle' },
        messageQueueUpdatedAt: 1,
      })),
      getHistory: vi.fn(async () => history),
      popMessageQueue: vi.fn(async () => queue.shift() ?? null),
      appendUserTurn: vi.fn(async (entry: SessionHistoryInput) => {
        history = [...history, entry];
        promotedPointer = entry.id;
      }),
      updateHistory: vi.fn(
        async (updateFn: (items: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          history = updateFn(history);
        }
      ),
      setStatus: vi.fn(async () => {}),
      waitForRemoteSync: vi.fn(async () => {}),
    };

    const workspaceDocument = {
      repo: {
        getMeta: () => ({
          scan: vi.fn(async () => [{ key: ['e', roomId], value: true }]),
        }),
        getDocMeta: vi.fn(async () => ({
          meta: {
            id: sessionId,
            machineId: 'machine-1',
            userId: 'user-1',
            createdAt: new Date().toISOString(),
            cliType: 'builtin',
            agentType: 'codex',
            status: { type: 'idle' },
            messageQueueUpdatedAt: 1,
          },
        })),
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
      },
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      onMetaRoomSynced: vi.fn(() => vi.fn()),
    } as unknown as LoroDocumentManager;

    const watcher = createWatcher({
      logger: createSilentLogger(),
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      workspaceDocument,
      executionService: {
        getExecutionSnapshot: vi.fn(() => ({
          hasActiveTurn: false,
          hasBlockingPendingCreate: false,
          hasReusableSession: false,
        })),
        continueSession,
        startSession,
        cancelSession,
      } as unknown as SessionExecutionService,
      canUseMachine: createAllowMachineAccess(),
    });

    await watcher.start();

    await vi.waitFor(() => {
      expect(startSession).toHaveBeenCalledTimes(1);
    });
    expect(sessionDoc.popMessageQueue).toHaveBeenCalledTimes(1);
    expect(history[0]).toEqual(
      expect.objectContaining({
        id: 'queued-mq-1',
        role: 'user',
        status: 'pending',
        userId: 'user-1',
        inputConfig: expect.objectContaining({
          agentRoleId: 'role-reviewer',
          agentRoleRevision: 7,
        }),
      })
    );
    // The promoted turn is published for dispatch, not just written to history.
    expect(promotedPointer).toBe('queued-mq-1');
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session/create',
        sessionId,
        userTurnId: 'queued-mq-1',
        acpSessionConfig: expect.objectContaining({
          agentRoleId: 'role-reviewer',
          agentRoleRevision: 7,
        }),
      }),
      { dispatchSource: 'queue' }
    );
  });

  it('drops a resurrected queue item whose user turn already exists in history', async () => {
    const sessionId = 'session-mq-resurrected' as SessionId;
    const turnId = 'turn-mq-resurrected';
    const existingTurn = {
      ...createPendingUserTurn(turnId, 'queued hello'),
      status: 'handled' as const,
      read: true,
    };
    const popMessageQueue = vi.fn(async () => ({
      $cid: 'mq-resurrected',
      task: 'queued hello',
      userId: 'user-1',
      userTurnId: turnId,
      timestamp: new Date().toISOString(),
      project: undefined,
      acpSessionConfig: {
        prompt: 'queued hello',
        inputBlocks: [{ type: 'text' as const, text: 'queued hello' }],
        cliType: 'builtin' as const,
        agentType: 'codex' as const,
      },
    }));
    const updateHistory = vi.fn(async () => {});
    const watcher = createWatcher({
      logger: createSilentLogger(),
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      workspaceDocument: {} as LoroDocumentManager,
      executionService: {
        getExecutionSnapshot: vi.fn(() => ({
          hasActiveTurn: false,
          hasBlockingPendingCreate: false,
          hasReusableSession: false,
        })),
        continueSession: vi.fn(async () => {}),
        startSession: vi.fn(async () => {}),
        cancelSession: vi.fn(async () => ({ success: true })),
      } as unknown as SessionExecutionService,
      canUseMachine: createAllowMachineAccess(),
    });
    const promoteNextQueuedMessage = (
      watcher as unknown as {
        promoteNextQueuedMessage: (
          sessionDoc: {
            popMessageQueue: typeof popMessageQueue;
            updateHistory: typeof updateHistory;
          },
          meta: SessionMeta,
          history: SessionHistoryInput[]
        ) => Promise<SessionHistoryInput | null>;
      }
    ).promoteNextQueuedMessage.bind(watcher);

    const promoted = await promoteNextQueuedMessage(
      { popMessageQueue, updateHistory },
      {
        id: sessionId,
        machineId: 'machine-1',
        userId: 'user-1',
        createdAt: new Date().toISOString(),
        cliType: 'builtin',
        agentType: 'codex',
        status: { type: 'idle' },
      },
      [existingTurn]
    );

    expect(promoted).toBeNull();
    expect(popMessageQueue).toHaveBeenCalledTimes(1);
    expect(updateHistory).not.toHaveBeenCalled();
  });

  /**
   * Promotion is a dispatch producer. A queued turn that never passes through
   * `latestUserMsgId` while `lastHandledUserMsgId` advances to it leaves the two
   * pointers permanently unequal once the queue drains, which every activation
   * reader treats as a turn still waiting to be delivered.
   */
  const promoteQueuedMessage = async (
    initialMeta: SessionMeta,
    queuedTurnId: string
  ): Promise<SessionMeta> => {
    const roomId = `session-${initialMeta.id}`;
    let meta = initialMeta;
    const upsertDocMeta = vi.fn(async (_roomId: string, patch: Partial<SessionMeta>) => {
      meta = { ...meta, ...patch };
    });
    const watcher = createWatcher({
      logger: createSilentLogger(),
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      workspaceDocument: {
        repo: { upsertDocMeta },
      } as unknown as LoroDocumentManager,
      executionService: {
        getExecutionSnapshot: vi.fn(() => ({
          hasActiveTurn: false,
          hasBlockingPendingCreate: false,
          hasReusableSession: false,
        })),
        continueSession: vi.fn(async () => {}),
        startSession: vi.fn(async () => {}),
        cancelSession: vi.fn(async () => ({ success: true })),
      } as unknown as SessionExecutionService,
      canUseMachine: createAllowMachineAccess(),
    });

    // A real SessionDocument over a stub mirror, so promotion runs the real
    // `appendUserTurn` binding rather than a fake that could drift from it.
    const docState: { history: SessionHistoryInput[] } = { history: [] };
    const realDoc = new SessionDocument(
      { upsertDocMeta } as unknown as ConstructorParameters<typeof SessionDocument>[0],
      initialMeta.id,
      async () => {},
      createSilentLogger()
    );
    realDoc.roomId = roomId;
    realDoc.mirror = {
      setState: (updateFn: (prev: typeof docState) => typeof docState) => {
        updateFn(docState);
      },
    } as unknown as SessionDocument['mirror'];
    const sessionDoc = Object.assign(realDoc, {
      popMessageQueue: vi.fn(async () => ({
        $cid: 'mq-pointer',
        task: 'queued hello',
        userId: 'user-1',
        userTurnId: queuedTurnId,
        timestamp: new Date().toISOString(),
        project: undefined,
        acpSessionConfig: {
          prompt: 'queued hello',
          inputBlocks: [{ type: 'text' as const, text: 'queued hello' }],
          cliType: 'builtin' as const,
          agentType: 'codex' as const,
        },
      })),
    });

    const promoted = await (
      watcher as unknown as {
        promoteNextQueuedMessage: (
          doc: typeof sessionDoc,
          meta: SessionMeta,
          history: SessionHistoryInput[]
        ) => Promise<SessionHistoryInput | null>;
      }
    ).promoteNextQueuedMessage.bind(watcher)(sessionDoc, meta, []);

    expect(promoted?.id).toBe(queuedTurnId);
    return meta;
  };

  it('leaves no pending activation once a promoted queue turn is handled', async () => {
    // The settled state after a direct send has run: both pointers name it.
    const afterPromotion = await promoteQueuedMessage(
      {
        id: 'session-mq-pointer' as SessionId,
        machineId: 'machine-1',
        userId: 'user-1',
        createdAt: new Date().toISOString(),
        cliType: 'builtin',
        agentType: 'codex',
        status: { type: 'idle' },
        latestUserMsgId: 'direct-1',
        lastHandledUserMsgId: 'direct-1',
      },
      'queued-1'
    );

    // The promoted turn is the activation the machine now owes an answer for.
    expect(getPendingUserTurnActivationId(afterPromotion)).toBe('queued-1');

    // Ordinary execution finishing that turn writes only `lastHandledUserMsgId`.
    // Both pointers must land on the same turn, or the watcher spends
    // HISTORY_SYNC_WAIT_TIMEOUT_MS waiting for an entry that already ran and
    // then reports a bogus `message_delivery_failed`.
    const afterHandled: SessionMeta = { ...afterPromotion, lastHandledUserMsgId: 'queued-1' };
    expect(hasPendingUserTurnActivation(afterHandled)).toBe(false);
  });

  it('keeps a missing-history marker when promoting a queued turn', async () => {
    // Unlike a resend, promotion does not supersede the acknowledged entry, so
    // clearing the marker here would let its stale `pending` copy dispatch.
    const afterPromotion = await promoteQueuedMessage(
      {
        id: 'session-mq-marker' as SessionId,
        machineId: 'machine-1',
        userId: 'user-1',
        createdAt: new Date().toISOString(),
        cliType: 'builtin',
        agentType: 'codex',
        status: { type: 'idle' },
        latestUserMsgId: 'stranded-1',
        lastHandledUserMsgId: 'direct-1',
        lastMissingHistoryUserMsgId: 'stranded-1',
      },
      'queued-2'
    );

    expect(afterPromotion.latestUserMsgId).toBe('queued-2');
    expect(afterPromotion.lastMissingHistoryUserMsgId).toBe('stranded-1');
    // The stranded entry stays skipped; the promoted turn is what dispatches.
    expect(
      findNextDispatchableUserTurn(
        [
          createPendingUserTurn('stranded-1', 'never delivered'),
          createPendingUserTurn('queued-2', 'queued hello'),
        ],
        afterPromotion
      )?.id
    ).toBe('queued-2');
  });

  it('uses queue update watermarks to wake and settle idle sessions', async () => {
    const sessionId = 'session-mq-watermark' as SessionId;
    const roomId = `session-${sessionId}`;
    const upsertDocMeta = vi.fn(async () => {});
    const workspaceDocument = {
      repo: {
        upsertDocMeta,
      },
    } as unknown as LoroDocumentManager;
    const watcher = createWatcher({
      logger: createSilentLogger(),
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      workspaceDocument,
      executionService: {
        getExecutionSnapshot: vi.fn(() => ({
          hasActiveTurn: false,
          hasBlockingPendingCreate: false,
          hasReusableSession: false,
        })),
        continueSession: vi.fn(async () => {}),
        startSession: vi.fn(async () => {}),
        cancelSession: vi.fn(async () => ({ success: true })),
      } as unknown as SessionExecutionService,
      canUseMachine: createAllowMachineAccess(),
    });
    const privateWatcher = watcher as unknown as {
      sessionNeedsActiveWatch: (meta: SessionMeta) => boolean;
      markMessageQueueSignalChecked: (
        sessionDoc: { roomId: string },
        meta: SessionMeta
      ) => Promise<void>;
    };
    const meta = {
      id: sessionId,
      machineId: 'machine-1',
      userId: 'user-1',
      createdAt: new Date().toISOString(),
      cliType: 'builtin',
      agentType: 'codex',
      status: { type: 'idle' },
      lastHandledUserMsgId: 'turn-handled',
      messageQueueUpdatedAt: 20,
      messageQueueCheckedAt: 10,
    } satisfies SessionMeta;

    expect(privateWatcher.sessionNeedsActiveWatch(meta)).toBe(true);

    await privateWatcher.markMessageQueueSignalChecked({ roomId }, meta);

    expect(upsertDocMeta).toHaveBeenCalledWith(roomId, {
      messageQueueCheckedAt: 20,
    });
  });

  it('reacts to lastCanceledTurn metadata for an owned session', async () => {
    const continueSession = vi.fn(async () => {});
    const startSession = vi.fn(async () => {});
    const cancelSession = vi.fn(async () => ({ success: true }));
    const sessionId = 'session-2' as SessionId;
    const roomId = `session-${sessionId}`;
    const sessionDoc = {
      mirror: {
        subscribe: vi.fn(() => vi.fn()),
      },
      getMetaState: vi.fn(async () => ({
        id: sessionId,
        machineId: 'machine-1',
        userId: 'user-1',
        createdAt: new Date().toISOString(),
        cliType: 'builtin',
        agentType: 'codex',
        status: { type: 'idle' },
        lastCanceledTurn: 'assistant-turn-2',
      })),
      getHistory: vi.fn(async () => []),
      setStatus: vi.fn(async () => {}),
      waitForRemoteSync: vi.fn(async () => {}),
    };

    const workspaceDocument = {
      repo: {
        getMeta: () => ({
          scan: vi.fn(async () => [{ key: ['e', roomId], value: true }]),
        }),
        getDocMeta: vi.fn(async () => ({
          meta: {
            id: sessionId,
            machineId: 'machine-1',
            userId: 'user-1',
            createdAt: new Date().toISOString(),
            cliType: 'builtin',
            agentType: 'codex',
            status: { type: 'idle' },
            lastCanceledTurn: 'assistant-turn-2',
          },
        })),
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
      },
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      onMetaRoomSynced: vi.fn(() => vi.fn()),
    } as unknown as LoroDocumentManager;

    const watcher = createWatcher({
      logger: createSilentLogger(),
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      workspaceDocument,
      executionService: {
        getExecutionSnapshot: vi.fn(() => ({
          hasActiveTurn: false,
          hasBlockingPendingCreate: false,
          hasReusableSession: false,
        })),
        continueSession,
        startSession,
        cancelSession,
      } as unknown as SessionExecutionService,
      canUseMachine: createAllowMachineAccess(),
    });

    await watcher.start();

    await vi.waitFor(() => {
      expect(cancelSession).toHaveBeenCalledTimes(1);
    });
    expect(cancelSession).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session/cancel',
        sessionId,
        turnId: 'assistant-turn-2',
      })
    );
  });

  it('handles cancel metadata without waiting for an in-flight dispatch to finish', async () => {
    let resolveContinue: (() => void) | undefined;
    const continueSession = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          resolveContinue = resolve;
        })
    );
    const startSession = vi.fn(async () => {});
    const cancelSession = vi.fn(async () => ({ success: true }));
    const sessionId = 'session-2b' as SessionId;
    const roomId = `session-${sessionId}`;
    let meta = {
      id: sessionId,
      machineId: 'machine-1',
      userId: 'user-1',
      createdAt: new Date().toISOString(),
      cliType: 'builtin',
      agentType: 'codex',
      status: { type: 'idle' as const },
      acpSessionId: 'acp-session-2b',
      latestUserMsgId: 'turn-2b',
    } as SessionMeta;
    let metadataCallback: ((event: { kind: 'doc-metadata'; docId: string }) => void) | undefined;

    const sessionDoc = {
      mirror: {
        subscribe: vi.fn(() => vi.fn()),
      },
      getMetaState: vi.fn(async () => meta),
      getHistory: vi.fn(async () => [createPendingUserTurn('turn-2b', 'hello again')]),
      setStatus: vi.fn(async () => {}),
      waitForRemoteSync: vi.fn(async () => {}),
    };

    const workspaceDocument = {
      repo: {
        getMeta: () => ({
          scan: vi.fn(async () => [{ key: ['e', roomId], value: true }]),
        }),
        getDocMeta: vi.fn(async () => ({ meta })),
        watch: vi.fn((callback: (event: { kind: 'doc-metadata'; docId: string }) => void) => {
          metadataCallback = callback as (event: { kind: 'doc-metadata'; docId: string }) => void;
          return { unsubscribe: vi.fn() };
        }),
      },
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      onMetaRoomSynced: vi.fn(() => vi.fn()),
    } as unknown as LoroDocumentManager;

    const watcher = createWatcher({
      logger: createSilentLogger(),
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      workspaceDocument,
      executionService: {
        getExecutionSnapshot: vi.fn(() => ({
          hasActiveTurn: false,
          hasBlockingPendingCreate: false,
          hasReusableSession: false,
        })),
        continueSession,
        startSession,
        cancelSession,
      } as unknown as SessionExecutionService,
      canUseMachine: createAllowMachineAccess(),
    });

    await watcher.start();

    await vi.waitFor(() => {
      expect(continueSession).toHaveBeenCalledTimes(1);
    });

    meta = {
      ...meta,
      status: { type: 'running' },
      lastCanceledTurn: 'assistant-turn-2b',
    };
    metadataCallback?.({ kind: 'doc-metadata', docId: roomId });

    await vi.waitFor(() => {
      expect(cancelSession).toHaveBeenCalledTimes(1);
    });
    expect(cancelSession).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session/cancel',
        sessionId,
        turnId: 'assistant-turn-2b',
      })
    );

    resolveContinue?.();
  });

  it('bootstraps owned sessions concurrently while isolating failed reconciles', async () => {
    const continueSession = vi.fn(async () => {});
    const startSession = vi.fn(async () => {});
    const cancelSession = vi.fn(async () => ({ success: true }));
    const badSessionId = 'bootstrap-bad' as SessionId;
    const fastSessionId = 'bootstrap-fast' as SessionId;
    const badRoomId = `session-${badSessionId}`;
    const fastRoomId = `session-${fastSessionId}`;
    const turnId = 'turn-bootstrap-fast';
    let releaseBadDocMeta: (() => void) | undefined;
    const badDocMetaBlocked = new Promise<void>((resolve) => {
      releaseBadDocMeta = resolve;
    });
    const fastMeta = {
      id: fastSessionId,
      machineId: 'machine-1',
      userId: 'user-1',
      createdAt: new Date().toISOString(),
      cliType: 'builtin',
      agentType: 'codex',
      status: { type: 'idle' },
      latestUserMsgId: turnId,
    } satisfies SessionMeta;
    const fastSessionDoc = {
      mirror: {
        subscribe: vi.fn(() => vi.fn()),
      },
      getMetaState: vi.fn(async () => fastMeta),
      getHistory: vi.fn(async () => [createPendingUserTurn(turnId, 'hello')]),
      setStatus: vi.fn(async () => {}),
      waitForRemoteSync: vi.fn(async () => {}),
    };
    const scan = vi.fn(async () => [
      { key: ['e', badRoomId], value: true },
      { key: ['e', fastRoomId], value: true },
    ]);
    const getDocMeta = vi.fn(async (roomId: string) => {
      if (roomId === badRoomId) {
        await badDocMetaBlocked;
        throw new Error('bad session doc');
      }
      if (roomId === fastRoomId) {
        return { meta: fastMeta };
      }
      return undefined;
    });
    const workspaceDocument = {
      repo: {
        getMeta: () => ({ scan }),
        getDocMeta,
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
      },
      getOrCreateSessionDoc: vi.fn(async () => fastSessionDoc),
      onMetaRoomSynced: vi.fn(() => vi.fn()),
    } as unknown as LoroDocumentManager;
    const logger = {
      ...createSilentLogger(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const onStartupBootstrapComplete = vi.fn();
    const watcher = createWatcher({
      logger,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      workspaceDocument,
      executionService: {
        getExecutionSnapshot: vi.fn(() => ({
          hasActiveTurn: false,
          hasBlockingPendingCreate: false,
          hasReusableSession: false,
        })),
        continueSession,
        startSession,
        cancelSession,
      } as unknown as SessionExecutionService,
      canUseMachine: createAllowMachineAccess(),
      onStartupBootstrapComplete,
    });

    await watcher.start();

    await vi.waitFor(() => {
      expect(startSession).toHaveBeenCalledTimes(1);
    });
    expect(getDocMeta).toHaveBeenCalledWith(badRoomId);
    expect(getDocMeta).toHaveBeenCalledWith(fastRoomId);
    expect(onStartupBootstrapComplete).not.toHaveBeenCalled();

    releaseBadDocMeta?.();

    await vi.waitFor(() => {
      expect(onStartupBootstrapComplete).toHaveBeenCalledTimes(1);
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Owned-session bootstrap completed with 1/2 session reconcile failure(s)'
      )
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        `Failed to reconcile session watch (sessionId=${badSessionId}, roomId=${badRoomId}`
      )
    );
    expect(scan).toHaveBeenCalledWith({ prefix: ['e'], includeRaw: false });

    watcher.stop();
  });

  it('reserves one global reconciliation slot for live metadata during bootstrap', async () => {
    vi.useFakeTimers();
    try {
      const roomIds = Array.from({ length: 12 }, (_, index) => `session-bootstrap-${index}`);
      const releaseReads = createDeferred();
      const firstBatchStarted = createDeferred();
      const bootstrapCompleted = createDeferred();
      let activeReads = 0;
      let maxActiveReads = 0;
      let readCount = 0;
      const getDocMeta = vi.fn(async () => {
        readCount += 1;
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        if (readCount === 3) {
          firstBatchStarted.resolve();
        }
        await releaseReads.promise;
        activeReads -= 1;
        return undefined;
      });
      const workspaceDocument = {
        repo: {
          getMeta: () => ({
            scan: vi.fn(async () =>
              roomIds.map((roomId) => ({
                key: ['e', roomId],
                value: true,
              }))
            ),
          }),
          getDocMeta,
          watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
        },
        getOrCreateSessionDoc: vi.fn(),
        onMetaRoomSynced: vi.fn(() => vi.fn()),
      } as unknown as LoroDocumentManager;
      const watcher = createWatcher({
        logger: createSilentLogger(),
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        workspaceDocument,
        executionService: {
          getExecutionSnapshot: vi.fn(() => ({
            hasActiveTurn: false,
            hasBlockingPendingCreate: false,
            hasReusableSession: false,
          })),
          continueSession: vi.fn(async () => {}),
          startSession: vi.fn(async () => {}),
          cancelSession: vi.fn(async () => ({ success: true })),
        } as unknown as SessionExecutionService,
        canUseMachine: createAllowMachineAccess(),
        onStartupBootstrapComplete: bootstrapCompleted.resolve,
      });

      await watcher.start();
      await vi.advanceTimersByTimeAsync(0);
      await firstBatchStarted.promise;

      expect({ readCount, maxActiveReads }).toEqual({
        readCount: 3,
        maxActiveReads: 3,
      });

      releaseReads.resolve();
      await bootstrapCompleted.promise;
      expect(readCount).toBe(12);
      expect(maxActiveReads).toBe(3);
      watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares one four-session initial-probe limit across bootstrap and metadata', async () => {
    vi.useFakeTimers();
    try {
      const bootstrapIds = Array.from(
        { length: 6 },
        (_, index) => `bootstrap-global-${index}` as SessionId
      );
      const liveSessionId = 'metadata-global-live' as SessionId;
      const allSessionIds = [...bootstrapIds, liveSessionId];
      const releaseHistory = createDeferred();
      const bootstrapThreeStarted = createDeferred();
      const liveStarted = createDeferred();
      let metadataCallback: ((event: { kind: 'doc-metadata'; docId: string }) => void) | undefined;
      let activeHistoryReads = 0;
      let maxActiveHistoryReads = 0;
      let bootstrapHistoryReads = 0;
      const metaBySession = new Map(
        allSessionIds.map((sessionId) => [
          sessionId,
          {
            id: sessionId,
            machineId: 'machine-1',
            userId: 'user-1',
            createdAt: new Date(0).toISOString(),
            cliType: 'builtin' as const,
            agentType: 'codex' as const,
            status: { type: 'idle' as const },
            latestUserMsgId: `turn-${sessionId}`,
          } satisfies SessionMeta,
        ])
      );
      const getOrCreateSessionDoc = vi.fn(async (sessionId: SessionId) => {
        const meta = metaBySession.get(sessionId)!;
        return {
          mirror: { subscribe: vi.fn(() => vi.fn()) },
          getMetaState: vi.fn(async () => meta),
          getHistory: vi.fn(async () => {
            activeHistoryReads += 1;
            maxActiveHistoryReads = Math.max(maxActiveHistoryReads, activeHistoryReads);
            if (sessionId === liveSessionId) {
              liveStarted.resolve();
            } else {
              bootstrapHistoryReads += 1;
              if (bootstrapHistoryReads === 3) bootstrapThreeStarted.resolve();
            }
            await releaseHistory.promise;
            activeHistoryReads -= 1;
            return [createPendingUserTurn(`turn-${sessionId}`, 'hello')];
          }),
          updateHistory: vi.fn(async () => {}),
          setStatus: vi.fn(async () => {}),
        };
      });
      const workspaceDocument = {
        repo: {
          getMeta: () => ({
            scan: vi.fn(async () =>
              bootstrapIds.map((sessionId) => ({
                key: ['e', `session-${sessionId}`],
                value: true,
              }))
            ),
          }),
          getDocMeta: vi.fn(async (roomId: string) => ({
            meta: metaBySession.get(roomId.slice('session-'.length) as SessionId),
          })),
          watch: vi.fn((callback: typeof metadataCallback) => {
            metadataCallback = callback;
            return { unsubscribe: vi.fn() };
          }),
        },
        getOrCreateSessionDoc,
        onMetaRoomSynced: vi.fn(() => vi.fn()),
      } as unknown as LoroDocumentManager;
      const watcher = createWatcher({
        logger: createSilentLogger(),
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        workspaceDocument,
        executionService: {
          getExecutionSnapshot: vi.fn(() => ({
            hasActiveTurn: false,
            hasBlockingPendingCreate: false,
            hasReusableSession: false,
          })),
          continueSession: vi.fn(async () => {}),
          startSession: vi.fn(async () => {}),
          cancelSession: vi.fn(async () => ({ success: true })),
        } as unknown as SessionExecutionService,
        canUseMachine: createAllowMachineAccess(),
      });

      await watcher.start();
      await vi.advanceTimersByTimeAsync(0);
      await bootstrapThreeStarted.promise;
      expect(activeHistoryReads).toBe(3);

      metadataCallback?.({ kind: 'doc-metadata', docId: `session-${liveSessionId}` });
      await liveStarted.promise;
      expect(activeHistoryReads).toBe(4);
      expect(maxActiveHistoryReads).toBe(4);

      watcher.stop();
      releaseHistory.resolve();
      await flushMicrotasks(30);
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces and bounds live metadata reconciliation bursts', async () => {
    vi.useFakeTimers();
    try {
      const sessionIds = Array.from(
        { length: 12 },
        (_, index) => `metadata-burst-${index}` as SessionId
      );
      const releaseHistory = createDeferred();
      const firstBatchStarted = createDeferred();
      const allHistoryStarted = createDeferred();
      let metadataCallback: ((event: { kind: 'doc-metadata'; docId: string }) => void) | undefined;
      let activeHistoryReads = 0;
      let maxActiveHistoryReads = 0;
      let historyReadCount = 0;
      const metaBySession = new Map(
        sessionIds.map((sessionId) => [
          sessionId,
          {
            id: sessionId,
            machineId: 'machine-1',
            userId: 'user-1',
            createdAt: new Date().toISOString(),
            cliType: 'builtin' as const,
            agentType: 'codex' as const,
            status: { type: 'idle' as const },
            latestUserMsgId: `turn-${sessionId}`,
          } satisfies SessionMeta,
        ])
      );
      const getDocMeta = vi.fn(async (roomId: string) => ({
        meta: metaBySession.get(roomId.slice('session-'.length) as SessionId),
      }));
      const getOrCreateSessionDoc = vi.fn(async (sessionId: SessionId) => {
        const meta = metaBySession.get(sessionId)!;
        return {
          mirror: { subscribe: vi.fn(() => vi.fn()) },
          getMetaState: vi.fn(async () => meta),
          getHistory: vi.fn(async () => {
            historyReadCount += 1;
            activeHistoryReads += 1;
            maxActiveHistoryReads = Math.max(maxActiveHistoryReads, activeHistoryReads);
            if (historyReadCount === 4) firstBatchStarted.resolve();
            if (historyReadCount === sessionIds.length) allHistoryStarted.resolve();
            await releaseHistory.promise;
            activeHistoryReads -= 1;
            return [createPendingUserTurn(`turn-${sessionId}`, 'hello')];
          }),
          updateHistory: vi.fn(async () => {}),
          setStatus: vi.fn(async () => {}),
        };
      });
      const workspaceDocument = {
        repo: {
          getMeta: () => ({ scan: vi.fn(async () => []) }),
          getDocMeta,
          watch: vi.fn((callback: typeof metadataCallback) => {
            metadataCallback = callback;
            return { unsubscribe: vi.fn() };
          }),
        },
        getOrCreateSessionDoc,
        onMetaRoomSynced: vi.fn(() => vi.fn()),
      } as unknown as LoroDocumentManager;
      const watcher = createWatcher({
        logger: createSilentLogger(),
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        workspaceDocument,
        executionService: {
          getExecutionSnapshot: vi.fn(() => ({
            hasActiveTurn: false,
            hasBlockingPendingCreate: false,
            hasReusableSession: false,
          })),
          continueSession: vi.fn(async () => {}),
          startSession: vi.fn(async () => {}),
          cancelSession: vi.fn(async () => ({ success: true })),
        } as unknown as SessionExecutionService,
        canUseMachine: createAllowMachineAccess(),
      });

      await watcher.start();
      for (const sessionId of sessionIds) {
        metadataCallback?.({ kind: 'doc-metadata', docId: `session-${sessionId}` });
      }
      for (const sessionId of sessionIds.slice(0, 5)) {
        metadataCallback?.({ kind: 'doc-metadata', docId: `session-${sessionId}` });
      }
      await firstBatchStarted.promise;

      expect({ historyReadCount, maxActiveHistoryReads }).toEqual({
        historyReadCount: 4,
        maxActiveHistoryReads: 4,
      });

      releaseHistory.resolve();
      await allHistoryStarted.promise;
      await flushMicrotasks(20);
      expect(historyReadCount).toBe(sessionIds.length);
      expect(maxActiveHistoryReads).toBe(4);
      watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('generation-fences default-enqueued checks across stop and restart', async () => {
    vi.useFakeTimers();
    try {
      const sessionId = 'stale-lifecycle-check' as SessionId;
      const turnId = 'turn-stale-lifecycle';
      const historyStarted = createDeferred();
      const releaseHistory = createDeferred();
      const meta = {
        id: sessionId,
        machineId: 'machine-1',
        userId: 'user-1',
        createdAt: new Date(0).toISOString(),
        cliType: 'builtin' as const,
        agentType: 'codex' as const,
        status: { type: 'idle' as const },
        latestUserMsgId: turnId,
      } satisfies SessionMeta;
      const mirrorSubscribe = vi.fn(() => vi.fn());
      const statusSubscribe = vi.fn(() => vi.fn());
      const rejoinDocRoom = vi.fn(async () => {});
      const ensureDocRoomJoined = vi.fn(async () => {});
      const sessionDoc = {
        mirror: { subscribe: mirrorSubscribe },
        getMetaState: vi.fn(async () => meta),
        getHistory: vi.fn(async () => {
          historyStarted.resolve();
          await releaseHistory.promise;
          return [];
        }),
        onDocRoomStatusChange: statusSubscribe,
        getDocRoomStatus: vi.fn(() => undefined),
        rejoinDocRoom,
        ensureDocRoomJoined,
        waitUntilSynced: vi.fn(async () => {}),
        updateHistory: vi.fn(async () => {}),
        setStatus: vi.fn(async () => {}),
      };
      const workspaceDocument = {
        repo: {
          getMeta: () => ({ scan: vi.fn(async () => []) }),
          getDocMeta: vi.fn(async () => ({ meta })),
          watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        onMetaRoomSynced: vi.fn(() => vi.fn()),
      } as unknown as LoroDocumentManager;
      const dispatchPreparedSessionTurn = vi.fn(async () => {});
      const watcher = createWatcher({
        logger: createSilentLogger(),
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        workspaceDocument,
        executionService: {
          getExecutionSnapshot: vi.fn(() => ({
            hasActiveTurn: false,
            hasBlockingPendingCreate: false,
            hasReusableSession: false,
          })),
          dispatchPreparedSessionTurn,
          cancelSession: vi.fn(async () => ({ success: true })),
        } as unknown as SessionExecutionService,
        canUseMachine: createAllowMachineAccess(),
      });

      await watcher.start();
      void watcher.enqueueSessionCheck(sessionId);
      await historyStarted.promise;

      watcher.stop();
      await watcher.start();
      releaseHistory.resolve();
      await flushMicrotasks(30);

      expect(dispatchPreparedSessionTurn).not.toHaveBeenCalled();
      expect(mirrorSubscribe).not.toHaveBeenCalled();
      expect(statusSubscribe).not.toHaveBeenCalled();
      expect(rejoinDocRoom).not.toHaveBeenCalled();
      expect(ensureDocRoomJoined).not.toHaveBeenCalled();
      watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('unsubscribes an established history wait immediately on stop', async () => {
    vi.useFakeTimers();
    try {
      const sessionId = 'cancel-history-wait' as SessionId;
      const turnId = 'turn-cancel-history-wait';
      const meta = {
        id: sessionId,
        machineId: 'machine-1',
        userId: 'user-1',
        createdAt: new Date(0).toISOString(),
        cliType: 'builtin' as const,
        agentType: 'codex' as const,
        status: { type: 'idle' as const },
        latestUserMsgId: turnId,
      } satisfies SessionMeta;
      const unsubscribeMirror = vi.fn();
      const unsubscribeStatus = vi.fn();
      const mirrorSubscribe = vi.fn(() => unsubscribeMirror);
      const statusSubscribe = vi.fn(() => unsubscribeStatus);
      const sessionDoc = {
        mirror: { subscribe: mirrorSubscribe },
        getMetaState: vi.fn(async () => meta),
        getHistory: vi.fn(async () => []),
        onDocRoomStatusChange: statusSubscribe,
        getDocRoomStatus: vi.fn(() => 'connected' as const),
        rejoinDocRoom: vi.fn(async () => {}),
        ensureDocRoomJoined: vi.fn(async () => {}),
        waitUntilSynced: vi.fn(() => new Promise<void>(() => {})),
        updateHistory: vi.fn(async () => {}),
        setStatus: vi.fn(async () => {}),
      };
      const workspaceDocument = {
        repo: {
          getMeta: () => ({ scan: vi.fn(async () => []) }),
          getDocMeta: vi.fn(async () => ({ meta })),
          watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        onMetaRoomSynced: vi.fn(() => vi.fn()),
      } as unknown as LoroDocumentManager;
      const watcher = createWatcher({
        logger: createSilentLogger(),
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        workspaceDocument,
        executionService: {
          getExecutionSnapshot: vi.fn(() => ({
            hasActiveTurn: false,
            hasBlockingPendingCreate: false,
            hasReusableSession: false,
          })),
          dispatchPreparedSessionTurn: vi.fn(async () => {}),
          cancelSession: vi.fn(async () => ({ success: true })),
        } as unknown as SessionExecutionService,
        canUseMachine: createAllowMachineAccess(),
      });

      await watcher.start();
      const check = watcher.enqueueSessionCheck(sessionId);
      await vi.waitFor(() => {
        expect(mirrorSubscribe).toHaveBeenCalledTimes(1);
        expect(statusSubscribe).toHaveBeenCalledTimes(1);
      });

      watcher.stop();
      await expect(check).resolves.toBeUndefined();
      expect(unsubscribeMirror).toHaveBeenCalledTimes(1);
      expect(unsubscribeStatus).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('installs one session subscription when bootstrap and metadata reconciliation race', async () => {
    vi.useFakeTimers();
    try {
      const sessionId = 'reconcile-race' as SessionId;
      const roomId = `session-${sessionId}`;
      const turnId = 'turn-reconcile-race';
      const meta = {
        id: sessionId,
        machineId: 'machine-1',
        userId: 'user-1',
        createdAt: new Date().toISOString(),
        cliType: 'builtin' as const,
        agentType: 'codex' as const,
        status: { type: 'idle' as const },
        latestUserMsgId: turnId,
      } satisfies SessionMeta;
      const releaseOpen = createDeferred();
      const bothOpensStarted = createDeferred();
      const unsubscribe = vi.fn();
      const subscribe = vi.fn(() => unsubscribe);
      const sessionDoc = {
        mirror: { subscribe },
        getMetaState: vi.fn(async () => meta),
        getHistory: vi.fn(async () => [createPendingUserTurn(turnId, 'hello')]),
        updateHistory: vi.fn(async () => {}),
        setStatus: vi.fn(async () => {}),
      };
      let openCount = 0;
      const getOrCreateSessionDoc = vi.fn(async () => {
        openCount += 1;
        if (openCount === 2) bothOpensStarted.resolve();
        await releaseOpen.promise;
        return sessionDoc;
      });
      let metadataCallback: ((event: { kind: 'doc-metadata'; docId: string }) => void) | undefined;
      const workspaceDocument = {
        repo: {
          getMeta: () => ({
            scan: vi.fn(async () => [{ key: ['e', roomId], value: true }]),
          }),
          getDocMeta: vi.fn(async () => ({ meta })),
          watch: vi.fn((callback: typeof metadataCallback) => {
            metadataCallback = callback;
            return { unsubscribe: vi.fn() };
          }),
        },
        getOrCreateSessionDoc,
        onMetaRoomSynced: vi.fn(() => vi.fn()),
      } as unknown as LoroDocumentManager;
      const watcher = createWatcher({
        logger: createSilentLogger(),
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        workspaceDocument,
        executionService: {
          getExecutionSnapshot: vi.fn(() => ({
            hasActiveTurn: false,
            hasBlockingPendingCreate: false,
            hasReusableSession: false,
          })),
          continueSession: vi.fn(async () => {}),
          startSession: vi.fn(async () => {}),
          cancelSession: vi.fn(async () => ({ success: true })),
        } as unknown as SessionExecutionService,
        canUseMachine: createAllowMachineAccess(),
      });

      await watcher.start();
      metadataCallback?.({ kind: 'doc-metadata', docId: roomId });
      await vi.advanceTimersByTimeAsync(0);
      await bothOpensStarted.promise;
      releaseOpen.resolve();
      await flushMicrotasks(30);

      expect(subscribe).toHaveBeenCalledTimes(1);
      watcher.stop();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a large idle workspace metadata-only during bootstrap', async () => {
    vi.useFakeTimers();
    try {
      const roomIds = Array.from({ length: 1_000 }, (_, index) => `session-idle-${index}`);
      const bootstrapCompleted = createDeferred();
      const getDocMeta = vi.fn(async (roomId: string) => ({
        meta: {
          id: roomId.slice('session-'.length) as SessionId,
          machineId: 'machine-1',
          userId: 'user-1',
          createdAt: new Date().toISOString(),
          cliType: 'builtin',
          agentType: 'codex',
          status: { type: 'idle' as const },
        } satisfies SessionMeta,
      }));
      const getOrCreateSessionDoc = vi.fn();
      const workspaceDocument = {
        repo: {
          getMeta: () => ({
            scan: vi.fn(async () => roomIds.map((roomId) => ({ key: ['e', roomId], value: true }))),
          }),
          getDocMeta,
          watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
        },
        getOrCreateSessionDoc,
        onMetaRoomSynced: vi.fn(() => vi.fn()),
      } as unknown as LoroDocumentManager;
      const watcher = createWatcher({
        logger: createSilentLogger(),
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        workspaceDocument,
        executionService: {
          getExecutionSnapshot: vi.fn(() => ({
            hasActiveTurn: false,
            hasBlockingPendingCreate: false,
            hasReusableSession: false,
          })),
          continueSession: vi.fn(async () => {}),
          startSession: vi.fn(async () => {}),
          cancelSession: vi.fn(async () => ({ success: true })),
        } as unknown as SessionExecutionService,
        canUseMachine: createAllowMachineAccess(),
        onStartupBootstrapComplete: bootstrapCompleted.resolve,
      });

      await watcher.start();
      await vi.advanceTimersByTimeAsync(0);
      await bootstrapCompleted.promise;

      expect(getDocMeta).toHaveBeenCalledTimes(roomIds.length);
      expect(getOrCreateSessionDoc).not.toHaveBeenCalled();
      watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('includes initial history checks in the bootstrap concurrency bound', async () => {
    vi.useFakeTimers();
    try {
      const sessionIds = Array.from(
        { length: 12 },
        (_, index) => `bounded-history-${index}` as SessionId
      );
      const releaseHistory = createDeferred();
      const firstBatchStarted = createDeferred();
      const bootstrapCompleted = createDeferred();
      const startSession = vi.fn(() => new Promise<void>(() => {}));
      let activeHistoryReads = 0;
      let maxActiveHistoryReads = 0;
      let historyReadCount = 0;
      const createMeta = (sessionId: SessionId) =>
        ({
          id: sessionId,
          machineId: 'machine-1',
          userId: 'user-1',
          createdAt: new Date().toISOString(),
          cliType: 'builtin',
          agentType: 'codex',
          status: { type: 'idle' as const },
          latestUserMsgId: `turn-${sessionId}`,
        }) satisfies SessionMeta;
      const getOrCreateSessionDoc = vi.fn(async (sessionId: SessionId) => {
        const meta = createMeta(sessionId);
        return {
          mirror: { subscribe: vi.fn(() => vi.fn()) },
          getMetaState: vi.fn(async () => meta),
          getHistory: vi.fn(async () => {
            historyReadCount += 1;
            activeHistoryReads += 1;
            maxActiveHistoryReads = Math.max(maxActiveHistoryReads, activeHistoryReads);
            if (historyReadCount === 3) {
              firstBatchStarted.resolve();
            }
            await releaseHistory.promise;
            activeHistoryReads -= 1;
            return [createPendingUserTurn(`turn-${sessionId}`, 'hello')];
          }),
          updateHistory: vi.fn(async () => {}),
          setStatus: vi.fn(async () => {}),
        };
      });
      const workspaceDocument = {
        repo: {
          getMeta: () => ({
            scan: vi.fn(async () =>
              sessionIds.map((sessionId) => ({
                key: ['e', `session-${sessionId}`],
                value: true,
              }))
            ),
          }),
          getDocMeta: vi.fn(async (roomId: string) => ({
            meta: createMeta(roomId.slice('session-'.length) as SessionId),
          })),
          watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
        },
        getOrCreateSessionDoc,
        onMetaRoomSynced: vi.fn(() => vi.fn()),
      } as unknown as LoroDocumentManager;
      const watcher = createWatcher({
        logger: createSilentLogger(),
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        workspaceDocument,
        executionService: {
          getExecutionSnapshot: vi.fn(() => ({
            hasActiveTurn: false,
            hasBlockingPendingCreate: false,
            hasReusableSession: false,
          })),
          continueSession: vi.fn(async () => {}),
          startSession,
          cancelSession: vi.fn(async () => ({ success: true })),
        } as unknown as SessionExecutionService,
        canUseMachine: createAllowMachineAccess(),
        onStartupBootstrapComplete: bootstrapCompleted.resolve,
      });

      await watcher.start();
      await vi.advanceTimersByTimeAsync(0);
      await firstBatchStarted.promise;

      expect({ historyReadCount, maxActiveHistoryReads }).toEqual({
        historyReadCount: 3,
        maxActiveHistoryReads: 3,
      });

      releaseHistory.resolve();
      await bootstrapCompleted.promise;
      await flushMicrotasks(20);
      expect(historyReadCount).toBe(sessionIds.length);
      expect(maxActiveHistoryReads).toBe(3);
      expect(startSession).toHaveBeenCalledTimes(sessionIds.length);
      watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces meta-room recovery bursts while a bootstrap scan is in flight', async () => {
    vi.useFakeTimers();
    try {
      const firstScanStarted = createDeferred();
      const releaseFirstScan = createDeferred();
      const secondScanStarted = createDeferred();
      let metaRoomSyncedListener: ((reason: string) => void) | undefined;
      const scan = vi.fn(async () => {
        const callCount = scan.mock.calls.length;
        if (callCount === 1) {
          firstScanStarted.resolve();
          await releaseFirstScan.promise;
        } else if (callCount === 2) {
          secondScanStarted.resolve();
        }
        return [];
      });
      const workspaceDocument = {
        repo: {
          getMeta: () => ({ scan }),
          getDocMeta: vi.fn(),
          watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
        },
        getOrCreateSessionDoc: vi.fn(),
        onMetaRoomSynced: vi.fn((listener: (reason: string) => void) => {
          metaRoomSyncedListener = listener;
          return vi.fn();
        }),
      } as unknown as LoroDocumentManager;
      const watcher = createWatcher({
        logger: createSilentLogger(),
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        workspaceDocument,
        executionService: {
          getExecutionSnapshot: vi.fn(() => ({
            hasActiveTurn: false,
            hasBlockingPendingCreate: false,
            hasReusableSession: false,
          })),
          continueSession: vi.fn(async () => {}),
          startSession: vi.fn(async () => {}),
          cancelSession: vi.fn(async () => ({ success: true })),
        } as unknown as SessionExecutionService,
        canUseMachine: createAllowMachineAccess(),
      });

      await watcher.start();
      await vi.advanceTimersByTimeAsync(0);
      await firstScanStarted.promise;

      metaRoomSyncedListener?.('transport-connected');
      metaRoomSyncedListener?.('transport-connected');
      metaRoomSyncedListener?.('meta-room-joined');
      await flushMicrotasks();
      expect(scan).toHaveBeenCalledTimes(1);

      releaseFirstScan.resolve();
      await secondScanStarted.promise;
      await flushMicrotasks();

      expect(scan).toHaveBeenCalledTimes(2);
      expect(scan).toHaveBeenNthCalledWith(1, { prefix: ['e'], includeRaw: false });
      expect(scan).toHaveBeenNthCalledWith(2, { prefix: ['e'], includeRaw: false });
      watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not continue a queued meta-room bootstrap after stop', async () => {
    const continueSession = vi.fn(async () => {});
    const startSession = vi.fn(async () => {});
    const cancelSession = vi.fn(async () => ({ success: true }));
    const sessionId = 'session-stopped-bootstrap' as SessionId;
    const roomId = `session-${sessionId}`;
    type ScanRow = { key: unknown[]; value: boolean };
    let metaRoomSyncedListener: ((reason: string) => void) | undefined;
    let resolveSecondScan: ((rows: ScanRow[]) => void) | undefined;

    const scan = vi.fn(async () => {
      if (scan.mock.calls.length === 1) {
        return [] satisfies ScanRow[];
      }
      return await new Promise<ScanRow[]>((resolve) => {
        resolveSecondScan = resolve;
      });
    });
    const detachMetaRoomSyncedListener = vi.fn();
    const getDocMeta = vi.fn(async () => ({
      meta: {
        id: sessionId,
        machineId: 'machine-1',
        userId: 'user-1',
        createdAt: new Date().toISOString(),
        cliType: 'builtin',
        agentType: 'codex',
        status: { type: 'idle' },
        latestUserMsgId: 'turn-stopped-bootstrap',
      },
    }));
    const getOrCreateSessionDoc = vi.fn(async () => ({
      mirror: {
        subscribe: vi.fn(() => vi.fn()),
      },
      getMetaState: vi.fn(async () => null),
      getHistory: vi.fn(async () => []),
      setStatus: vi.fn(async () => {}),
      waitForRemoteSync: vi.fn(async () => {}),
    }));

    const workspaceDocument = {
      repo: {
        getMeta: () => ({ scan }),
        getDocMeta,
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
      },
      getOrCreateSessionDoc,
      onMetaRoomSynced: vi.fn((listener: (reason: string) => void) => {
        metaRoomSyncedListener = listener;
        return detachMetaRoomSyncedListener;
      }),
    } as unknown as LoroDocumentManager;

    const watcher = createWatcher({
      logger: createSilentLogger(),
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      workspaceDocument,
      executionService: {
        getExecutionSnapshot: vi.fn(() => ({
          hasActiveTurn: false,
          hasBlockingPendingCreate: false,
          hasReusableSession: false,
        })),
        continueSession,
        startSession,
        cancelSession,
      } as unknown as SessionExecutionService,
      canUseMachine: createAllowMachineAccess(),
    });

    await watcher.start();
    await vi.waitFor(() => {
      expect(scan).toHaveBeenCalledTimes(1);
    });

    metaRoomSyncedListener?.('reconnect');
    await vi.waitFor(() => {
      expect(scan).toHaveBeenCalledTimes(2);
    });

    watcher.stop();
    resolveSecondScan?.([{ key: ['e', roomId], value: true }]);
    await Promise.resolve();
    await Promise.resolve();

    expect(detachMetaRoomSyncedListener).toHaveBeenCalledTimes(1);
    expect(getDocMeta).not.toHaveBeenCalled();
    expect(getOrCreateSessionDoc).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
    expect(continueSession).not.toHaveBeenCalled();
  });

  it('skips a user turn whose status is already handled', async () => {
    const continueSession = vi.fn(async () => {});
    const startSession = vi.fn(async () => {});
    const cancelSession = vi.fn(async () => ({ success: true }));
    const sessionId = 'session-3' as SessionId;
    const roomId = `session-${sessionId}`;

    const sessionDoc = {
      mirror: {
        subscribe: vi.fn(() => vi.fn()),
      },
      getMetaState: vi.fn(async () => ({
        id: sessionId,
        machineId: 'machine-1',
        userId: 'user-1',
        createdAt: new Date().toISOString(),
        cliType: 'builtin',
        agentType: 'codex',
        status: { type: 'idle' },
        lastHandledUserMsgId: 'turn-3',
      })),
      getHistory: vi.fn(async () => [
        {
          ...createPendingUserTurn('turn-3', 'hello again'),
          status: 'handled',
          read: true,
        },
      ]),
      setStatus: vi.fn(async () => {}),
      waitForRemoteSync: vi.fn(async () => {}),
    };

    const workspaceDocument = {
      repo: {
        getMeta: () => ({
          scan: vi.fn(async () => [{ key: ['e', roomId], value: true }]),
        }),
        getDocMeta: vi.fn(async () => ({
          meta: {
            id: sessionId,
            machineId: 'machine-1',
            userId: 'user-1',
            createdAt: new Date().toISOString(),
            cliType: 'builtin',
            agentType: 'codex',
            status: { type: 'idle' },
            lastHandledUserMsgId: 'turn-3',
          },
        })),
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
      },
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      onMetaRoomSynced: vi.fn(() => vi.fn()),
    } as unknown as LoroDocumentManager;

    const watcher = createWatcher({
      logger: createSilentLogger(),
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      workspaceDocument,
      executionService: {
        getExecutionSnapshot: vi.fn(() => ({
          hasActiveTurn: false,
          hasBlockingPendingCreate: false,
          hasReusableSession: false,
        })),
        continueSession,
        startSession,
        cancelSession,
      } as unknown as SessionExecutionService,
      canUseMachine: createAllowMachineAccess(),
    });

    await watcher.start();

    // With the lazy optimization, a session whose lastHandledUserMsgId is set
    // and has no pending signals is skipped entirely (room never joined).
    // Wait a tick to ensure no dispatch was triggered.
    await new Promise((r) => setTimeout(r, 50));
    expect(startSession).not.toHaveBeenCalled();
    expect(continueSession).not.toHaveBeenCalled();
  });

  it('keeps idle sessions metadata-only until explicit activation', () => {
    const watcher = createWatcher({
      logger: createSilentLogger(),
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      workspaceDocument: {} as LoroDocumentManager,
      executionService: {
        getExecutionSnapshot: vi.fn(() => ({
          hasActiveTurn: false,
          hasBlockingPendingCreate: false,
          hasReusableSession: false,
        })),
      } as unknown as SessionExecutionService,
      canUseMachine: createAllowMachineAccess(),
    });
    const sessionNeedsActiveWatch = (
      watcher as unknown as {
        sessionNeedsActiveWatch: (meta: SessionMeta) => boolean;
      }
    ).sessionNeedsActiveWatch.bind(watcher);
    const baseMeta = {
      id: 'session-recovery-idle' as SessionId,
      machineId: 'machine-1',
      userId: 'user-1',
      createdAt: new Date().toISOString(),
      cliType: 'builtin',
      agentType: 'codex',
      status: { type: 'idle' as const },
    } satisfies SessionMeta;

    expect(sessionNeedsActiveWatch(baseMeta)).toBe(false);
    expect(
      sessionNeedsActiveWatch({
        ...baseMeta,
        latestUserMsgId: 'turn-fresh',
      })
    ).toBe(true);
    expect(
      sessionNeedsActiveWatch({
        ...baseMeta,
        latestUserMsgId: 'turn-missing',
        processingUserMsgId: 'turn-missing',
        lastMissingHistoryUserMsgId: 'turn-missing',
      })
    ).toBe(false);
  });

  it('marks dispatch recovery only after waiting five minutes for missing history sync', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const continueSession = vi.fn(async () => {});
      const startSession = vi.fn(async () => {});
      const cancelSession = vi.fn(async () => ({ success: true }));
      const sessionId = 'session-missing-history' as SessionId;
      const roomId = `session-${sessionId}`;
      const upsertDocMeta = vi.fn(async () => {});
      const cleanSessionDoc = vi.fn(async () => {});
      const unsubscribeMirror = vi.fn();
      const recordChatFailure = vi.fn(async () => {});
      const sessionMeta = {
        id: sessionId,
        machineId: 'machine-1',
        userId: 'user-1',
        createdAt: new Date().toISOString(),
        cliType: 'builtin',
        agentType: 'codex',
        status: { type: 'idle' as const },
        latestUserMsgId: 'turn-missing',
      } satisfies SessionMeta;

      const sessionDoc = {
        mirror: {
          subscribe: vi.fn(() => unsubscribeMirror),
        },
        getMetaState: vi.fn(async () => sessionMeta),
        getHistory: vi.fn(async () => []),
        setStatus: vi.fn(async () => {}),
        waitForRemoteSync: vi.fn(async () => {}),
        waitUntilSynced: vi.fn(async () => true),
        ensureDocRoomJoined: vi.fn(() => new Promise<void>(() => {})),
        getDocRoomStatus: vi.fn(() => 'joined'),
        onDocRoomStatusChange: vi.fn(() => vi.fn()),
        rejoinDocRoom: vi.fn(async () => {}),
      };

      const workspaceDocument = {
        repo: {
          getDocMeta: vi.fn(async () => ({ meta: sessionMeta })),
          upsertDocMeta,
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        cleanSessionDoc,
      } as unknown as LoroDocumentManager;

      const watcher = createWatcher({
        logger: createSilentLogger(),
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        workspaceDocument,
        executionService: {
          getExecutionSnapshot: vi.fn(() => ({
            hasActiveTurn: false,
            hasBlockingPendingCreate: false,
            hasReusableSession: false,
          })),
          continueSession,
          startSession,
          cancelSession,
        } as unknown as SessionExecutionService,
        canUseMachine: createAllowMachineAccess(),
        recordChatFailure,
      });

      const run = runMaybeHandleSession(watcher, sessionId);
      await vi.advanceTimersByTimeAsync(0);
      await flushMicrotasks(50);

      expect(sessionDoc.ensureDocRoomJoined).toHaveBeenCalledTimes(1);
      expect(sessionDoc.waitUntilSynced).not.toHaveBeenCalled();
      expect(sessionDoc.mirror.subscribe).toHaveBeenCalledTimes(1);
      // The wait itself must not mutate session.status: a non-idle setStatus
      // here would refresh lastRunningSeen and re-light the "Working" indicator.
      expect(sessionDoc.setStatus).not.toHaveBeenCalled();
      expect(upsertDocMeta).not.toHaveBeenCalled();

      const elapsedMs = Date.now();
      await vi.advanceTimersByTimeAsync(5 * 60_000 - elapsedMs - 1);
      await flushMicrotasks();
      expect(upsertDocMeta).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await run;

      expect(startSession).not.toHaveBeenCalled();
      expect(continueSession).not.toHaveBeenCalled();
      expect(upsertDocMeta).toHaveBeenCalledWith(roomId, {
        status: { type: 'idle' },
        lastMissingHistoryUserMsgId: 'turn-missing',
      });
      expect(recordChatFailure).toHaveBeenCalledWith(
        sessionDoc,
        'message_delivery_failed',
        expect.any(String)
      );
      expect(cleanSessionDoc).toHaveBeenCalledWith(sessionId, { preserveStatus: true });
      expect(unsubscribeMirror).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps retrying rejoin with backoff while the joined history room stays disconnected', async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const continueSession = vi.fn(async () => {});
      const startSession = vi.fn(async () => {});
      const cancelSession = vi.fn(async () => ({ success: true }));
      const sessionId = 'session-history-disconnect' as SessionId;
      const sessionMeta = {
        id: sessionId,
        machineId: 'machine-1',
        userId: 'user-1',
        createdAt: new Date().toISOString(),
        cliType: 'builtin',
        agentType: 'codex',
        status: { type: 'idle' as const },
        latestUserMsgId: 'turn-missing',
      } satisfies SessionMeta;
      let roomStatusListener:
        | ((status: 'connecting' | 'joined' | 'reconnecting' | 'disconnected' | 'error') => void)
        | undefined;

      const sessionDoc = {
        mirror: {
          subscribe: vi.fn(() => vi.fn()),
        },
        getMetaState: vi.fn(async () => sessionMeta),
        getHistory: vi.fn(async () => []),
        setStatus: vi.fn(async () => {}),
        waitForRemoteSync: vi.fn(async () => {}),
        waitUntilSynced: vi.fn(async () => true),
        ensureDocRoomJoined: vi.fn(async () => {}),
        getDocRoomStatus: vi.fn(() => 'joined'),
        onDocRoomStatusChange: vi.fn((listener: NonNullable<typeof roomStatusListener>) => {
          roomStatusListener = listener;
          return vi.fn();
        }),
        rejoinDocRoom: vi.fn(async () => {}),
      };

      const workspaceDocument = {
        repo: {
          getDocMeta: vi.fn(async () => ({ meta: sessionMeta })),
          upsertDocMeta: vi.fn(async () => {}),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        cleanSessionDoc: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager;

      const watcher = createWatcher({
        logger: createSilentLogger(),
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        workspaceDocument,
        executionService: {
          getExecutionSnapshot: vi.fn(() => ({
            hasActiveTurn: false,
            hasBlockingPendingCreate: false,
            hasReusableSession: false,
          })),
          continueSession,
          startSession,
          cancelSession,
        } as unknown as SessionExecutionService,
        canUseMachine: createAllowMachineAccess(),
      });

      const run = runMaybeHandleSession(watcher, sessionId);
      await vi.advanceTimersByTimeAsync(0);
      await flushMicrotasks(50);
      expect(roomStatusListener).toBeDefined();

      roomStatusListener?.('disconnected');
      await flushMicrotasks();
      expect(sessionDoc.rejoinDocRoom).not.toHaveBeenCalled();
      // The wait must not mutate session.status; mutating it here would
      // refresh lastRunningSeen and cause the UI to re-light "Working".
      expect(sessionDoc.setStatus).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      await flushMicrotasks();
      expect(sessionDoc.rejoinDocRoom).toHaveBeenCalledTimes(1);

      // A later failure event schedules another attempt with exponential
      // backoff (1s backoff + 500ms jitter for the second attempt).
      roomStatusListener?.('error');
      await vi.advanceTimersByTimeAsync(1_400);
      await flushMicrotasks();
      expect(sessionDoc.rejoinDocRoom).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(100);
      await flushMicrotasks();
      expect(sessionDoc.rejoinDocRoom).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await run;
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('exits the history-sync wait without mutating status when the pending pointer already cleared', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const sessionId = 'session-pending-cleared' as SessionId;
      // The outer watcher read (maybeHandleSession) sees pending metadata that
      // has already been replaced by a newer queued-message pointer — enough
      // to trigger `waitForPendingUserTurnHistorySync` via the usual path.
      const outerMeta = {
        id: sessionId,
        machineId: 'machine-1',
        userId: 'user-1',
        createdAt: new Date().toISOString(),
        cliType: 'builtin',
        agentType: 'codex',
        status: { type: 'idle' as const },
        latestUserMsgId: 'turn-newly-pending',
        lastHandledUserMsgId: 'turn-previous-handled',
      } satisfies SessionMeta;
      // By the time the wait runs `waitUntilSynced` + `getMetaState`, the
      // session doc itself already shows the turn has been handled (the race
      // where a fresher meta update arrived locally between checks).
      const freshSessionDocMeta = {
        ...outerMeta,
        lastHandledUserMsgId: 'turn-newly-pending',
      } satisfies SessionMeta;

      const getMetaState = vi
        .fn()
        .mockResolvedValueOnce(outerMeta)
        .mockResolvedValue(freshSessionDocMeta);

      const sessionDoc = {
        mirror: {
          subscribe: vi.fn(() => vi.fn()),
        },
        getMetaState,
        getHistory: vi.fn(async () => []),
        setStatus: vi.fn(async () => {}),
        waitForRemoteSync: vi.fn(async () => {}),
        waitUntilSynced: vi.fn(async () => true),
        ensureDocRoomJoined: vi.fn(async () => {}),
        getDocRoomStatus: vi.fn(() => 'joined'),
        onDocRoomStatusChange: vi.fn(() => vi.fn()),
        rejoinDocRoom: vi.fn(async () => {}),
      };

      const upsertDocMeta = vi.fn(async () => {});
      const workspaceDocument = {
        repo: {
          getDocMeta: vi.fn(async () => ({ meta: outerMeta })),
          upsertDocMeta,
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        cleanSessionDoc: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager;

      const watcher = createWatcher({
        logger: createSilentLogger(),
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        workspaceDocument,
        executionService: {
          getExecutionSnapshot: vi.fn(() => ({
            hasActiveTurn: false,
            hasBlockingPendingCreate: false,
            hasReusableSession: false,
          })),
          continueSession: vi.fn(async () => {}),
          startSession: vi.fn(async () => {}),
          cancelSession: vi.fn(async () => ({ success: true })),
        } as unknown as SessionExecutionService,
        canUseMachine: createAllowMachineAccess(),
      });

      const run = runMaybeHandleSession(watcher, sessionId);
      await vi.advanceTimersByTimeAsync(0);
      await flushMicrotasks(50);
      await run;

      // The wait must not mutate session.status. A non-idle setStatus here
      // would refresh lastRunningSeen and make the UI re-light the "Working"
      // indicator after the turn had already completed — the regression this
      // test guards against.
      expect(sessionDoc.setStatus).not.toHaveBeenCalled();
      expect(sessionDoc.waitUntilSynced).toHaveBeenCalled();
      // The second (post-sync) getMetaState is what proves the fresh re-read
      // happened: if we skipped it, the wait would hang for 5 minutes.
      expect(getMetaState.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The settle tests all need the same shape: an owned idle session whose meta
   * and history are supplied, with every doc method the wait path would reach so
   * that entering the wait is observable rather than a five-minute hang.
   */
  const createSettleHarness = (
    sessionId: SessionId,
    initialMeta: Omit<
      SessionMeta,
      'id' | 'machineId' | 'userId' | 'createdAt' | 'cliType' | 'agentType' | 'status'
    >,
    history: SessionHistoryInput[],
    /** Overrides the repo read only, so a test can land a send mid-settle. */
    repoMetaOverride?: Partial<SessionMeta>
  ) => {
    const state = {
      meta: {
        id: sessionId,
        machineId: 'machine-1',
        userId: 'user-1',
        createdAt: new Date().toISOString(),
        cliType: 'builtin',
        agentType: 'codex',
        status: { type: 'idle' },
        ...initialMeta,
      } satisfies SessionMeta as SessionMeta,
    };
    const upsertDocMeta = vi.fn(async (_roomId: string, patch: Partial<SessionMeta>) => {
      state.meta = { ...state.meta, ...patch };
    });
    const recordChatFailure = vi.fn(async () => {});
    const startSession = vi.fn(async () => {});
    const continueSession = vi.fn(async () => {});
    const sessionDoc = {
      roomId: `session-${sessionId}`,
      mirror: { subscribe: vi.fn(() => vi.fn()) },
      getMetaState: vi.fn(async () => state.meta),
      getHistory: vi.fn(async () => history),
      setStatus: vi.fn(async () => {}),
      // Reaching any of these means the bounded history wait was entered.
      waitUntilSynced: vi.fn(async () => true),
      ensureDocRoomJoined: vi.fn(async () => {}),
      getDocRoomStatus: vi.fn(() => 'joined'),
      onDocRoomStatusChange: vi.fn(() => vi.fn()),
      rejoinDocRoom: vi.fn(async () => {}),
    };
    const watcher = createWatcher({
      logger: createSilentLogger(),
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      workspaceDocument: {
        repo: {
          getDocMeta: vi.fn(async () => ({ meta: { ...state.meta, ...repoMetaOverride } })),
          upsertDocMeta,
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        cleanSessionDoc: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      executionService: {
        getExecutionSnapshot: vi.fn(() => ({
          hasActiveTurn: false,
          hasBlockingPendingCreate: false,
          hasReusableSession: false,
        })),
        continueSession,
        startSession,
        cancelSession: vi.fn(async () => ({ success: true })),
      } as unknown as SessionExecutionService,
      canUseMachine: createAllowMachineAccess(),
      recordChatFailure,
    } as unknown as WatcherDeps);

    return {
      watcher,
      sessionDoc,
      upsertDocMeta,
      recordChatFailure,
      startSession,
      continueSession,
      meta: () => state.meta,
      /** Settlement must never rewrite the producer-owned pointer. */
      expectPointerNeverRewritten: () => {
        for (const [, patch] of upsertDocMeta.mock.calls) {
          expect(patch).not.toHaveProperty('latestUserMsgId');
        }
      },
    };
  };

  it('settles a stale activation pointer instead of accusing a turn that already ran', async () => {
    const sessionId = 'session-stale-pointer' as SessionId;
    // The shape a drained message queue used to leave behind: the pointer still
    // names the first direct send while `lastHandledUserMsgId` has advanced to a
    // later turn, so the pair never becomes equal on its own.
    const h = createSettleHarness(
      sessionId,
      { latestUserMsgId: 'turn-a', lastHandledUserMsgId: 'turn-b' },
      [
        { ...createPendingUserTurn('turn-a', 'first'), status: 'handled', read: true },
        { ...createPendingUserTurn('turn-b', 'second'), status: 'handled', read: true },
      ]
    );

    await runMaybeHandleSession(h.watcher, sessionId);

    // History already answered for `turn-a`, so no waiting and no accusation.
    expect(h.sessionDoc.waitUntilSynced).not.toHaveBeenCalled();
    expect(h.recordChatFailure).not.toHaveBeenCalled();
    // The activation is retired, so the session can stop being watched instead
    // of re-checking this same stale pair forever.
    expect(hasPendingUserTurnActivation(h.meta())).toBe(false);
    expect(h.meta().settledActivationUserMsgId).toBe('turn-a');
    expect(h.meta().latestUserMsgId).toBe('turn-a');
    h.expectPointerNeverRewritten();
  });

  it('settles a stale pointer without unprotecting an already-acknowledged turn', async () => {
    const sessionId = 'session-stale-with-marker' as SessionId;
    // `lastMissingHistoryUserMsgId` is a SINGLE slot. Turn X was acknowledged as
    // undelivered and its payload has since arrived as `pending`; only the
    // marker keeps it out of dispatch. Settling the unrelated stale pointer A
    // must not evict X from that slot.
    const history = [
      createPendingUserTurn('turn-x', 'never delivered'),
      { ...createPendingUserTurn('turn-a', 'first'), status: 'handled' as const, read: true },
      { ...createPendingUserTurn('turn-b', 'second'), status: 'handled' as const, read: true },
    ];
    const h = createSettleHarness(
      sessionId,
      {
        latestUserMsgId: 'turn-a',
        lastHandledUserMsgId: 'turn-b',
        lastMissingHistoryUserMsgId: 'turn-x',
      },
      history
    );

    await runMaybeHandleSession(h.watcher, sessionId);

    // X keeps the slot, so it stays undispatchable...
    expect(h.meta().lastMissingHistoryUserMsgId).toBe('turn-x');
    expect(findNextDispatchableUserTurn(history, h.meta())).toBeNull();
    // ...and the stale pointer still settled.
    expect(hasPendingUserTurnActivation(h.meta())).toBe(false);

    // A second pass must not resurrect X either.
    await runMaybeHandleSession(h.watcher, sessionId);
    expect(h.startSession).not.toHaveBeenCalled();
    expect(h.continueSession).not.toHaveBeenCalled();
  });

  it('does not accuse a newer activation when only part of the pointer state settles', async () => {
    const sessionId = 'session-partial-settle' as SessionId;
    // Crash-mid-turn left `processing=turn-a` behind after turn-a reached a
    // terminal status, and turn-c has since been published but has not synced.
    // Retiring turn-a must not report the session settled: turn-c is a real
    // activation and still needs its history-sync window.
    const h = createSettleHarness(
      sessionId,
      {
        processingUserMsgId: 'turn-a',
        latestUserMsgId: 'turn-c',
        lastHandledUserMsgId: 'turn-a',
      },
      [{ ...createPendingUserTurn('turn-a', 'first'), status: 'handled', read: true }]
    );

    void runMaybeHandleSession(h.watcher, sessionId);
    await vi.waitFor(() => {
      expect(h.sessionDoc.ensureDocRoomJoined).toHaveBeenCalled();
    });

    // turn-a is retired, turn-c keeps its activation and its grace window.
    expect(h.meta().processingUserMsgId).toBeUndefined();
    expect(h.recordChatFailure).not.toHaveBeenCalled();
    expect(getPendingUserTurnActivationId(h.meta())).toBe('turn-c');
    h.expectPointerNeverRewritten();
    h.watcher.stop();
  });

  it('does not accuse a turn published while the stale pointer was being settled', async () => {
    const sessionId = 'session-settle-race' as SessionId;
    // The outer read sees the stale pair; by the time settling re-reads meta a
    // producer has published turn-c, whose entry has not synced yet. Settling
    // must stand down rather than hand turn-c to missing-history recovery.
    const h = createSettleHarness(
      sessionId,
      { latestUserMsgId: 'turn-a', lastHandledUserMsgId: 'turn-b' },
      [
        { ...createPendingUserTurn('turn-a', 'first'), status: 'handled', read: true },
        { ...createPendingUserTurn('turn-b', 'second'), status: 'handled', read: true },
      ],
      { latestUserMsgId: 'turn-c' }
    );

    void runMaybeHandleSession(h.watcher, sessionId);
    await vi.waitFor(() => {
      expect(h.sessionDoc.ensureDocRoomJoined).toHaveBeenCalled();
    });

    // turn-c gets the grace window, and nothing was written against it.
    expect(h.recordChatFailure).not.toHaveBeenCalled();
    expect(h.upsertDocMeta).not.toHaveBeenCalled();
    h.watcher.stop();
  });
});
