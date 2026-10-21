import type { ReactNode } from 'react';
import type { SessionMeta } from '@lody/shared';
import { useSessionFileActions } from '@/hooks/use-session-file-actions';
import { AgentFileLinkContextMenuItemsContext } from '../ai-gui/markdown-renderer';
import { FileLinkCandidateDialog } from './file-link-candidate-dialog';

/**
 * Gives one conversation surface only the Markdown file-link actions its own
 * Session authorizes. In particular, a side Session must never inherit its
 * opener's local Electron capability or workspace path.
 */
export function SessionAgentFileLinkMenuProvider({
  session,
  children,
}: {
  readonly session: SessionMeta;
  readonly children: ReactNode;
}) {
  const { buildMarkdownLinkMenuItems, markdownLinkChoice } = useSessionFileActions({ session });

  return (
    <AgentFileLinkContextMenuItemsContext.Provider value={buildMarkdownLinkMenuItems}>
      {children}
      {markdownLinkChoice ? (
        <FileLinkCandidateDialog
          candidates={markdownLinkChoice.candidates}
          onClose={() => markdownLinkChoice.choose(null)}
          onSelect={(candidate) => markdownLinkChoice.choose(candidate)}
        />
      ) : null}
    </AgentFileLinkContextMenuItemsContext.Provider>
  );
}
