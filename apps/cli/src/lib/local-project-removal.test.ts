import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type LocalProjectId,
  type MachineId,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import {
  cleanupLocalProjectWorktrees,
  preflightLocalProjectWorktreeRemoval,
} from './local-project-removal';

const inspectWorktree = vi.fn();
const removeWorktree = vi.fn();

vi.mock('@/session/worktree/worktree-manager', () => ({
  getWorktreeManager: () => ({ inspectWorktree, removeWorktree }),
}));

const machineId = 'machine-1' as MachineId;
const localProjectId = 'project-1' as LocalProjectId;
const cleanSessionId = 'session-clean' as SessionId;
const dirtySessionId = 'session-dirty' as SessionId;
const sessions = [
  {
    id: cleanSessionId,
    machineId,
    title: 'Clean session',
    isWorktree: true,
    project: { kind: 'local', localProjectId },
  },
  {
    id: dirtySessionId,
    machineId,
    title: 'Dirty session',
    isWorktree: true,
    project: { kind: 'local', localProjectId },
  },
] as SessionMeta[];

const target = {
  machineId,
  localProjectId,
  originalRootPath: '/repo/project',
  sessions,
  logger: { debug: vi.fn() } as never,
};

describe('local project worktree removal', () => {
  beforeEach(() => {
    inspectWorktree.mockReset();
    removeWorktree.mockReset();
  });

  it('lists dirty worktrees during preflight', async () => {
    inspectWorktree
      .mockResolvedValueOnce({ state: 'clean', path: '/worktrees/clean' })
      .mockResolvedValueOnce({ state: 'dirty', path: '/worktrees/dirty' });

    await expect(preflightLocalProjectWorktreeRemoval(target)).resolves.toEqual({
      clean: [{ sessionId: cleanSessionId, title: 'Clean session', path: '/worktrees/clean' }],
      dirty: [{ sessionId: dirtySessionId, title: 'Dirty session', path: '/worktrees/dirty' }],
      failed: [],
    });
  });

  it('deletes only clean worktrees without force or backup commits', async () => {
    inspectWorktree
      .mockResolvedValueOnce({ state: 'clean', path: '/worktrees/clean' })
      .mockResolvedValueOnce({ state: 'dirty', path: '/worktrees/dirty' });

    const result = await cleanupLocalProjectWorktrees(target);

    expect(removeWorktree).toHaveBeenCalledOnce();
    expect(removeWorktree).toHaveBeenCalledWith(cleanSessionId, false, undefined, {
      baseBranchName: undefined,
    });
    expect(result.deleted).toHaveLength(1);
    expect(result.skippedDirty).toEqual([
      { sessionId: dirtySessionId, title: 'Dirty session', path: '/worktrees/dirty' },
    ]);
    expect(result.failed).toEqual([]);
  });

  it('keeps a worktree that becomes dirty immediately before removal', async () => {
    inspectWorktree
      .mockResolvedValueOnce({ state: 'clean', path: '/worktrees/clean' })
      .mockResolvedValueOnce({ state: 'dirty', path: '/worktrees/clean' })
      .mockResolvedValueOnce({ state: 'missing', path: '/worktrees/dirty' });
    removeWorktree.mockRejectedValueOnce(new Error('worktree has uncommitted changes'));

    const result = await cleanupLocalProjectWorktrees(target);

    expect(result.deleted).toEqual([]);
    expect(result.skippedDirty).toEqual([
      { sessionId: cleanSessionId, title: 'Clean session', path: '/worktrees/clean' },
    ]);
    expect(result.failed).toEqual([]);
  });

  it('reports an individual cleanup failure and continues with the project removal result', async () => {
    inspectWorktree
      .mockResolvedValueOnce({ state: 'clean', path: '/worktrees/clean' })
      .mockResolvedValueOnce({ state: 'failed', path: '/worktrees/clean', message: 'git failed' })
      .mockResolvedValueOnce({ state: 'missing', path: '/worktrees/dirty' });
    removeWorktree.mockRejectedValueOnce(new Error('git worktree remove failed'));

    const result = await cleanupLocalProjectWorktrees(target);

    expect(result.deleted).toEqual([]);
    expect(result.skippedDirty).toEqual([]);
    expect(result.failed).toEqual([
      {
        sessionId: cleanSessionId,
        title: 'Clean session',
        path: '/worktrees/clean',
        message: 'git worktree remove failed',
      },
    ]);
  });
});
