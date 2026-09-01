import { createFileRoute, Navigate, notFound, Outlet, redirect } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useOrganization } from '@/hooks/useOrganization';
import { useStableSession } from '@/hooks/useStableSession';
import { useCloudQuery } from '@lody/platform/react';
import { cloudOperations } from '@/lib/cloud-api-operations';
import {
  clearPreferredWorkspaceSlugIfMatch,
  getPreferredWorkspaceSlug,
  readPreferredWorkspaceSlug,
} from '@/lib/workspace';
import { useWorkspaceContextAtoms } from '@/hooks/use-workspace-context-atoms';
import { getAppCurrentPathWithSearch } from '@/lib/app-location';
import {
  clearWorkspaceAccessDenied,
  recordWorkspaceAccessDenied,
  resolveOptimisticWorkspaceRouteGuard,
  resolveWorkspaceAccessDeniedFallback,
} from '@/lib/workspace-route-guard';
import { RouteMessage } from '@/components/route-message';
import { LoadingPlaceholder } from '@/components/loading-placeholder';
import { clearLastAppRoutePathIfWorkspaceMatch } from '@/lib/last-app-route';
import {
  WORKSPACE_SLUG_RESERVED_LANDING_EXACT_PATHS,
  WORKSPACE_SLUG_RESERVED_LANDING_PREFIXES,
} from '@lody/shared';
import { isLocalAppPlatform } from '@/lib/app-platform';
import { WorkspaceRouteTargetProvider } from '../providers/workspace-route-target';
import {
  getLocalWorkspaceSlug,
  useLocalPlatformWorkspacesState,
} from '../providers/local-platform-provider';

// Paths that are served by the CF Pages middleware as landing pages.
// If a client-side navigation targets one of these, we must do a full page
// reload so the middleware can serve the correct content.
// Keep in sync with LANDING_PATH_PREFIXES / LANDING_EXACT_PATHS in
// functions/_middleware.ts.
const LANDING_PATH_PREFIXES: readonly string[] = WORKSPACE_SLUG_RESERVED_LANDING_PREFIXES;
const LANDING_EXACT_NAMES = new Set<string>(WORKSPACE_SLUG_RESERVED_LANDING_EXACT_PATHS);

/**
 * Determine whether the current pathname should be served by the CF Pages
 * middleware as a landing page. Must stay in sync with `isLandingPath` in
 * `functions/_middleware.ts`.
 *
 * For **prefix** landing names (`docs`, `blog`, …) the middleware serves
 * the entire subtree, so any sub-path is a valid redirect target.
 *
 * For **exact** landing names (`home`, `price`, `download`, ...) the middleware only serves
 * the root path (`/home`, `/price`). Deeper paths like `/home/foo/bar`
 * are *not* recognised by the middleware and would fall back to the App SPA,
 * creating an infinite reload loop if we redirect with `reloadDocument`.
 */
function shouldRedirectToLanding(workspaceName: string, pathname: string): boolean {
  if (LANDING_PATH_PREFIXES.includes(workspaceName)) {
    return true;
  }
  if (LANDING_EXACT_NAMES.has(workspaceName)) {
    const stripped = pathname.endsWith('/') && pathname !== '/' ? pathname.slice(0, -1) : pathname;
    return stripped === `/${workspaceName}`;
  }
  return false;
}

function isLandingWorkspaceName(name: string): boolean {
  if (LANDING_EXACT_NAMES.has(name)) return true;
  if (LANDING_PATH_PREFIXES.includes(name)) return true;
  return false;
}

export const Route = createFileRoute('/$workspaceName')({
  beforeLoad: ({ params, location }) => {
    if (shouldRedirectToLanding(params.workspaceName, location.pathname)) {
      // Force full-page navigation so the CF Pages middleware serves the
      // landing page instead of the App SPA treating it as a workspace.
      // Use the full target href to preserve deep links like /docs/quickstart.
      if (typeof window !== 'undefined') {
        throw redirect({ href: location.href, reloadDocument: true });
      }
      throw redirect({ to: '/' });
    }
    // The workspace name collides with a landing-page name but the full path
    // is not a valid landing URL (e.g. /home/foo/bar). There is no workspace
    // with this name, so surface a 404 immediately instead of entering the
    // workspace guard flow (which would show loading spinners then redirect).
    if (isLandingWorkspaceName(params.workspaceName)) {
      throw notFound();
    }
  },
  component: WorkspaceGuardRoute,
});

function WorkspaceGuardRoute() {
  const { workspaceName } = Route.useParams();
  // The URL target is available during render, before workspace atoms and
  // runtime effects converge. Descendants use it to reject previous-scope data.
  return (
    <WorkspaceRouteTargetProvider slug={workspaceName}>
      {isLocalAppPlatform() ? <LocalWorkspaceGuardRoute /> : <CloudWorkspaceGuardRoute />}
    </WorkspaceRouteTargetProvider>
  );
}

function LocalWorkspaceGuardRoute() {
  const { t } = useTranslation();
  const { workspaceName } = Route.useParams();
  const workspacesState = useLocalPlatformWorkspacesState();
  const workspace =
    workspacesState.status === 'ready' ? (workspacesState.workspaces[0] ?? null) : null;

  // Establish the workspace-context atoms from the implicit workspace: the
  // runtime provider keys off these atoms, not the router.
  useWorkspaceContextAtoms(
    workspaceName,
    workspace ? { status: 'member', organizationId: workspace.id } : undefined
  );

  if (workspacesState.status === 'error') {
    return (
      <RouteMessage
        title={t('workspace.route.loadingWorkspacesErrorTitle')}
        description={t('workspace.route.loadingWorkspacesErrorDescription')}
      />
    );
  }

  if (!workspace) {
    return (
      <LoadingPlaceholder
        title={t('workspace.route.localStartingTitle')}
        description={t('workspace.route.localStartingDescription')}
      />
    );
  }

  // A stale or hand-typed slug still refers to the only workspace; converge on
  // its canonical slug instead of rendering under a mismatched URL.
  const canonicalSlug = getLocalWorkspaceSlug(workspace);
  if (workspaceName !== canonicalSlug) {
    return <Navigate to="/$workspaceName/chat" params={{ workspaceName: canonicalSlug }} replace />;
  }

  return <Outlet />;
}

function CloudWorkspaceGuardRoute() {
  const { t } = useTranslation();
  const { workspaceName } = Route.useParams();
  const {
    data: session,
    confirmedUnauthenticated,
    hasLocalToken,
    isPending,
    isRetrying,
    error: sessionError,
  } = useStableSession();
  const {
    organizations,
    organizationsLoading,
    activeOrganization,
    error: organizationsError,
  } = useOrganization({ targetSlug: workspaceName });
  const access = useCloudQuery(cloudOperations.auth.getWorkspaceAccessBySlug, {
    slug: workspaceName,
  });
  const [sessionSettled, setSessionSettled] = useState(!isPending);
  const preferredWorkspaceSlug = readPreferredWorkspaceSlug();

  useEffect(() => {
    if (!isPending) setSessionSettled(true);
  }, [isPending]);

  // Establish the workspace-context atoms (slug + id) from the URL param.
  useWorkspaceContextAtoms(workspaceName, access);

  // A confirmed membership clears this slug from the denied-fallback memory,
  // so a re-invite restores automatic fallback TO this workspace.
  useEffect(() => {
    if (access?.status === 'member') {
      clearWorkspaceAccessDenied(workspaceName);
    }
  }, [access?.status, workspaceName]);

  const renderWorkspaceAccessDeniedFallback = () => {
    clearLastAppRoutePathIfWorkspaceMatch(workspaceName);
    clearPreferredWorkspaceSlugIfMatch(workspaceName);
    /* Both callers gate on a DEFINITIVE denial (`not_found` / `not_member`),
       so recording here cannot poison the set with transient errors. The set
       is what keeps a stale org list from bouncing between two denied
       workspaces forever — see `resolveWorkspaceAccessDeniedFallback`. */
    recordWorkspaceAccessDenied(workspaceName);
    const fallback = resolveWorkspaceAccessDeniedFallback({
      workspaceName,
      organizations,
      activeOrganization,
      preferredWorkspaceSlug,
    });

    if (fallback.kind === 'workspace') {
      return (
        <Navigate to="/$workspaceName/chat" params={{ workspaceName: fallback.slug }} replace />
      );
    }

    if (fallback.kind === 'create-workspace') {
      return <Navigate to="/workspace/create" replace />;
    }

    return (
      <LoadingPlaceholder
        title={t('workspace.route.loadingWorkspacesTitle')}
        description={t('workspace.route.loadingWorkspacesDescription')}
      />
    );
  };

  // ==========================================================================
  // OPTIMISTIC RENDERING PATH (hasLocalToken = true)
  // ==========================================================================
  // When user has a locally cached auth token, we skip blocking loading states
  // and render content immediately for better perceived performance.
  //
  // Key behaviors:
  // 1. access === undefined (not yet loaded):
  //    → Show content immediately, auth verification happens in background
  //    → Sidebar shows loading/offline status via ConnectionPill
  //
  // 2. access.status === 'member':
  //    → Show content (user has access)
  //
  // 3. access.status === 'unauthenticated':
  //    → Treat as provisional while auth providers finish syncing
  //    → Root auth invalidation handles the real expired-session redirect
  //
  // 4. access.status === 'not_found' | 'not_member':
  //    → Server confirmed NO access - MUST NOT show workspace content
  //    → Redirect to another accessible workspace once the workspace list is ready
  //
  // The critical distinction: we only skip loading states when access is
  // UNKNOWN. Once server confirms denial, we block rendering to prevent
  // unauthorized access to workspace UI.
  // ==========================================================================
  if (confirmedUnauthenticated) {
    return null;
  }

  if (hasLocalToken) {
    // Only redirect to login if the server explicitly confirmed no user session.
    // Do NOT redirect on network/transient errors - the user can still use cached data
    // and the sidebar will show offline status.
    if (sessionSettled && !isPending && !isRetrying && !sessionError && !session?.user) {
      const currentPath = getAppCurrentPathWithSearch();
      return <Navigate to="/login" search={{ redirect: currentPath }} replace />;
    }

    // Check access denial only when we have confirmed access response
    if (access !== undefined) {
      // IMPORTANT: When server confirms no access, we MUST block rendering.
      // Clear the stale preferred slug to prevent redirect loops from index route.
      if (access.status === 'not_found' || access.status === 'not_member') {
        return renderWorkspaceAccessDeniedFallback();
      }
    }

    // access is undefined, 'member', or still 'unauthenticated' while auth sync finishes
    // Show content immediately - loading/offline states are displayed in the sidebar
    return (
      <WorkspaceAuthedRoute
        workspaceName={workspaceName}
        organizations={organizations}
        organizationsLoading={organizationsLoading}
        activeOrganization={activeOrganization}
        organizationsError={organizationsError}
        preferredWorkspaceSlug={preferredWorkspaceSlug}
        hasLocalToken={true}
        serverAccessConfirmed={access?.status === 'member'}
      />
    );
  }

  // No local token - use the original loading flow
  if (!sessionSettled) {
    return (
      <LoadingPlaceholder
        title={t('workspace.route.signingInTitle')}
        description={t('workspace.route.signingInDescription')}
      />
    );
  }

  if (!session?.user || sessionError) {
    const currentPath = getAppCurrentPathWithSearch();
    return <Navigate to="/login" search={{ redirect: currentPath }} replace />;
  }

  if (isPending || isRetrying || access === undefined) {
    return (
      <LoadingPlaceholder
        title={t('workspace.route.accessLoadingTitle')}
        description={t('workspace.route.accessLoadingDescription')}
      />
    );
  }

  if (access.status === 'not_found' || access.status === 'not_member') {
    return renderWorkspaceAccessDeniedFallback();
  }

  if (access.status === 'unauthenticated') {
    return (
      <LoadingPlaceholder
        title={t('workspace.route.signingInTitle')}
        description={t('workspace.route.signingInDescription')}
      />
    );
  }

  return (
    <WorkspaceAuthedRoute
      workspaceName={workspaceName}
      organizations={organizations}
      organizationsLoading={organizationsLoading}
      activeOrganization={activeOrganization}
      organizationsError={organizationsError}
      preferredWorkspaceSlug={preferredWorkspaceSlug}
      hasLocalToken={false}
      serverAccessConfirmed={access.status === 'member'}
    />
  );
}

function WorkspaceAuthedRoute({
  workspaceName,
  organizations,
  organizationsLoading,
  activeOrganization,
  organizationsError,
  preferredWorkspaceSlug,
  hasLocalToken,
  serverAccessConfirmed,
}: {
  workspaceName: string;
  organizations: ReturnType<typeof useOrganization>['organizations'];
  organizationsLoading: ReturnType<typeof useOrganization>['organizationsLoading'];
  activeOrganization: ReturnType<typeof useOrganization>['activeOrganization'];
  organizationsError: ReturnType<typeof useOrganization>['error'];
  preferredWorkspaceSlug: string | null;
  hasLocalToken: boolean;
  serverAccessConfirmed: boolean;
}) {
  const { t } = useTranslation();
  const [orgSettled, setOrgSettled] = useState(!organizationsLoading);

  useEffect(() => {
    if (!organizationsLoading) setOrgSettled(true);
  }, [organizationsLoading]);

  // If we have a local token, skip loading states and show content immediately.
  // Loading/offline states are displayed in the sidebar instead.
  if (hasLocalToken) {
    const optimisticGuard = resolveOptimisticWorkspaceRouteGuard({
      workspaceName,
      organizations,
      activeOrganization,
      error: organizationsError,
      serverAccessConfirmed,
    });

    if (optimisticGuard === 'redirect') {
      const preferredSlug = getPreferredWorkspaceSlug(
        activeOrganization,
        organizations,
        preferredWorkspaceSlug
      );
      const fallbackSlug =
        preferredSlug && preferredSlug !== workspaceName
          ? preferredSlug
          : (organizations?.find((org) => org.slug && org.slug !== workspaceName)?.slug ?? null);

      if (fallbackSlug) {
        return (
          <Navigate to="/$workspaceName/chat" params={{ workspaceName: fallbackSlug }} replace />
        );
      }
      return <Navigate to="/workspace/create" replace />;
    }

    if (optimisticGuard === 'switch-error') {
      return (
        <RouteMessage
          title={t('workspace.route.openErrorTitle')}
          description={t('workspace.route.openErrorDescription')}
        />
      );
    }

    if (optimisticGuard === 'wait-for-switch') {
      return (
        <LoadingPlaceholder
          title={t('workspace.route.switchingTitle')}
          description={t('workspace.route.switchingDescription')}
        />
      );
    }

    // Show content immediately - loading/offline states are displayed in the sidebar
    return <Outlet />;
  }

  // No local token - use the original loading flow
  if (!orgSettled) {
    return (
      <LoadingPlaceholder
        title={t('workspace.route.loadingWorkspacesTitle')}
        description={t('workspace.route.loadingWorkspacesDescription')}
      />
    );
  }

  const hasOrganizations = Array.isArray(organizations);
  if (organizationsLoading || !hasOrganizations) {
    return (
      <LoadingPlaceholder
        title={t('workspace.route.loadingWorkspacesTitle')}
        description={t('workspace.route.loadingWorkspacesDescription')}
      />
    );
  }

  const workspaceGuard = resolveOptimisticWorkspaceRouteGuard({
    workspaceName,
    organizations,
    activeOrganization,
    error: organizationsError,
    serverAccessConfirmed,
  });

  if (workspaceGuard === 'redirect') {
    const preferredSlug = getPreferredWorkspaceSlug(
      activeOrganization,
      organizations,
      preferredWorkspaceSlug
    );
    const fallbackSlug =
      preferredSlug && preferredSlug !== workspaceName
        ? preferredSlug
        : (organizations.find((org) => org.slug && org.slug !== workspaceName)?.slug ?? null);

    if (fallbackSlug) {
      return (
        <Navigate to="/$workspaceName/chat" params={{ workspaceName: fallbackSlug }} replace />
      );
    }
    return <Navigate to="/workspace/create" replace />;
  }

  if (workspaceGuard === 'switch-error') {
    return (
      <RouteMessage
        title={t('workspace.route.openErrorTitle')}
        description={t('workspace.route.openErrorDescription')}
      />
    );
  }

  if (workspaceGuard === 'wait-for-switch') {
    return (
      <LoadingPlaceholder
        title={t('workspace.route.switchingTitle')}
        description={t('workspace.route.switchingDescription')}
      />
    );
  }

  return <Outlet />;
}
