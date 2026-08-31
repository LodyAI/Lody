import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { WorkspaceJoinRequestSurface } from '@/components/pages/workspace-join-request-surface';

export const Route = createFileRoute('/join/$token')({
  component: WorkspaceJoinRequestRoute,
});

export function WorkspaceJoinRequestRoute() {
  const { token } = Route.useParams();
  const navigate = useNavigate();

  return (
    <WorkspaceJoinRequestSurface
      token={token}
      onSignInRequested={() => {
        void navigate({ to: '/login', search: { redirect: `/join/${token}`, view: 'email' } });
      }}
      onWorkspaceRequested={(workspaceSlug) => {
        if (workspaceSlug) {
          void navigate({
            to: '/$workspaceName/chat',
            params: { workspaceName: workspaceSlug },
          });
          return;
        }
        void navigate({ to: '/' });
      }}
      onHomeRequested={() => void navigate({ to: '/' })}
    />
  );
}
