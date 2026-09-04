import { createFileRoute, Navigate, Outlet, useLocation } from '@tanstack/react-router';
import { lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useOrganization } from '@/hooks/useOrganization';
import { useAtomValue, useSetAtom } from 'jotai';
import { runtimeInitializingAtom, userAtom } from '@/atoms';
import { WorkspaceCheckoutPendingDialog } from '@/components/workspace-checkout-pending-dialog';
import { ElectronSessionCompletionNotifier } from '@/components/electron-session-completion-notifier';
import { ElectronMenuHandler } from '@/components/electron-menu-handler';
import { AppCommands } from '@/components/app-commands';
import { CommandPalette } from '@/components/commands/command-palette';
import { AutoArchivePrWatcher } from '@/components/auto-archive-pr-watcher';
import { useStableSession } from '@/hooks/useStableSession';
import { useOnlineMachineIds } from '@/hooks/use-machine-online-status';
import { usePostHog } from '@posthog/react';
import { normalizeCurrentUserFromSessionUser } from '@/lib/current-user';
import { getAppCurrentPathWithSearch } from '@/lib/app-location';
import { deriveConvexSiteUrl } from '@lody/shared';
import {
  capturePostHogActiveUser,
  capturePostHogEvent,
  detectLaunchOsFromEnv,
  getAppLaunchPerformanceProperties,
  getDurationSinceMs,
  getPerformanceNowMs,
  identifyPostHogWorkspace,
} from '@/lib/posthog-analytics';
import { identifyPostHogUser } from '@/lib/posthog-identity';
import { scheduleOneSignalTask } from '@/lib/onesignal';
import { RouteSuspense } from '@/components/route-suspense';
import { RouteMessage } from '@/components/route-message';
import { LoadingPlaceholder } from '@/components/loading-placeholder';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useFireOncePerKey } from '@/hooks/use-fire-once';
import { writeLastAppRoutePath } from '@/lib/last-app-route';
import { useWorkspaceBadge } from '@/hooks/use-workspace-badge';
import { type LodyLiveActivityBridge, useLodyLiveActivity } from '@/hooks/use-lody-live-activity';
import { isNativeIOSAppShell } from '@/lib/native-platform';
import { isLocalAppPlatform } from '@/lib/app-platform';
import { useResolvedWorkspaceScope } from '../../hooks/use-resolved-workspace-scope';
import { useBillingOverviewPreload } from '../../hooks/use-billing-overview-preload';

const AUTH_ROUTE_ONESIGNAL_LOGIN_IDLE_TIMEOUT_MS = 10_000;

const LazyMainLayout = lazy(async () => {
  const module = await import('@/components/main-layout');
  return { default: module.MainLayout };
});

function normalizeConvexSiteUrl(rawUrl: string | undefined): string | null {
  const trimmed = rawUrl?.trim();
  if (!trimmed) {
    return null;
  }
  return deriveConvexSiteUrl(trimmed);
}

function resolveLiveActivityPermissionActionsConvexSiteUrl(): string | null {
  return normalizeConvexSiteUrl(
    import.meta.env.VITE_CONVEX_SITE_URL || import.meta.env.VITE_CONVEX_DEPLOY_URL
  );
}

export const Route = createFileRoute('/$workspaceName/_auth')({
  component: MainLayoutComponent,
});

function MainLayoutComponent() {
  const { workspaceName } = Route.useParams();
  // Local (open-source) platform: no cloud session/organization machinery.
  // The parent $workspaceName guard already resolved the implicit workspace,
  // so mount the layout directly.
  if (isLocalAppPlatform()) {
    return <LocalPlatformLayoutContent workspaceName={workspaceName} />;
  }
  return <CloudMainLayoutComponent workspaceName={workspaceName} />;
}

function LocalPlatformLayoutContent({ workspaceName }: { workspaceName: string }) {
  // Same dock-badge / live-activity wiring as the cloud layout.
  useWorkspaceBadge();
  useLodyLiveActivity({ workspaceName });

  return (
    <RouteSuspense>
      <LazyMainLayout>
        <AuthedWorkspaceRouteTracker />
        <Outlet />
        <ElectronSessionCompletionNotifier />
        <ElectronMenuHandler />
        <AppCommands />
        <CommandPalette />
        <AutoArchivePrWatcher />
      </LazyMainLayout>
    </RouteSuspense>
  );
}

function CloudMainLayoutComponent({ workspaceName }: { workspaceName: string }) {
  const { t } = useTranslation();
  const {
    data: session,
    confirmedUnauthenticated,
    hasLocalToken,
    isPending,
    isRetrying,
    error,
  } = useStableSession();
  const setRuntimeInitializing = useSetAtom(runtimeInitializingAtom);
  const { workspaceId: currentWorkspaceId } = useResolvedWorkspaceScope();
  const { machines: machineMetaMap } = useVisibleMachineMetas({ includeMachineFlock: false });
  const onlineMachineIdSet = useOnlineMachineIds();
  const [sessionSettled, setSessionSettled] = useState(!isPending);
  const postHog = usePostHog();
  const authRouteStartMsRef = useRef(getPerformanceNowMs());
  const fireAccountReadyOnce = useFireOncePerKey();
  const fireAuthReadyOnce = useFireOncePerKey();
  const fireCliReadyOnce = useFireOncePerKey();
  const onlineMachineCount = useMemo(() => {
    let count = 0;
    for (const machineId of machineMetaMap.keys()) {
      if (onlineMachineIdSet.has(machineId)) {
        count += 1;
      }
    }
    return count;
  }, [machineMetaMap, onlineMachineIdSet]);
  const hasOnlineMachine = onlineMachineCount > 0;
  const currentUser = useMemo(() => {
    if (!session?.user) {
      return null;
    }
    return normalizeCurrentUserFromSessionUser(session.user);
  }, [session?.user]);
  const analyticsUserWorkspaceKey = useMemo(() => {
    if (!currentUser || !currentWorkspaceId) {
      return null;
    }
    return `${currentUser.id}:${currentWorkspaceId}`;
  }, [currentUser, currentWorkspaceId]);

  useEffect(() => {
    if (!isPending) {
      setSessionSettled(true);
    }
  }, [isPending]);

  useEffect(() => {
    if (isPending || isRetrying || session?.user) {
      return;
    }
    if (error || sessionSettled) {
      setRuntimeInitializing(false);
    }
  }, [error, isPending, isRetrying, session?.user, sessionSettled, setRuntimeInitializing]);

  useEffect(() => {
    if (!currentUser) {
      return;
    }

    identifyPostHogUser(postHog, currentUser);
    identifyPostHogWorkspace(postHog, currentWorkspaceId);
  }, [currentUser, currentWorkspaceId, postHog]);

  useEffect(() => {
    if (!currentUser || !analyticsUserWorkspaceKey) {
      return;
    }
    if (!fireAccountReadyOnce(analyticsUserWorkspaceKey)) {
      return;
    }
    capturePostHogEvent(postHog, 'onboarding/account_ready', {
      user_id: currentUser.id,
      workspace_id: currentWorkspaceId ?? null,
    });
  }, [analyticsUserWorkspaceKey, currentUser, currentWorkspaceId, fireAccountReadyOnce, postHog]);

  useEffect(() => {
    if (!currentUser || !analyticsUserWorkspaceKey) {
      return;
    }
    if (!fireAuthReadyOnce(analyticsUserWorkspaceKey)) {
      return;
    }

    identifyPostHogWorkspace(postHog, currentWorkspaceId);
    const authReadyProperties = {
      user_id: currentUser.id,
      workspace_id: currentWorkspaceId ?? null,
      has_local_token: hasLocalToken,
      online_machine_count: onlineMachineCount,
      auth_route_ready_ms: getDurationSinceMs(authRouteStartMsRef.current),
      // Record OS on a per-login basis (event property, not a person property) so
      // a user signing in from multiple platforms is counted under each OS they
      // use — `useFireOncePerKey` is per-mount, so every device/app load emits its
      // own value. Anonymous launches deliberately omit OS (see app/launch).
      launch_os: detectLaunchOsFromEnv(),
      ...getAppLaunchPerformanceProperties(),
    };
    capturePostHogActiveUser(postHog, authReadyProperties);
    capturePostHogEvent(postHog, 'app/auth_ready', authReadyProperties);
  }, [
    analyticsUserWorkspaceKey,
    currentUser,
    currentWorkspaceId,
    fireAuthReadyOnce,
    hasLocalToken,
    onlineMachineCount,
    postHog,
  ]);

  useEffect(() => {
    if (!currentUser || !analyticsUserWorkspaceKey || !hasOnlineMachine) {
      return;
    }
    if (!fireCliReadyOnce(analyticsUserWorkspaceKey)) {
      return;
    }
    capturePostHogEvent(postHog, 'onboarding/cli_ready', {
      user_id: currentUser.id,
      workspace_id: currentWorkspaceId ?? null,
      online_machine_count: onlineMachineCount,
    });
  }, [
    analyticsUserWorkspaceKey,
    currentUser,
    currentWorkspaceId,
    fireCliReadyOnce,
    hasOnlineMachine,
    onlineMachineCount,
    postHog,
  ]);

  useEffect(() => {
    const token = session?.session?.token;
    if (!currentUser || !token) {
      return undefined;
    }
    if (typeof window !== 'undefined' && window.__LODY_ELECTRON__ === true) {
      return undefined;
    }

    return scheduleOneSignalTask(async (oneSignal, signal) => {
      try {
        await oneSignal.login(currentUser.id, token);
        if (signal.aborted) {
          await oneSignal.logout?.();
        }
      } catch (loginError) {
        console.error('OneSignal login failed', loginError);
      }
    }, AUTH_ROUTE_ONESIGNAL_LOGIN_IDLE_TIMEOUT_MS);
  }, [currentUser, session?.session?.token]);

  useEffect(() => {
    if (!isNativeIOSAppShell()) {
      return;
    }
    const bridge = (window as Window & { __LODY_LIVE_ACTIVITY__?: LodyLiveActivityBridge })
      .__LODY_LIVE_ACTIVITY__;
    if (typeof bridge?.configurePermissionActions !== 'function') {
      return;
    }
    const convexSiteUrl = resolveLiveActivityPermissionActionsConvexSiteUrl();
    if (!convexSiteUrl) {
      console.error(
        'Failed to configure Live Activity permission actions: missing Convex site URL'
      );
      return;
    }
    const token = session?.session?.token;
    bridge
      .configurePermissionActions({
        ...(token ? { authToken: token } : {}),
        convexSiteUrl,
      })
      .catch((configureError: unknown) => {
        console.error('Failed to configure Live Activity permission actions', configureError);
      });
  }, [session?.session?.token]);

  if (confirmedUnauthenticated) {
    const currentPath = getAppCurrentPathWithSearch();
    return <Navigate to="/login" search={{ redirect: currentPath }} replace />;
  }

  if (hasLocalToken) {
    return <AuthedLayoutContent hasLocalToken={true} workspaceName={workspaceName} />;
  }

  if (!sessionSettled) {
    return (
      <LoadingPlaceholder
        title={t('workspace.route.signingInTitle')}
        description={t('workspace.route.signingInDescription')}
      />
    );
  }

  if (isPending || isRetrying) {
    return (
      <LoadingPlaceholder
        title={t('workspace.route.signingInTitle')}
        description={t('workspace.route.signingInDescription')}
      />
    );
  }

  if (error) {
    return (
      <RouteMessage
        title={t('workspace.route.sessionLoadErrorTitle')}
        description={t('workspace.route.sessionLoadErrorDescription')}
      />
    );
  }

  if (!session?.user) {
    const currentPath = getAppCurrentPathWithSearch();
    return <Navigate to="/login" search={{ redirect: currentPath }} replace />;
  }

  return <AuthedLayoutContent hasLocalToken={false} workspaceName={workspaceName} />;
}

function AuthedLayoutContent({
  hasLocalToken,
  workspaceName,
}: {
  hasLocalToken: boolean;
  workspaceName: string;
}) {
  const { t } = useTranslation();
  const {
    organizations,
    organizationsLoading,
    error: organizationsError,
  } = useOrganization({ targetSlug: workspaceName });
  const user = useAtomValue(userAtom);
  const { workspaceId: currentWorkspaceId } = useResolvedWorkspaceScope();
  useBillingOverviewPreload(user ? currentWorkspaceId : null);
  const [orgSettled, setOrgSettled] = useState(!organizationsLoading);
  const [userSettled, setUserSettled] = useState(Boolean(user) && Boolean(currentWorkspaceId));

  // Push this workspace's owned-by-me unread/waiting counts to the Electron
  // dock badge. No-op on web. Mounted at the workspace layout so it lives
  // for the entire authenticated session (one subscriber per window).
  useWorkspaceBadge();
  useLodyLiveActivity({ workspaceName });

  useEffect(() => {
    if (!organizationsLoading) {
      setOrgSettled(true);
    }
  }, [organizationsLoading]);

  useEffect(() => {
    if (user && currentWorkspaceId) {
      setUserSettled(true);
    }
  }, [currentWorkspaceId, user]);

  if (hasLocalToken) {
    if (orgSettled && organizations !== undefined && organizations.length === 0) {
      return <Navigate to="/workspace/create" replace />;
    }

    if (!currentWorkspaceId) {
      return (
        <RouteSuspense>
          <LazyMainLayout workspaceReady={false}>
            <LoadingPlaceholder
              variant="content"
              title={t('workspace.route.switchingTitle')}
              description={t('workspace.route.switchingDescription')}
            />
          </LazyMainLayout>
        </RouteSuspense>
      );
    }

    return (
      <RouteSuspense>
        <LazyMainLayout>
          <AuthedWorkspaceRouteTracker />
          <Outlet />
          <ElectronSessionCompletionNotifier />
          <ElectronMenuHandler />
          <AppCommands />
          <CommandPalette />
          <AutoArchivePrWatcher />
          <WorkspaceCheckoutPendingDialog />
        </LazyMainLayout>
      </RouteSuspense>
    );
  }

  if (!orgSettled || !userSettled) {
    return (
      <LoadingPlaceholder
        title={t('workspace.route.loadingTitle')}
        description={t('workspace.route.setupLoadingDescription')}
      />
    );
  }

  if (organizationsError) {
    return (
      <RouteMessage
        title={t('workspace.route.loadingWorkspacesErrorTitle')}
        description={t('workspace.route.loadingWorkspacesErrorDescription')}
      />
    );
  }

  if (organizationsLoading) {
    return (
      <LoadingPlaceholder
        title={t('workspace.route.loadingWorkspacesTitle')}
        description={t('workspace.route.loadingWorkspacesDescription')}
      />
    );
  }

  if (organizations === undefined) {
    return (
      <RouteMessage
        title={t('workspace.route.loadingWorkspacesErrorTitle')}
        description={t('workspace.route.loadingWorkspacesErrorDescription')}
      />
    );
  }

  if (organizations.length === 0) {
    return <Navigate to="/workspace/create" replace />;
  }

  if (!user || !currentWorkspaceId) {
    return (
      <LoadingPlaceholder
        title={t('workspace.route.loadingTitle')}
        description={t('workspace.route.setupLoadingDescription')}
      />
    );
  }

  return (
    <RouteSuspense>
      <LazyMainLayout>
        <AuthedWorkspaceRouteTracker />
        <Outlet />
        <ElectronSessionCompletionNotifier />
        <ElectronMenuHandler />
        <CommandPalette />
        <AutoArchivePrWatcher />
        <WorkspaceCheckoutPendingDialog />
      </LazyMainLayout>
    </RouteSuspense>
  );
}

function AuthedWorkspaceRouteTracker() {
  const location = useLocation();
  const routeHref = location.href;
  const routeHrefRef = useRef(routeHref);
  routeHrefRef.current = routeHref;

  useEffect(() => {
    writeLastAppRoutePath(routeHref);
  }, [routeHref]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return undefined;
    }

    const persistCurrentRoute = () => {
      writeLastAppRoutePath(routeHrefRef.current);
    };
    const persistWhenHidden = () => {
      if (document.visibilityState === 'hidden') {
        persistCurrentRoute();
      }
    };

    window.addEventListener('pagehide', persistCurrentRoute);
    document.addEventListener('visibilitychange', persistWhenHidden);

    return () => {
      window.removeEventListener('pagehide', persistCurrentRoute);
      document.removeEventListener('visibilitychange', persistWhenHidden);
    };
  }, []);

  return null;
}
