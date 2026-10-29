import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { SessionMeta } from '@lody/shared';
import { useSessionFileActions } from '@/hooks/use-session-file-actions';
import { useCodeCollabRequestedRole } from '@/hooks/use-code-collab-requested-role';
import { useCodeCollabSessionFileProvider } from '@/hooks/use-code-collab-session-file-provider';
import { createAgentFileLinkIndex, type AgentFileLinkIndex } from '@/lib/agent-file-link-index';
import { AgentFileLinkContextMenuItemsContext } from '../ai-gui/markdown-renderer';
import { AgentFileLinkIndexContext } from '../ai-gui/agent-file-link-context';

function FileLinkIndexSource({
  session,
  workspaceId,
  index,
}: {
  session: SessionMeta;
  workspaceId?: string | null;
  index: AgentFileLinkIndex;
}) {
  const requestedRole = useCodeCollabRequestedRole();
  const { provider, status } = useCodeCollabSessionFileProvider({
    sessionId: session.id,
    machineId: session.machineId,
    workspaceId,
    requestedRole,
    debugLabel: 'conversation:file-links',
  });
  useEffect(() => {
    if (!provider || (status !== 'ready' && status !== 'empty')) {
      index.setFiles([]);
      return undefined;
    }
    let active = true;
    let revision = 0;
    const unsubscribe = provider.subscribeFiles?.((files) => {
      revision += 1;
      if (active) index.setFiles(files);
    });
    const initialRevision = revision;
    void provider.listFiles().then(
      (files) => {
        if (active && revision === initialRevision) index.setFiles(files);
      },
      () => {
        if (active && revision === initialRevision) index.setFiles([]);
      }
    );
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [index, provider, status]);
  return null;
}

function FileLinkIndexLoader(props: {
  session: SessionMeta;
  workspaceId?: string | null;
  index: AgentFileLinkIndex;
  isVisible: boolean;
}) {
  const { index, isVisible } = props;
  const requested = useSyncExternalStore(
    index.subscribeDemand,
    index.isRequested,
    index.isRequested
  );
  return requested && isVisible ? <FileLinkIndexSource {...props} /> : null;
}

/**
 * Gives one conversation surface only the Markdown file-link actions its own
 * Session authorizes. In particular, a side Session must never inherit its
 * opener's local Electron capability or workspace path.
 */
export function SessionAgentFileLinkMenuProvider({
  session,
  workspaceId,
  isVisible = true,
  children,
}: {
  readonly session: SessionMeta;
  readonly workspaceId?: string | null;
  readonly isVisible?: boolean;
  readonly children: ReactNode;
}) {
  const { buildMarkdownLinkMenuItems } = useSessionFileActions({ session });
  const index = useMemo(createAgentFileLinkIndex, [
    workspaceId,
    session.id,
    session.machineId,
    session.parentSessionId,
  ]);

  return (
    <AgentFileLinkContextMenuItemsContext.Provider value={buildMarkdownLinkMenuItems}>
      <AgentFileLinkIndexContext.Provider value={index}>
        {children}
        <FileLinkIndexLoader
          session={session}
          workspaceId={workspaceId}
          index={index}
          isVisible={isVisible}
        />
      </AgentFileLinkIndexContext.Provider>
    </AgentFileLinkContextMenuItemsContext.Provider>
  );
}
