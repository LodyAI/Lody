import { describe, expect, it } from 'vitest';
import type { LocalProjectId, SessionId, SessionMeta } from '@lody/shared';
import { resolveAllChangesUiState } from '../src/lib/session-all-changes-scope';

const directLocalSession: SessionMeta = {
  id: 'session-direct' as SessionId,
  machineId: 'machine-1',
  userId: 'user-1',
  repoFullName: 'acme/app',
  baseBranch: 'main',
  project: {
    kind: 'local',
    localProjectId: 'local-1' as LocalProjectId,
    githubRepoFullName: 'acme/app',
  },
};

const plainChatSession: SessionMeta = {
  id: 'session-plain' as SessionId,
  machineId: 'machine-1',
  userId: 'user-1',
};

const worktreeSession: SessionMeta = {
  id: 'session-worktree' as SessionId,
  machineId: 'machine-1',
  userId: 'user-1',
  baseBranch: 'main',
  isWorktree: true,
  project: {
    kind: 'local',
    localProjectId: 'local-1' as LocalProjectId,
    useWorktree: true,
  },
};

describe('resolveAllChangesUiState', () => {
  it('hides the toggle, keeps default wire scope, and uses HEAD presentation for non-worktree Git sessions', () => {
    const state = resolveAllChangesUiState({
      session: directLocalSession,
      preferredScope: 'uncommitted',
      scopeSupported: true,
      allChangesBase: 'abcdef1234567890abcdef1234567890abcdef12',
    });

    expect(state).toEqual({
      tracksUncommittedOnly: true,
      canToggleScope: false,
      requestScope: 'branch',
      base: { kind: 'head', ref: 'abcdef1' },
      emptyReason: 'no-uncommitted-changes',
      focusOutsideScopeReason: 'focus-no-uncommitted-changes',
    });

    const childOfDirect = resolveAllChangesUiState({
      session: {
        ...plainChatSession,
        id: 'session-child' as SessionId,
        parentSessionId: directLocalSession.id,
      },
      workspaceSession: directLocalSession,
      preferredScope: 'uncommitted',
      scopeSupported: true,
      allChangesBase: 'abcdef1234567890abcdef1234567890abcdef12',
      focusFilePath: 'committed.txt',
    });
    expect(childOfDirect.canToggleScope).toBe(false);
    expect(childOfDirect.requestScope).toBe('branch');
    expect(childOfDirect.emptyReason).toBe('focus-no-uncommitted-changes');
  });

  it('avoids flashing HEAD while loading and keeps Session changes for non-Git diff-store sessions', () => {
    const loading = resolveAllChangesUiState({
      session: plainChatSession,
      preferredScope: 'uncommitted',
      scopeSupported: true,
      allChangesBase: null,
    });
    expect(loading.base).toEqual({ kind: 'loading' });
    expect(loading.requestScope).toBe('branch');

    const diffStore = resolveAllChangesUiState({
      session: plainChatSession,
      preferredScope: 'uncommitted',
      scopeSupported: true,
      allChangesBase: 'diff-store',
      focusFilePath: 'notes.md',
    });
    expect(diffStore).toEqual({
      tracksUncommittedOnly: true,
      canToggleScope: false,
      requestScope: 'branch',
      base: { kind: 'session-changes' },
      emptyReason: 'no-changes',
      focusOutsideScopeReason: null,
    });
  });

  it('preserves scope toggling for worktree sessions and gates requestScope on daemon support', () => {
    const branch = resolveAllChangesUiState({
      session: worktreeSession,
      preferredScope: 'branch',
      scopeSupported: true,
      allChangesBase: '1234567890abcdef1234567890abcdef12345678',
      focusFilePath: 'src/a.ts',
    });
    expect(branch).toEqual({
      tracksUncommittedOnly: false,
      canToggleScope: true,
      requestScope: 'branch',
      base: { kind: 'branch', branchName: 'main', ref: '1234567' },
      emptyReason: 'focus-no-branch-changes',
      focusOutsideScopeReason: 'focus-no-branch-changes',
    });

    const unsupported = resolveAllChangesUiState({
      session: worktreeSession,
      preferredScope: 'uncommitted',
      scopeSupported: false,
      allChangesBase: '1234567890abcdef1234567890abcdef12345678',
    });
    expect(unsupported.canToggleScope).toBe(false);
    expect(unsupported.requestScope).toBe('branch');
    expect(unsupported.base).toEqual({ kind: 'branch', branchName: 'main', ref: '1234567' });
  });
});
