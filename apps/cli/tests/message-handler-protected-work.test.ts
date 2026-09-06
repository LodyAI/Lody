import { expect, it, vi } from 'vitest';
import { SessionIdSchema } from '@lody/shared';
import { MessageHandler } from '../src/lib/message-handler';

const sessionId = SessionIdSchema.parse('protected-work');
const pendingTask = { type: 'subagent_task', taskId: 'task-1', status: 'pending' };
const goal = (status: string) => ({
  type: 'goal',
  threadId: 'goal-1',
  objective: 'Finish work',
  status,
});

function fixture(items: unknown[] = []) {
  const hasRunningTerminals = vi.fn(() => false);
  const initialRuntime = { terminalManager: { hasRunningTerminals } };
  let runtime: typeof initialRuntime | null = initialRuntime;
  const getHistory = vi.fn(async () => [{ items }]);
  const getMetaState = vi.fn(async (): Promise<unknown> => null);
  const receiver = {
    sessionManager: { getSession: () => runtime },
    workspaceDocument: { getOrCreateSessionDoc: async () => ({ getHistory, getMetaState }) },
  };
  return {
    read: () => MessageHandler.prototype.hasProtectedWork.call(receiver, sessionId),
    getHistory,
    getMetaState,
    hasRunningTerminals,
    removeRuntime: () => {
      runtime = null;
    },
    replaceRuntime: () => {
      runtime = { terminalManager: { hasRunningTerminals } };
    },
  };
}

it('reads history once for both goals and background tasks', async () => {
  const f = fixture([goal('paused'), pendingTask]);
  await expect(f.read()).resolves.toBe(true);
  expect(f.getHistory).toHaveBeenCalledOnce();
});

it('preserves active goals even without a runtime and lets latest history override legacy goal', async () => {
  const active = fixture([goal('active')]);
  active.removeRuntime();
  await expect(active.read()).resolves.toBe(true);
  const paused = fixture([goal('paused')]);
  paused.getMetaState.mockResolvedValue({ latestGoal: goal('active') });
  paused.removeRuntime();
  await expect(paused.read()).resolves.toBe(false);
  const legacy = fixture();
  legacy.getMetaState.mockResolvedValue({ latestGoal: goal('active') });
  legacy.removeRuntime();
  await expect(legacy.read()).resolves.toBe(true);
});

it('does not let stale task snapshots pin state after the runtime has exited', async () => {
  const f = fixture([pendingTask]);
  f.removeRuntime();
  await expect(f.read()).resolves.toBe(false);
});

it('rechecks runtime ownership after awaiting history', async () => {
  const f = fixture([pendingTask]);
  f.getHistory.mockImplementation(async () => {
    f.removeRuntime();
    return [{ items: [pendingTask] }];
  });
  await expect(f.read()).resolves.toBe(false);
});

it('does not apply an old history snapshot to a replacement runtime', async () => {
  const f = fixture();
  f.getHistory.mockImplementation(async () => {
    f.replaceRuntime();
    return [{ items: [] }];
  });
  await expect(f.read()).resolves.toBe(true);
});

it('checks live terminals before history and again after awaited metadata', async () => {
  const live = fixture();
  live.hasRunningTerminals.mockReturnValue(true);
  await expect(live.read()).resolves.toBe(true);
  expect(live.getHistory).not.toHaveBeenCalled();
  const raced = fixture();
  raced.getMetaState.mockImplementation(async () => {
    raced.hasRunningTerminals.mockReturnValue(true);
    return null;
  });
  await expect(raced.read()).resolves.toBe(true);
});

it('surfaces history errors for the per-session GC guard', async () => {
  const f = fixture();
  f.getHistory.mockRejectedValue(new Error('history unavailable'));
  await expect(f.read()).rejects.toThrow('history unavailable');
});

it.each(['turn', 'terminal', 'history', 'replacement', 'metadata', 'rpc'] as const)(
  'refuses cleanup when %s changes during preview close without clearing presence',
  async (change) => {
    let active = false;
    let terminal = false;
    let state = { history: [] as unknown[] };
    let metadataClock = 0;
    let pendingDispatch = false;
    const metadata = {
      version: () => ({ peer: { physicalTime: metadataClock, logicalCounter: 0 } }),
    };
    let runtime = { terminalManager: { hasRunningTerminals: () => terminal } };
    const doc = { mirror: { getState: () => state } };
    const terminateSession = vi.fn(async () => {});
    const clearPresence = vi.fn();
    const cleanSessionDoc = vi.fn(async () => {});
    const deleteSession = vi.fn();
    const receiver = {
      logger: { debug: () => {} },
      sessionManager: { getSession: () => runtime, terminateSession },
      workspaceDocument: {
        sessions: new Map([[sessionId, doc]]),
        cleanSessionDoc,
        repo: { getMeta: () => metadata },
      },
      sessionDispatchWatcher: { hasPendingDispatch: () => pendingDispatch },
      hasActiveTurn: () => active,
      hasPendingUpdates: () => false,
      isArchiveInFlight: () => false,
      clearSessionActivePresence: clearPresence,
      store: { deleteSession },
      previewService: {
        closeSessionPreviewForCleanup: async () => {
          if (change === 'turn') active = true;
          if (change === 'terminal') terminal = true;
          if (change === 'history') state = { history: [goal('active')] };
          if (change === 'metadata') metadataClock++;
          if (change === 'rpc') pendingDispatch = true;
          if (change === 'replacement')
            runtime = { terminalManager: { hasRunningTerminals: () => false } };
        },
      },
    };
    const guard = MessageHandler.prototype.captureGCCleanupGuard.call(receiver, sessionId);
    expect(guard()).toBe(true);
    await expect(
      MessageHandler.prototype.cleanSessionForGC.call(receiver, sessionId, guard)
    ).resolves.toBe(false);
    expect(terminateSession).not.toHaveBeenCalled();
    expect(clearPresence).not.toHaveBeenCalled();
    expect(cleanSessionDoc).not.toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
  }
);

it('starts termination synchronously after the final cleanup guard', async () => {
  const events: string[] = [];
  const receiver = {
    logger: { debug: () => {} },
    previewService: {
      closeSessionPreviewForCleanup: async () => {
        events.push('preview');
      },
    },
    sessionManager: {
      tryAcquireGCCleanupLease: () => () => events.push('release-manager'),
      terminateSession: () => {
        events.push('terminate');
        return Promise.resolve();
      },
    },
    sessionDispatchWatcher: {
      tryAcquireGCCleanupLease: () => () => events.push('release-dispatch'),
    },
    executionService: { tryAcquireGCCleanupLease: () => () => events.push('release-execution') },
    clearSessionActivePresence: () => events.push('presence'),
    workspaceDocument: {
      cleanSessionDoc: async () => {
        events.push('doc');
      },
    },
    store: { deleteSession: () => events.push('store') },
  };
  const guard = () => {
    events.push('guard');
    return true;
  };
  await expect(
    MessageHandler.prototype.cleanSessionForGC.call(receiver, sessionId, guard)
  ).resolves.toBe(true);
  expect(events).toEqual([
    'guard',
    'preview',
    'guard',
    'guard',
    'terminate',
    'presence',
    'doc',
    'store',
    'release-manager',
    'release-execution',
    'release-dispatch',
  ]);
});

it.each(['success', 'termination-failure', 'document-failure'] as const)(
  'holds all GC leases across termination and document awaits, releasing on %s',
  async (outcome) => {
    let finishTermination!: () => void;
    let finishDocument!: () => void;
    let documentStarted!: () => void;
    const termination = new Promise<void>((resolve) => {
      finishTermination = resolve;
    });
    const document = new Promise<void>((resolve) => {
      finishDocument = resolve;
    });
    const documentStart = new Promise<void>((resolve) => {
      documentStarted = resolve;
    });
    const held = new Set<string>();
    const acquire = (name: string) => () => {
      held.add(name);
      return () => held.delete(name);
    };
    const deleteSession = vi.fn(() =>
      expect([...held].sort()).toEqual(['dispatch', 'execution', 'manager'])
    );
    const cleanSessionDoc = vi.fn(async () => {
      documentStarted();
      await document;
      if (outcome === 'document-failure') throw new Error('document failure');
    });
    const receiver = {
      logger: { debug: () => {} },
      previewService: { closeSessionPreviewForCleanup: async () => {} },
      sessionManager: {
        tryAcquireGCCleanupLease: acquire('manager'),
        terminateSession: async () => {
          await termination;
          if (outcome === 'termination-failure') throw new Error('termination failure');
        },
      },
      sessionDispatchWatcher: { tryAcquireGCCleanupLease: acquire('dispatch') },
      executionService: { tryAcquireGCCleanupLease: acquire('execution') },
      clearSessionActivePresence: () => {},
      workspaceDocument: { cleanSessionDoc },
      store: { deleteSession },
    };
    const cleanup = MessageHandler.prototype.cleanSessionForGC.call(
      receiver,
      sessionId,
      () => true
    );
    const result =
      outcome === 'success'
        ? expect(cleanup).resolves.toBe(true)
        : expect(cleanup).rejects.toThrow(
            outcome === 'termination-failure' ? 'termination failure' : 'document failure'
          );
    await Promise.resolve();
    expect([...held].sort()).toEqual(['dispatch', 'execution', 'manager']);
    finishTermination();
    if (outcome !== 'termination-failure') {
      await documentStart;
      expect([...held].sort()).toEqual(['dispatch', 'execution', 'manager']);
      expect(deleteSession).not.toHaveBeenCalled();
      finishDocument();
    }
    await result;
    expect(held.size).toBe(0);
    expect(deleteSession).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
  }
);

it.each(['dispatch', 'execution', 'manager'] as const)(
  'defers GC and releases earlier leases when %s admission is busy',
  async (busy) => {
    const held = new Set<string>();
    const acquire = (name: string) => () => {
      if (name === busy) return null;
      held.add(name);
      return () => held.delete(name);
    };
    const terminateSession = vi.fn();
    const clearSessionActivePresence = vi.fn();
    const deleteSession = vi.fn();
    const receiver = {
      logger: { debug: () => {} },
      previewService: { closeSessionPreviewForCleanup: async () => {} },
      sessionManager: { tryAcquireGCCleanupLease: acquire('manager'), terminateSession },
      sessionDispatchWatcher: { tryAcquireGCCleanupLease: acquire('dispatch') },
      executionService: { tryAcquireGCCleanupLease: acquire('execution') },
      clearSessionActivePresence,
      store: { deleteSession },
    };
    await expect(
      MessageHandler.prototype.cleanSessionForGC.call(receiver, sessionId, () => true)
    ).resolves.toBe(false);
    expect(held.size).toBe(0);
    expect(terminateSession).not.toHaveBeenCalled();
    expect(clearSessionActivePresence).not.toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
  }
);
