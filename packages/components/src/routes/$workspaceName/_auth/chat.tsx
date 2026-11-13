import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { ChatLanding } from '@/components/chat/chat-landing';
import {
  parseChatLandingSearch,
  type ChatLandingSearch,
} from '@/components/chat/chat-landing-derived';
import { useIsMobile } from '@/hooks/use-mobile';
import { developerModeEnabledAtom, mobileWorkspaceBaseContextAtom } from '@/atoms';
import { ProjectBoard } from '@/components/project-mode/project-board';
import type { CoordinatorProjectKey } from '@/components/project-mode/project-board-model';
import { ProjectWorkspace } from '@/components/project-mode/project-workspace';
import type { MachineId } from '@lody/shared';

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
  const developerMode = useAtomValue(developerModeEnabledAtom);

  // Selection steering is an in-place correction of the current address, not
  // a visit to a new page, so the mirror always replaces.
  const handleSelectionUrlSync = useCallback(
    (selectionSearch: ChatLandingSearch) => {
      void navigate({
        search: search.coordinator ? { ...selectionSearch, coordinator: true } : selectionSearch,
        replace: true,
      });
    },
    [navigate, search.coordinator]
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

  const landing = (
    <ChatLanding
      workspaceSlug={workspaceName}
      preSelectedContext={search.context}
      preSelectedMachine={search.machine}
      preSelectedProject={search.project}
      preSelectedRepo={search.repo}
      preSelectedGroup={search.group}
      coordinator={search.coordinator === true}
      onSelectionUrlSync={handleSelectionUrlSync}
    />
  );
  // Project mode prototype: starting a coordinator already shows the project's conversations.
  const boardProject =
    developerMode && search.coordinator ? coordinatorProjectFromSearch(search) : null;
  return (
    <div className="h-full" data-window-workspace-ready={workspaceName}>
      {boardProject ? (
        <ProjectWorkspace
          main={landing}
          board={<ProjectBoard coordinatorSessionId={null} project={boardProject} />}
        />
      ) : (
        landing
      )}
    </div>
  );
}

function coordinatorProjectFromSearch(search: ChatLandingSearch): CoordinatorProjectKey | null {
  if (search.context === 'local' && search.machine && search.project) {
    return {
      kind: 'local',
      machineId: search.machine as MachineId,
      localProjectId: search.project,
    };
  }
  if (search.context === 'github' && search.repo) {
    return { kind: 'github', repoFullName: search.repo };
  }
  return null;
}
