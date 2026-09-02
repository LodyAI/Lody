import { describe, expect, it } from 'vitest';
import type { LocalProjectId, MachineId, SessionId, WorkspaceId } from '@lody/shared';
import { resolveSessionMentionProjectSource } from '../src/lib/session-mention-file-source';
import type { FileWorkspaceProvider } from '../src/lib/file-workspace-provider';

const machineId = 'machine-1' as MachineId;
const workspaceId = 'lw_1' as WorkspaceId;
const localProjectId = 'lp_1' as LocalProjectId;
const sessionId = 'session-1' as SessionId;

const provider = { kind: 'code-collab-v2' } as unknown as FileWorkspaceProvider;

const base = {
  localFileSource: null,
  localProjectId: null,
  machineId,
  workspaceId,
  repoFullName: null,
  codeCollabProvider: null,
  codeCollabProviderPending: false,
} as const;

describe('resolveSessionMentionProjectSource', () => {
  it('uses the Code Collab provider when the session has no local file source', () => {
    expect(
      resolveSessionMentionProjectSource({
        ...base,
        localProjectId,
        repoFullName: 'acme/app',
        codeCollabProvider: provider,
      })
    ).toEqual({
      kind: 'provider',
      provider,
      providerPending: false,
      providerMessage: undefined,
      localProject: { machineId, localProjectId },
      githubRepoFullName: 'acme/app',
      isPublic: undefined,
    });
  });

  it('waits on a pending Code Collab provider rather than falling through', () => {
    const resolved = resolveSessionMentionProjectSource({
      ...base,
      repoFullName: 'acme/app',
      codeCollabProviderPending: true,
      codeCollabProviderMessage: 'Checking Code Collab session...',
    });
    expect(resolved).toMatchObject({ kind: 'provider', providerPending: true });
  });

  it('prefers the local project over a ready Code Collab provider', () => {
    expect(
      resolveSessionMentionProjectSource({
        ...base,
        localProjectId,
        localFileSource: { kind: 'local-project', workspaceId, localProjectId },
        codeCollabProvider: provider,
      })
    ).toEqual({
      kind: 'local',
      machineId,
      workspaceId,
      localProjectId,
      githubRepoFullName: undefined,
    });
  });

  it('prefers the local worktree over a pending Code Collab provider', () => {
    expect(
      resolveSessionMentionProjectSource({
        ...base,
        localProjectId,
        localFileSource: { kind: 'session-worktree', repoKey: 'repo-key', sessionId },
        codeCollabProviderPending: true,
      })
    ).toEqual({
      kind: 'local',
      machineId,
      workspaceId,
      localProjectId,
      githubRepoFullName: undefined,
      localWorktree: { machineId, repoKey: 'repo-key', sessionId },
    });
  });

  it('keeps a GitHub session on its local worktree instead of the provider', () => {
    expect(
      resolveSessionMentionProjectSource({
        ...base,
        repoFullName: 'acme/app',
        isRepoPublic: true,
        localFileSource: { kind: 'session-worktree', repoKey: 'acme/app', sessionId },
        codeCollabProvider: provider,
      })
    ).toEqual({
      kind: 'github',
      repoFullName: 'acme/app',
      isPublic: true,
      localWorktree: { machineId, repoKey: 'acme/app', sessionId },
    });
  });

  it('falls back to the GitHub repo when nothing local or shared is available', () => {
    expect(
      resolveSessionMentionProjectSource({ ...base, repoFullName: 'acme/app' })
    ).toEqual({
      kind: 'github',
      repoFullName: 'acme/app',
      isPublic: undefined,
      localWorktree: undefined,
    });
  });

  it('has no source for a chat session with no project, repo, or provider', () => {
    expect(resolveSessionMentionProjectSource(base)).toBeUndefined();
  });
});
