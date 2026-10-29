import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SessionMeta } from '@lody/shared';
import { useSessionFileActions } from '@/hooks/use-session-file-actions';
import { useCodeCollabRequestedRole } from '@/hooks/use-code-collab-requested-role';
import { useCodeCollabSessionFileProvider } from '@/hooks/use-code-collab-session-file-provider';
import { createAgentFileLinkIndex, type AgentFileLinkIndex } from '@/lib/agent-file-link-index';
import type { SessionFileProviderEntry } from '@/lib/session-file-provider';
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
    const update = (files: readonly SessionFileProviderEntry[]) => {
      if (active) index.setFiles(files);
    };
    const unsubscribe = provider.subscribeFiles?.(update);
    if (!provider.subscribeFiles) void provider.listFiles().then(update, () => update([]));
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [index, provider, status]);
  return null;
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
  const scope = JSON.stringify([
    workspaceId,
    session.id,
    session.machineId,
    session.parentSessionId,
  ]);
  const [requestedScope, setRequestedScope] = useState<string>();
  const index = useMemo(() => createAgentFileLinkIndex(() => setRequestedScope(scope)), [scope]);

  return (
    <AgentFileLinkContextMenuItemsContext.Provider value={buildMarkdownLinkMenuItems}>
      <AgentFileLinkIndexContext.Provider value={index}>
        {children}
        {isVisible && requestedScope === scope ? (
          <FileLinkIndexSource session={session} workspaceId={workspaceId} index={index} />
        ) : null}
      </AgentFileLinkIndexContext.Provider>
    </AgentFileLinkContextMenuItemsContext.Provider>
  );
}
