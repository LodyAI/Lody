import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import type { SessionMeta, WorkspaceId } from '@lody/shared';

import { currentWorkspaceIdAtom, userAtom } from '@/atoms';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { runtimeAtom } from '@/atoms/runtime';
import type { MentionProjectSource } from '@/components/mentions/mention-project-file-source';
import { resolveEffectiveCodeCollabWorkspaceId } from '@/lib/code-collab-workspace-id';
import { resolveSessionLocalFileSource } from '@/lib/session-local-file-source';
import { resolveSessionRepoFullName } from '@/lib/session-repo';
import { useCodeCollabSessionFileProvider } from '@/hooks/use-code-collab-session-file-provider';
import { useCodeCollabRequestedRole } from '@/hooks/use-code-collab-requested-role';

export type UseSessionMentionSourceArgs = {
  session: SessionMeta;
  /** Root path of the session's local project, when it has one. */
  sessionLocalProjectRootPath?: string | null;
  /** Whether the session's repo is public (GitHub-sourced file/index reads). */
  isRepoPublic?: boolean;
  /**
   * Gates the Code Collab file-index provider. The composer's `@` menu passes
   * `value.includes('@')` so no index is borrowed until someone could ask; an
   * editing surface that can be opened without typing `@` first (the
   * edit-and-resend editor) must pass `true` while it is visible.
   */
  enableCodeCollabProvider: boolean;
  /**
   * Extra identity for the borrower's debug label; distinguishes the composer
   * provider from the edit editor's in logs.
   */
  debugLabel: string;
};

/**
 * The single derivation of the `mentionSource` a session surface feeds to
 * `CombinedMentionTextarea` / `useMentionPromptExpansion`. The session composer
 * and the edit-and-resend editor both read `@` against the same project/worktree
 * view, so the Code Collab provider vs. local vs. GitHub precedence lives here
 * once — a second copy would let the editor offer files the send path could
 * never resolve.
 */
export function useSessionMentionSource({
  session,
  sessionLocalProjectRootPath,
  isRepoPublic,
  enableCodeCollabProvider,
  debugLabel,
}: UseSessionMentionSourceArgs): MentionProjectSource | undefined {
  const localMachineId = useAtomValue(localMachineIdAtom);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom) as WorkspaceId | null;
  const workspaceRuntime = useAtomValue(runtimeAtom);
  const currentUser = useAtomValue(userAtom);
  const effectiveWorkspaceId = resolveEffectiveCodeCollabWorkspaceId({
    currentWorkspaceId: workspaceId,
    runtimeWorkspaceId: workspaceRuntime?.workspaceId,
  });

  const sessionLocalFileSource = useMemo(
    () =>
      resolveSessionLocalFileSource(session, {
        isElectronRenderer: typeof window !== 'undefined' && window.__LODY_ELECTRON__ === true,
        localMachineId,
        workspaceId: effectiveWorkspaceId,
        localProjectRootPath: sessionLocalProjectRootPath,
      }),
    [effectiveWorkspaceId, localMachineId, session, sessionLocalProjectRootPath]
  );
  const repoFullName = useMemo(() => resolveSessionRepoFullName(session), [session]);
  const codeCollabRequestedRole = useCodeCollabRequestedRole();
  // Code Collab files live in the worktree owned by the top-level (parent)
  // session; child-session tabs share that same workspace. Look the space up
  // under the parent id so @ mentions read the owner-session v2 file tree.
  // Mirrors resolveSessionLocalFileSource and the session-detail file-tree
  // provider, which both key on the parent.
  const codeCollabSessionId = session.parentSessionId ?? session.id;
  const codeCollabMentionFiles = useCodeCollabSessionFileProvider({
    workspaceId: effectiveWorkspaceId,
    sessionId: codeCollabSessionId,
    enabled: enableCodeCollabProvider,
    requestedRole: codeCollabRequestedRole,
    machineId: session.machineId,
    requestedByUserId: currentUser?.id ?? session.userId,
    githubRepoFullName: repoFullName || null,
    debugLabel,
  });
  const codeCollabMentionFilesPending =
    codeCollabMentionFiles.status === 'checking' || codeCollabMentionFiles.status === 'loading';

  return useMemo<MentionProjectSource | undefined>(() => {
    if (codeCollabMentionFiles.provider || codeCollabMentionFilesPending) {
      return {
        kind: 'provider',
        provider: codeCollabMentionFiles.provider,
        providerPending: codeCollabMentionFilesPending,
        providerMessage: codeCollabMentionFiles.message,
        localProject:
          session.project?.kind === 'local'
            ? {
                machineId: session.machineId,
                localProjectId: session.project.localProjectId,
              }
            : undefined,
        githubRepoFullName: repoFullName || undefined,
        isPublic: isRepoPublic,
      };
    }

    const localProject =
      session.project?.kind === 'local' && effectiveWorkspaceId
        ? {
            workspaceId: effectiveWorkspaceId,
            localProjectId: session.project.localProjectId,
          }
        : null;

    if (localProject && sessionLocalFileSource?.kind === 'session-worktree') {
      return {
        kind: 'local',
        machineId: session.machineId,
        workspaceId: localProject.workspaceId,
        localProjectId: localProject.localProjectId,
        githubRepoFullName: repoFullName || undefined,
        localWorktree: {
          machineId: session.machineId,
          repoKey: sessionLocalFileSource.repoKey,
          sessionId: sessionLocalFileSource.sessionId,
        },
      };
    }

    if (sessionLocalFileSource?.kind === 'local-project') {
      return {
        kind: 'local',
        machineId: session.machineId,
        workspaceId: sessionLocalFileSource.workspaceId,
        localProjectId: sessionLocalFileSource.localProjectId,
        githubRepoFullName: repoFullName || undefined,
      };
    }

    if (repoFullName) {
      return {
        kind: 'github',
        repoFullName,
        isPublic: isRepoPublic,
        localWorktree:
          sessionLocalFileSource?.kind === 'session-worktree'
            ? {
                machineId: session.machineId,
                repoKey: sessionLocalFileSource.repoKey,
                sessionId: sessionLocalFileSource.sessionId,
              }
            : undefined,
      };
    }

    return undefined;
  }, [
    codeCollabMentionFiles.message,
    codeCollabMentionFiles.provider,
    codeCollabMentionFilesPending,
    isRepoPublic,
    repoFullName,
    effectiveWorkspaceId,
    session.machineId,
    session.project,
    sessionLocalFileSource,
  ]);
}
