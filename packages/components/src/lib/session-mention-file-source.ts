import type { LocalProjectId, MachineId, WorkspaceId } from '@lody/shared';
import type { MentionProjectSource } from '@/components/mentions/mention-project-file-source';
import type { FileWorkspaceProvider } from './file-workspace-provider';
import type { SessionLocalFileSource } from './session-local-file-source';

export type SessionMentionProjectSourceInput = {
  /**
   * Non-null only for a session whose files this renderer can reach over the
   * local Electron IPC RPC (same machine as the running CLI daemon).
   */
  readonly localFileSource: SessionLocalFileSource | null;
  /** `session.project.localProjectId`, or null when the project is not local. */
  readonly localProjectId: LocalProjectId | null;
  readonly machineId: MachineId;
  readonly workspaceId: WorkspaceId | null;
  readonly repoFullName: string | null;
  readonly isRepoPublic?: boolean;
  readonly codeCollabProvider: FileWorkspaceProvider | null;
  readonly codeCollabProviderPending: boolean;
  readonly codeCollabProviderMessage?: string;
};

/**
 * Picks the file source an in-session `@` menu searches.
 *
 * A same-machine session resolves to a local source, which reaches the CLI
 * daemon over the renderer -> main IPC RPC and lists the working tree as it is
 * right now. The Code Collab file index is a synced snapshot: correct for a
 * remote machine, but a detour that answers with stale paths when the files are
 * on this machine. `file-tree-view.tsx` already prefers local the same way, so
 * the tree and the `@` menu cannot disagree about what exists.
 */
export function resolveSessionMentionProjectSource(
  input: SessionMentionProjectSourceInput
): MentionProjectSource | undefined {
  const {
    localFileSource,
    localProjectId,
    machineId,
    workspaceId,
    repoFullName,
    isRepoPublic,
    codeCollabProvider,
    codeCollabProviderPending,
    codeCollabProviderMessage,
  } = input;

  if (!localFileSource && (codeCollabProvider || codeCollabProviderPending)) {
    return {
      kind: 'provider',
      provider: codeCollabProvider,
      providerPending: codeCollabProviderPending,
      providerMessage: codeCollabProviderMessage,
      localProject: localProjectId ? { machineId, localProjectId } : undefined,
      githubRepoFullName: repoFullName || undefined,
      isPublic: isRepoPublic,
    };
  }

  if (localProjectId && workspaceId && localFileSource?.kind === 'session-worktree') {
    return {
      kind: 'local',
      machineId,
      workspaceId,
      localProjectId,
      githubRepoFullName: repoFullName || undefined,
      localWorktree: {
        machineId,
        repoKey: localFileSource.repoKey,
        sessionId: localFileSource.sessionId,
      },
    };
  }

  if (localFileSource?.kind === 'local-project') {
    return {
      kind: 'local',
      machineId,
      workspaceId: localFileSource.workspaceId,
      localProjectId: localFileSource.localProjectId,
      githubRepoFullName: repoFullName || undefined,
    };
  }

  if (repoFullName) {
    return {
      kind: 'github',
      repoFullName,
      isPublic: isRepoPublic,
      localWorktree:
        localFileSource?.kind === 'session-worktree'
          ? {
              machineId,
              repoKey: localFileSource.repoKey,
              sessionId: localFileSource.sessionId,
            }
          : undefined,
    };
  }

  return undefined;
}
