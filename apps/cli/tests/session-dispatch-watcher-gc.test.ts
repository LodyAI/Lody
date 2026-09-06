import { describe, expect, it, vi } from 'vitest';
import { SessionIdSchema, type SessionMeta, type WorkspaceId } from '@lody/shared';
import { SessionDispatchWatcher } from '../src/session/session-dispatch-watcher';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import type { SessionExecutionService } from '../src/session/session-execution-service';
import type { Logger } from '../src/utils/logger';

const sessionId = SessionIdSchema.parse('gc-lease-session');
const logger: Logger = {
  info() {},
  warn() {},
  error() {},
  success() {},
  debug() {},
  setLevel() {},
  child: () => logger,
  close: async () => {},
};
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let meta: SessionMeta = {
    id: sessionId,
    machineId: 'machine-1',
    userId: 'user-1',
    createdAt: new Date().toISOString(),
    cliType: 'builtin',
    agentType: 'codex',
    status: { type: 'idle' },
  };
  let notifyMetadata = (_event: { kind: string; docId: string }) => {};
  const makeDoc = () => ({
    mirror: { subscribe: vi.fn(() => vi.fn()) },
    getMetaState: vi.fn(async () => meta),
    getHistory: vi.fn(async () => []),
    updateHistory: vi.fn(async () => {}),
    setStatus: vi.fn(async () => {}),
    waitForRemoteSync: vi.fn(async () => {}),
  });
  let doc = makeDoc();
  const getDocMeta = vi.fn(async () => ({ meta }));
  const getOrCreateSessionDoc = vi.fn(async () => doc);
  const cancel = vi.fn(async () => ({ success: true }));
  const dispatch = vi.fn(
    async (options: {
      onAccessAllowed: () => void | Promise<void>;
      accessPromise: Promise<unknown>;
      requestPromise: Promise<unknown>;
    }) => {
      await options.accessPromise;
      await options.requestPromise;
      await options.onAccessAllowed();
    }
  );
  const watcher = new SessionDispatchWatcher({
    logger,
    machineId: 'machine-1',
    workspaceId: 'workspace-1' as WorkspaceId,
    userResolver: {
      resolve: async (id) => ({ id, name: 'User', email: 'user@example.com' }),
      clear() {},
    },
    canUseMachine: async () => ({ outcome: 'allowed' }),
    workspaceDocument: {
      repo: {
        getDocMeta,
        upsertDocMeta: vi.fn(async () => {}),
        getMeta: () => ({ scan: async () => [] }),
        watch: (callback: typeof notifyMetadata) => {
          notifyMetadata = callback;
          return { unsubscribe() {} };
        },
      },
      getOrCreateSessionDoc,
      onMetaRoomSynced: () => () => {},
    } as unknown as LoroDocumentManager,
    executionService: {
      getExecutionSnapshot: () => ({
        hasActiveTurn: false,
        hasBlockingPendingCreate: false,
        hasReusableSession: false,
      }),
      tryAcquireSessionRewriteConflictLease: () => () => {},
      dispatchPreparedSessionTurn: dispatch,
      cancelSession: cancel,
    } as unknown as SessionExecutionService,
  });
  return {
    watcher,
    dispatch,
    cancel,
    getOrCreateSessionDoc,
    getDocMeta,
    metadataChanged: () => notifyMetadata({ kind: 'doc-metadata', docId: `session-${sessionId}` }),
    replaceDoc: () => {
      doc = makeDoc();
      return doc;
    },
    setMeta: (next: SessionMeta) => {
      meta = next;
    },
    offer: () =>
      watcher.offerRpcTurn({
        sessionId,
        userTurnId: 'rpc-1',
        userId: 'user-1',
        timestamp: new Date().toISOString(),
        inputConfig: { prompt: 'Do the work' },
      }),
  };
}

describe('watcher GC cleanup lease', () => {
  it('resumes a metadata-only cancellation against the fresh document', async () => {
    const f = fixture();
    await f.watcher.start();
    const release = f.watcher.tryAcquireGCCleanupLease(sessionId);
    expect(release).not.toBeNull();
    try {
      const record = await f.getDocMeta();
      f.setMeta({ ...record.meta, lastCanceledTurn: 'cancel-1' });
      f.metadataChanged();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(f.getOrCreateSessionDoc).not.toHaveBeenCalled();
      expect(f.cancel).not.toHaveBeenCalled();
      const fresh = f.replaceDoc();
      release?.();
      await vi.waitFor(() => expect(f.cancel).toHaveBeenCalledOnce());
      expect(fresh.mirror.subscribe).toHaveBeenCalledOnce();
    } finally {
      f.watcher.stop();
    }
  });

  it('stashes RPC and metadata work until release, then opens the fresh document', async () => {
    const f = fixture();
    await f.watcher.start();
    const oldUnsubscribe = vi.fn();
    const watched = f.watcher as unknown as {
      watchedSessions: Map<typeof sessionId, { unsubscribe: () => void }>;
    };
    watched.watchedSessions.set(sessionId, { unsubscribe: oldUnsubscribe });
    const release = f.watcher.tryAcquireGCCleanupLease(sessionId);
    expect(release).not.toBeNull();
    try {
      await expect(f.offer()).resolves.toBe('accepted');
      f.metadataChanged();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(f.dispatch).not.toHaveBeenCalled();
      expect(f.getOrCreateSessionDoc).not.toHaveBeenCalled();
      expect(f.watcher.hasPendingDispatch(sessionId)).toBe(true);
      const fresh = f.replaceDoc();
      release?.();
      release?.();
      expect(oldUnsubscribe).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(1));
      expect(fresh.mirror.subscribe).toHaveBeenCalledOnce();
    } finally {
      f.watcher.stop();
    }
  });

  it('does not reopen an idle document when releasing without pending work', async () => {
    const f = fixture();
    await f.watcher.start();
    const release = f.watcher.tryAcquireGCCleanupLease(sessionId);
    expect(release).not.toBeNull();
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.getOrCreateSessionDoc).not.toHaveBeenCalled();
    f.watcher.stop();
  });

  it('refuses queued metadata work and an active reconcile', async () => {
    const f = fixture();
    await f.watcher.start();
    const read = deferred();
    const record = await f.getDocMeta();
    f.getDocMeta.mockClear();
    f.getDocMeta.mockImplementation(async () => {
      await read.promise;
      return record;
    });
    f.metadataChanged();
    expect(f.watcher.tryAcquireGCCleanupLease(sessionId)).toBeNull();
    await vi.waitFor(() => expect(f.getDocMeta).toHaveBeenCalled());
    expect(f.watcher.tryAcquireGCCleanupLease(sessionId)).toBeNull();
    read.resolve();
    f.watcher.stop();
  });

  it('refuses an already accepted RPC payload even without a running check', async () => {
    const f = fixture();
    vi.spyOn(f.watcher, 'enqueueSessionCheck').mockResolvedValue(undefined);
    await expect(f.offer()).resolves.toBe('accepted');
    expect(f.watcher.hasPendingDispatch(sessionId)).toBe(true);
    expect(f.watcher.tryAcquireGCCleanupLease(sessionId)).toBeNull();
    f.watcher.stop();
  });

  it.each(['dispatch', 'cancel'] as const)('refuses an existing %s check', async (kind) => {
    const f = fixture();
    const gate = deferred();
    const internals = f.watcher as unknown as {
      maybeHandleSession: () => Promise<void>;
      maybeHandleCancelRequest: () => Promise<void>;
      enqueueCancelCheck: (id: typeof sessionId) => Promise<void>;
    };
    if (kind === 'dispatch')
      vi.spyOn(internals, 'maybeHandleSession').mockReturnValue(gate.promise);
    else vi.spyOn(internals, 'maybeHandleCancelRequest').mockReturnValue(gate.promise);
    const pending =
      kind === 'dispatch'
        ? f.watcher.enqueueSessionCheck(sessionId)
        : internals.enqueueCancelCheck(sessionId);
    expect(f.watcher.tryAcquireGCCleanupLease(sessionId)).toBeNull();
    gate.resolve();
    await pending;
    const release = f.watcher.tryAcquireGCCleanupLease(sessionId);
    expect(release).not.toBeNull();
    release?.();
    f.watcher.stop();
  });

  it('defers cancellation checks until release', async () => {
    const f = fixture();
    const internals = f.watcher as unknown as {
      maybeHandleCancelRequest: () => Promise<void>;
      enqueueCancelCheck: (id: typeof sessionId) => Promise<void>;
    };
    const cancel = vi.spyOn(internals, 'maybeHandleCancelRequest').mockResolvedValue(undefined);
    const release = f.watcher.tryAcquireGCCleanupLease(sessionId);
    await internals.enqueueCancelCheck(sessionId);
    expect(cancel).not.toHaveBeenCalled();
    release?.();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    f.watcher.stop();
  });

  it('does not resume deferred work after stop or let an old release clear a new lease', async () => {
    const f = fixture();
    await f.watcher.start();
    const oldRelease = f.watcher.tryAcquireGCCleanupLease(sessionId);
    await f.offer();
    f.watcher.stop();
    oldRelease?.();
    expect(f.dispatch).not.toHaveBeenCalled();
    await f.watcher.start();
    const newRelease = f.watcher.tryAcquireGCCleanupLease(sessionId);
    expect(newRelease).not.toBeNull();
    oldRelease?.();
    expect(f.watcher.tryAcquireGCCleanupLease(sessionId)).toBeNull();
    newRelease?.();
    f.watcher.stop();
  });
});
