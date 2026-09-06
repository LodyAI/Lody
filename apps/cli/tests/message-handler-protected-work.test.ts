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
