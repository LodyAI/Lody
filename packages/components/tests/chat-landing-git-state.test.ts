import { describe, expect, it } from 'vitest';
import type { MachineId, MachineMeta } from '@lody/shared';
import {
  getLocalProjectWorktreeAvailability,
  resolveLocalProjectBranchSelection,
} from '../src/lib/chat-landing-git-state';

const machineMeta = (overrides: Partial<MachineMeta> = {}): MachineMeta =>
  ({
    id: 'machine-target' as MachineId,
    ...overrides,
  }) as MachineMeta;

describe('local project Git selection', () => {
  it('does not synthesize a branch or offer worktrees for an empty repository', () => {
    const state = {
      git: true as const,
      branches: [],
      currentBranch: null,
      defaultBranch: null,
      githubRepoFullName: null,
      workingTree: {
        clean: true,
        staged: false,
        unstaged: false,
        untracked: false,
        conflicted: false,
      },
    };

    expect(resolveLocalProjectBranchSelection(state, null)).toBeNull();
    expect(getLocalProjectWorktreeAvailability(state)).toBe(false);
  });

  it('keeps a valid previous selection and enables worktrees when refs exist', () => {
    const state = {
      git: true as const,
      branches: ['feature/selected', 'main'],
      currentBranch: null,
      defaultBranch: 'main',
      githubRepoFullName: null,
      workingTree: {
        clean: true,
        staged: false,
        unstaged: false,
        untracked: false,
        conflicted: false,
      },
    };

    expect(resolveLocalProjectBranchSelection(state, 'feature/selected')).toBe('feature/selected');
    expect(getLocalProjectWorktreeAvailability(state)).toBe(true);
  });
});
