import { createFileRoute, Navigate, Outlet, useMatchRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/$workspaceName/_auth/sessions')({
  component: SessionsRoute,
});

function SessionsRoute() {
  const matchRoute = useMatchRoute();
  const { workspaceName } = Route.useParams();

  // Check if we're on the exact /machines route
  const isExactRoute = matchRoute({
    to: '/$workspaceName/sessions',
    params: { workspaceName },
  });

  // If we're not on the exact route (i.e., on a child route like /machines/$machineId), render the Outlet
  if (!isExactRoute) {
    return <Outlet />;
  }

  return <Navigate to="/$workspaceName/chat" params={{ workspaceName }} replace />;
}
