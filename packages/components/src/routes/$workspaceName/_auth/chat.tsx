import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { ChatLanding } from '@/components/chat/chat-landing';
import { useIsMobile } from '@/hooks/use-mobile';
import { mobileWorkspaceBaseContextAtom } from '@/atoms';

export type ChatSearch = {
  context?: 'local' | 'github' | 'chat';
  machine?: string;
  project?: string;
  repo?: string;
  resetDraftKey?: string;
  /** Makes a repeated project-row selection a fresh composer intent. */
  projectSelection?: string;
};

export const Route = createFileRoute('/$workspaceName/_auth/chat')({
  component: ChatRoute,
  validateSearch: (search: Record<string, unknown>): ChatSearch => ({
    context:
      search.context === 'local' || search.context === 'github' || search.context === 'chat'
        ? search.context
        : undefined,
    machine: typeof search.machine === 'string' ? search.machine : undefined,
    project: typeof search.project === 'string' ? search.project : undefined,
    repo: typeof search.repo === 'string' ? search.repo : undefined,
    resetDraftKey: typeof search.resetDraftKey === 'string' ? search.resetDraftKey : undefined,
    projectSelection:
      typeof search.projectSelection === 'string' ? search.projectSelection : undefined,
  }),
});

function ChatRoute() {
  const { workspaceName } = Route.useParams();
  const search = Route.useSearch();
  const isMobile = useIsMobile();
  const setMobileBaseContext = useSetAtom(mobileWorkspaceBaseContextAtom);

  /* On mobile the home/project landing is owned by `MobileWorkspaceStack` (so
     it stays mounted beneath the session overlay). Publish this route's
     context so the stack can keep rendering the right page once the user
     drills into a session and the chat search is no longer in the URL. */
  useEffect(() => {
    if (!isMobile) return;
    setMobileBaseContext({
      context: search.context,
      machine: search.machine,
      project: search.project,
      repo: search.repo,
    });
  }, [isMobile, search.context, search.machine, search.project, search.repo, setMobileBaseContext]);

  // The stack renders the landing on mobile; this route is just the context
  // publisher there. Desktop renders the landing inline.
  if (isMobile) {
    return null;
  }

  return (
    <ChatLanding
      workspaceSlug={workspaceName}
      preSelectedContext={search.context}
      preSelectedMachine={search.machine}
      preSelectedProject={search.project}
      preSelectedRepo={search.repo}
      resetDraftKey={search.resetDraftKey}
      projectSelectionKey={search.projectSelection}
    />
  );
}
