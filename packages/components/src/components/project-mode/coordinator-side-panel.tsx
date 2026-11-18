import {
  getSessionRoomId,
  resolveProjectGitHubRepo,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { atom, useAtomValue } from 'jotai';
import { useMemo } from 'react';
import { userAtom } from '@/atoms';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import { useCodeCollabRequestedRole } from '@/hooks/use-code-collab-requested-role';
import { useCodeCollabSessionFileProvider } from '@/hooks/use-code-collab-session-file-provider';
import { resolveEffectiveCodeCollabWorkspaceId } from '@/lib/code-collab-workspace-id';
import { SessionFileContentView } from '@/components/sessions/session-file-content-view';

/**
 * Project mode keeps the coordinator's board as a resident tab of the session's
 * right side panel. It is never persisted: the stored side-panel state names
 * only the shared fixed panels, so the board is re-selected on entry instead.
 */
export const PROJECT_BOARD_PANEL_TAB_ID = 'project-board';

/**
 * Conversations opened from the board into the coordinator's right panel. They
 * are independent Sessions (own machine, workspace and lifecycle), shown in the
 * panel the way a Side Chat is; closing the tab never deletes them.
 */
export function usePanelSessionMetas(sessionIds: readonly SessionId[]): SessionMeta[] {
  const key = sessionIds.join('\n');
  const metasAtom = useMemo(() => {
    const ids = key ? (key.split('\n') as SessionId[]) : [];
    let previous: SessionMeta[] = [];
    return atom((get) => {
      const next = ids.flatMap((id) => {
        const meta = get(sessionMetaAtomFamily(getSessionRoomId(id)));
        return meta ? [meta] : [];
      });
      if (next.length === previous.length && next.every((meta, i) => meta === previous[i])) {
        return previous;
      }
      previous = next;
      return next;
    });
  }, [key]);
  return useAtomValue(metasAtom);
}

/**
 * A file tab opened from a conversation hosted in the panel. It reads that
 * conversation's own workspace, so a child running in another worktree or on
 * another machine never shows the coordinator's copy of the path.
 */
export function OwnedSessionFileViewer({
  ownerSessionId,
  filePath,
  startLine,
  endLine,
  focusRequestSeq,
  htmlPreviewRequestSeq,
  active,
  className,
}: {
  ownerSessionId: SessionId;
  filePath: string;
  startLine?: number;
  endLine?: number;
  focusRequestSeq?: number;
  htmlPreviewRequestSeq?: number;
  active: boolean;
  className?: string;
}) {
  const session = useAtomValue(sessionMetaAtomFamily(getSessionRoomId(ownerSessionId)));
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom) as WorkspaceId | null;
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const user = useAtomValue(userAtom);
  const requestedRole = useCodeCollabRequestedRole();
  const workspaceId = resolveEffectiveCodeCollabWorkspaceId({
    currentWorkspaceId,
    runtimeWorkspaceId: runtime?.workspaceId,
  });
  const files = useCodeCollabSessionFileProvider({
    workspaceId,
    sessionId: ownerSessionId,
    enabled: Boolean(session && workspaceId),
    requestedRole,
    machineId: session?.machineId,
    requestedByUserId: user?.id ?? session?.userId,
    githubRepoFullName:
      (resolveProjectGitHubRepo(session?.project) ?? session?.repoFullName)?.trim() ?? null,
    debugLabel: 'project-mode:owned-file',
  });
  if (!session) return null;
  return (
    <SessionFileContentView
      key={`${ownerSessionId}:${filePath}`}
      sessionId={ownerSessionId}
      session={session}
      filePath={filePath}
      startLine={startLine}
      endLine={endLine}
      focusRequestSeq={focusRequestSeq}
      htmlPreviewRequestSeq={htmlPreviewRequestSeq}
      className={className}
      active={active}
      fileProvider={files.provider}
      fileProviderPending={!files.provider && files.status === 'checking'}
      {...(files.role === undefined ? {} : { fileProviderRole: files.role })}
    />
  );
}
