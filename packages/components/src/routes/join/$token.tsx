import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { WorkspaceJoinRequestSurface } from '@/components/pages/workspace-join-request-surface';
import { signOutWithoutRedirect } from '@/lib/auth';
import { useAuthClient } from '@/providers/convex-provider';

export const Route = createFileRoute('/join/$token')({
  component: WorkspaceJoinRequestRoute,
});

export function WorkspaceJoinRequestRoute() {
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const authClient = useAuthClient();

  const goToLogin = () => {
    void navigate({ to: '/login', search: { redirect: `/join/${token}`, view: 'email' } });
  };

  return (
    <WorkspaceJoinRequestSurface
      token={token}
      onSignInRequested={goToLogin}
      onEmailVerificationRequested={() => {
        void (async () => {
          await signOutWithoutRedirect(authClient);
          goToLogin();
        })();
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
