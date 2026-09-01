import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { ChatLanding } from '@/components/chat/chat-landing';
import {
  parseChatLandingSearch,
  type ChatLandingSearch,
} from '@/components/chat/chat-landing-derived';
import { useIsMobile } from '@/hooks/use-mobile';
import { mobileWorkspaceBaseContextAtom } from '@/atoms';

export type ChatSearch = ChatLandingSearch;

export const Route = createFileRoute('/$workspaceName/_auth/chat')({
  component: ChatRoute,
  validateSearch: parseChatLandingSearch,
});

function ChatRoute() {
  const { workspaceName } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const isMobile = useIsMobile();
  const setMobileBaseContext = useSetAtom(mobileWorkspaceBaseContextAtom);

  // Selection steering is an in-place correction of the current address, not
  // a visit to a new page, so the mirror always replaces.
  const handleSelectionUrlSync = useCallback(
    (selectionSearch: ChatLandingSearch) => {
      void navigate({ search: selectionSearch, replace: true });
    },
    [navigate]
  );

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
      onSelectionUrlSync={handleSelectionUrlSync}
    />
  );
}
