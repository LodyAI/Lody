import { createFileRoute, notFound, Outlet, redirect } from '@tanstack/react-router';
import { BootNavigate } from '@/components/boot-navigate';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useOrganization } from '@/hooks/useOrganization';
import { useStableSession } from '@/hooks/useStableSession';
import { useCloudQuery, usePlatform } from '@lody/platform/react';
import { useAtomValue, useSetAtom } from 'jotai';
import { workspaceContentModeAtom } from '@/atoms/workspace-content-mode';
import { userAtom } from '@/atoms';
import { workspaceModeAdmissionRetryAtom, workspaceRuntimeInitFailureAtom } from '@/atoms/runtime';
import { WorkspaceModeAdmissionTimeoutError } from '../providers/workspace-mode-admission';
import { E2eeClientUpgradeRequiredError } from '../providers/cloud-e2ee-workspaces';
import {
  E2eeLocalEvidenceConflictError,
  E2eeLocalEvidenceCorruptError,
  repairUnreadableE2eeCaches,
} from '@/lib/e2ee-workspace-storage';
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
import { BlockingWaitPlaceholder } from '@/components/blocking-wait-placeholder';
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
        gate="workspace_list_error"
        title={t('workspace.route.loadingWorkspacesErrorTitle')}
        description={t('workspace.route.loadingWorkspacesErrorDescription')}
      />
    );
  }

  if (!workspace) {
    return (
      <BlockingWaitPlaceholder
        gate="local_workspace_starting"
        variant="boot"
        title={t('workspace.route.localStartingTitle')}
        description={t('workspace.route.localStartingDescription')}
      />
    );
  }

  // A stale or hand-typed slug still refers to the only workspace; converge on
  // its canonical slug instead of rendering under a mismatched URL.
  const canonicalSlug = getLocalWorkspaceSlug(workspace);
  if (workspaceName !== canonicalSlug) {
    return (
      <BootNavigate to="/$workspaceName/chat" params={{ workspaceName: canonicalSlug }} replace />
    );
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
        <BootNavigate to="/$workspaceName/chat" params={{ workspaceName: fallback.slug }} replace />
      );
    }

    if (fallback.kind === 'create-workspace') {
      return <BootNavigate to="/workspace/create" replace />;
    }

    return (
      <BlockingWaitPlaceholder
        gate="workspace_access_denied_fallback"
        variant="boot"
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
    // The root sign-out path redirects from here; if it never does, this wait
    // still has to offer a way out.
    return (
      <BlockingWaitPlaceholder
        gate="sign_out_pending"
        variant="boot"
        title={t('workspace.route.signingInTitle')}
      />
    );
  }

  if (hasLocalToken) {
    // Only redirect to login if the server explicitly confirmed no user session.
    // Do NOT redirect on network/transient errors - the user can still use cached data
    // and the sidebar will show offline status.
    if (sessionSettled && !isPending && !isRetrying && !sessionError && !session?.user) {
      const currentPath = getAppCurrentPathWithSearch();
      return <BootNavigate to="/login" search={{ redirect: currentPath }} replace />;
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
      <BlockingWaitPlaceholder
        gate="session_loading"
        variant="boot"
        title={t('workspace.route.signingInTitle')}
        description={t('workspace.route.signingInDescription')}
      />
    );
  }

  if (!session?.user || sessionError) {
    const currentPath = getAppCurrentPathWithSearch();
    return <BootNavigate to="/login" search={{ redirect: currentPath }} replace />;
  }

  if (isPending || isRetrying || access === undefined) {
    return (
      <BlockingWaitPlaceholder
        gate="workspace_access_loading"
        variant="boot"
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
      <BlockingWaitPlaceholder
        gate="session_loading"
        variant="boot"
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

function admissionFailureHelp(errorType: string): string {
  switch (errorType) {
    case WorkspaceModeAdmissionTimeoutError.name:
      return 'e2ee.mode.timedOutHelp';
    case E2eeLocalEvidenceCorruptError.name:
      return 'e2ee.mode.localCorruptHelp';
    case E2eeLocalEvidenceConflictError.name:
      return 'e2ee.mode.localConflictHelp';
    case E2eeClientUpgradeRequiredError.name:
      return 'e2ee.mode.upgradeHelp';
    default:
      return 'e2ee.mode.failedHelp';
  }
}

function WorkspaceAuthedRoute(props: Parameters<typeof PlaintextWorkspaceAuthedRoute>[0]) {
  const platform = usePlatform();
  const mode = useAtomValue(workspaceContentModeAtom);
  const user = useAtomValue(userAtom);
  const failure = useAtomValue(workspaceRuntimeInitFailureAtom);
  const retryAdmission = useSetAtom(workspaceModeAdmissionRetryAtom);
  const { t } = useTranslation();
  if (platform.e2eeWorkspaces) {
    if (!mode || mode.workspaceSlug !== props.workspaceName || mode.accountId !== user?.id) {
      return failure?.workspaceSlug === props.workspaceName ? (
        <RouteMessage
          gate="workspace_content_mode"
          title={t('e2ee.mode.failed')}
          description={t(admissionFailureHelp(failure.errorType))}
          onRetry={() => {
            // Unreadable optional caches cannot help any later attempt. Sticky
            // encrypted evidence and conflicting records are never removed here.
            if (failure.errorType === E2eeLocalEvidenceCorruptError.name && user?.id)
              repairUnreadableE2eeCaches(localStorage, user.id);
            retryAdmission((value) => value + 1);
          }}
        />
      ) : (
        <BlockingWaitPlaceholder
          gate="workspace_content_mode"
          variant="boot"
          title={t('e2ee.mode.loading')}
        />
      );
    }
    if ('contentMode' in mode.descriptor && mode.descriptor.contentMode === 'e2ee') {
      return (
        <BootNavigate
          to="/workspace/e2ee/$workspaceId"
          params={{ workspaceId: mode.workspaceId }}
          replace
        />
      );
    }
  }
  return <PlaintextWorkspaceAuthedRoute {...props} />;
}

function PlaintextWorkspaceAuthedRoute({
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
          <BootNavigate
            to="/$workspaceName/chat"
            params={{ workspaceName: fallbackSlug }}
            replace
          />
        );
      }
      return <BootNavigate to="/workspace/create" replace />;
    }

    if (optimisticGuard === 'switch-error') {
      return (
        <RouteMessage
          gate="workspace_switch_error"
          title={t('workspace.route.openErrorTitle')}
          description={t('workspace.route.openErrorDescription')}
        />
      );
    }

    if (optimisticGuard === 'wait-for-switch') {
      return (
        <BlockingWaitPlaceholder
          gate="workspace_switch_pending"
          variant="boot"
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
      <BlockingWaitPlaceholder
        gate="workspace_list_loading"
        variant="boot"
        title={t('workspace.route.loadingWorkspacesTitle')}
        description={t('workspace.route.loadingWorkspacesDescription')}
      />
    );
  }

  const hasOrganizations = Array.isArray(organizations);
  if (organizationsLoading || !hasOrganizations) {
    return (
      <BlockingWaitPlaceholder
        gate="workspace_list_loading"
        variant="boot"
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
        <BootNavigate to="/$workspaceName/chat" params={{ workspaceName: fallbackSlug }} replace />
      );
    }
    return <BootNavigate to="/workspace/create" replace />;
  }

  if (workspaceGuard === 'switch-error') {
    return (
      <RouteMessage
        gate="workspace_switch_error"
        title={t('workspace.route.openErrorTitle')}
        description={t('workspace.route.openErrorDescription')}
      />
    );
  }

  if (workspaceGuard === 'wait-for-switch') {
    return (
      <BlockingWaitPlaceholder
        gate="workspace_switch_pending"
        variant="boot"
        title={t('workspace.route.switchingTitle')}
        description={t('workspace.route.switchingDescription')}
      />
    );
  }

  return <Outlet />;
}
