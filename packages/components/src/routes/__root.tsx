import {
  createRootRouteWithContext,
  Outlet,
  useLocation,
  useNavigate,
  useRouter,
} from '@tanstack/react-router';
import { usePostHog } from '@posthog/react';
import AppInitializer from '@/components/AppInitializer';
import { ThemeProvider } from '../theme-provider';
import { LanguageProvider } from '../i18n';
import { Toaster } from '@/ui/sonner';
import { NotFound } from '@/components/not-found';
import { TooltipProvider } from '@/ui';
import { RuntimeProvider } from '../providers/runtime-provider';
import { markStartupNavigationForEagerSync } from '../providers/startup-network-idle';
import { trackDeferredPostHogPageView } from '../lib/deferred-posthog';
import { scheduleIdleTask } from '../lib/idle-task';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ErrorBoundary } from '@/components/error-boundary';
import { isMissingEmail } from '@lody/shared';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { ConvexProvider, useAuthClient } from '../providers/convex-provider';
import type { RouterContext } from '../router';
import { persistAuthToken, signOutWithoutRedirect } from '../lib/auth';
import { setLoginHintCookie } from '../lib/login-hint-cookie';
import i18next from 'i18next';
import { getAppCurrentPathWithSearch } from '@/lib/app-location';
import { onIpcEvent } from '@/lib/electron-ipc-client';
import { useStableSession } from '@/hooks/useStableSession';
import { normalizeCurrentUserFromSessionUser } from '@/lib/current-user';
import { writeAuthBootstrapSnapshot } from '@/lib/auth-bootstrap';
import { toast } from 'sonner';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  authTokenAtom,
  electronDeepLinkSignInInProgressAtom,
  nativeSignInInProgressAtom,
  setWorkspaceContextAtom,
  userAtom,
} from '@/atoms';
import { StableSessionProvider } from '../providers/stable-session-provider';
import { isNativeAppShell } from '@/lib/native-platform';
import { resolveDesktopCheckoutReturnDeepLinkPath } from '@/lib/desktop-checkout-return-deep-link';
import { resolveDesktopGitHubInstallDeepLinkPath } from '@/lib/desktop-github-install-deep-link';
import { readElectronAuthCallbackToken } from '@/lib/electron-oauth';
import { LodyPostHogProvider } from '../providers/posthog-provider';
import { AppLaunchAnalyticsTracker } from '@/components/app-launch-analytics-tracker';
import { ShortcutAnalyticsTracker } from '@/components/commands/shortcut-analytics-tracker';
import { ERROR_BOUNDARY_PROBE_EVENT, consumeErrorBoundaryProbe } from '@/lib/error-boundary-probe';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { resolveDesktopInviteDeepLinkPath } from '@/lib/desktop-invite-deep-link';
import { resolveDesktopOpenLocalProjectDeepLinkPath } from '@/lib/desktop-open-local-project-deep-link';
import { useDesktopWorkspaceMembershipSync } from '@/hooks/use-desktop-workspace-membership-sync';
import { useCloudMutation } from '@lody/platform/react';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { readDesktopMachinePairingRequestId } from '@/lib/desktop-machine-pairing-deep-link';
import { useAuthenticatedConvex } from '@/hooks/use-authenticated-convex';
import { useConvexErrorMessage } from '@/hooks/use-convex-error-message';
import { AuthenticatedConvexProvider } from '../providers/authenticated-convex-provider';
import { InterfaceFontController } from '@/components/interface-font-controller';
import { PlatformContext } from '@lody/platform/react';
import { isLocalAppPlatform, useAppCapability } from '@/lib/app-platform';
import { getLocalPlatformProvider } from '../providers/local-platform-provider';
import { LocalPlatformAuthProvider } from '../providers/local-platform-auth-provider';
import { CloudPlatformProvider } from '../providers/cloud-platform-provider';

const CODE_VERIFIER_NOT_FOUND_MESSAGE = 'code verifier not found';
const PENDING_MACHINE_PAIRING_KEY = 'lody:pending-machine-pairing-request';

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  notFoundComponent: NotFound,
  head: () => ({
    // TODO: head meta
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
    ],
  }),
});

function RootComponent() {
  const { authClient } = useRouter().options.context;

  // Local (open-source) platform: same inner app shell, but the auth/Convex
  // layers are replaced by static no-op contexts and the platform contract is
  // provided instead. Cloud builds render unchanged (their PlatformProvider
  // implementation lands later); the branch is build-time constant.
  if (isLocalAppPlatform()) {
    return (
      <PlatformContext.Provider value={getLocalPlatformProvider()}>
        <LocalPlatformAuthProvider authClient={authClient}>
          <RootApp />
        </LocalPlatformAuthProvider>
      </PlatformContext.Provider>
    );
  }

  return (
    <ConvexProvider authClient={authClient}>
      <StableSessionProvider>
        <AuthenticatedConvexProvider>
          <CloudPlatformProvider>
            <RootApp />
          </CloudPlatformProvider>
        </AuthenticatedConvexProvider>
      </StableSessionProvider>
    </ConvexProvider>
  );
}

function ErrorBoundaryProbe() {
  const [eventProbeCount, setEventProbeCount] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const triggerProbe = () => setEventProbeCount((count) => count + 1);
    window.addEventListener(ERROR_BOUNDARY_PROBE_EVENT, triggerProbe);
    return () => window.removeEventListener(ERROR_BOUNDARY_PROBE_EVENT, triggerProbe);
  }, []);

  if (eventProbeCount > 0 || consumeErrorBoundaryProbe()) {
    const error = new Error('Lody ErrorBoundary probe');
    error.name = 'LodyErrorBoundaryProbeError';
    throw error;
  }

  return null;
}

function RootApp() {
  const {
    data: session,
    hasLocalToken,
    hasRawUser,
    isOptimistic,
    isPending,
    isRetrying,
    error,
  } = useStableSession();
  const isElectron = typeof window !== 'undefined' && window.__LODY_ELECTRON__ === true;
  const isNativeApp = isNativeAppShell();
  const telemetryEnabled = useAppCapability('telemetry');
  const setUser = useSetAtom(userAtom);
  const setAuthToken = useSetAtom(authTokenAtom);
  const currentUser = useMemo(() => {
    if (!session?.user) {
      return null;
    }
    return normalizeCurrentUserFromSessionUser(session.user);
  }, [session?.user]);
  useDesktopWorkspaceMembershipSync(isElectron ? (currentUser?.id ?? null) : null);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return undefined;
    }

    document.documentElement.classList.toggle('native-mobile-shell', isNativeApp);
    document.body.classList.toggle('native-mobile-shell', isNativeApp);

    return () => {
      document.documentElement.classList.remove('native-mobile-shell');
      document.body.classList.remove('native-mobile-shell');
    };
  }, [isNativeApp]);

  useEffect(() => {
    if (isPending || isRetrying || error || isOptimistic) {
      return;
    }
    setLoginHintCookie(hasRawUser);
  }, [error, hasRawUser, isOptimistic, isPending, isRetrying]);

  useEffect(() => {
    if (currentUser) {
      setUser(currentUser);
      writeAuthBootstrapSnapshot(currentUser);
      return;
    }
    if (!hasLocalToken) {
      setUser(null);
    }
  }, [currentUser, hasLocalToken, setUser]);

  useEffect(() => {
    const token = session?.session?.token ?? null;
    if (token) {
      setAuthToken(token);
      persistAuthToken(token);
      return;
    }
    if (!hasLocalToken) {
      setAuthToken(null);
    }
  }, [hasLocalToken, session?.session?.token, setAuthToken]);

  return (
    <LodyPostHogProvider>
      {telemetryEnabled && <AppLaunchAnalyticsTracker isElectron={isElectron} />}
      {telemetryEnabled && <ShortcutAnalyticsTracker />}
      {isElectron && <DesktopDeepLinkRouter />}
      <ThemeProvider>
        <InterfaceFontController enabled={isElectron} />
        <TooltipProvider skipDelayDuration={0}>
          <AppInitializer>
            <LanguageProvider>
              <>
                <Toaster />
                <RuntimeProvider>
                  {/* Location-driven effects and the Outlet boundary subscribe to
                      router state in these two small components, so a navigation
                      no longer re-renders the whole provider stack above. */}
                  <RootLocationEffects />
                  <RootOutletBoundary />
                </RuntimeProvider>
                {/* <TanStackRouterDevtools /> */}
              </>
            </LanguageProvider>
          </AppInitializer>
        </TooltipProvider>
      </ThemeProvider>
    </LodyPostHogProvider>
  );
}

/**
 * Owns every location-driven root effect (pageview tracking, auth redirects,
 * session-expiry handling). Renders nothing; keeping the subscription here
 * instead of in `RootApp` keeps the app-wide provider stack out of the
 * per-navigation re-render.
 */
function RootLocationEffects() {
  const location = useLocation();
  const navigate = useNavigate();
  const authClient = useAuthClient();
  const {
    data: session,
    hasRawUser,
    isOptimistic,
    isPending,
    isRetrying,
    error,
    confirmedUnauthenticated,
  } = useStableSession();
  const userEmail = session?.user?.email;
  const electronSignInInProgress = useAtomValue(electronDeepLinkSignInInProgressAtom);
  const nativeSignInInProgress = useAtomValue(nativeSignInInProgressAtom);
  const setUser = useSetAtom(userAtom);
  const setAuthToken = useSetAtom(authTokenAtom);
  const setWorkspaceContext = useSetAtom(setWorkspaceContextAtom);
  const authInvalidationRef = useRef(false);

  useEffect(() => {
    markStartupNavigationForEagerSync();
    // Page views are telemetry, so they wait for idle rather than extending the
    // keydown task that navigated. Cancelling on href change also collapses a
    // burst of session switches into the one view the user landed on.
    const href = location.href;
    return scheduleIdleTask(() => trackDeferredPostHogPageView(href));
  }, [location.href]);

  useEffect(() => {
    // Defensive cleanup: on rare unmount/race conditions a Radix/vaul "modal layer" can leave
    // `document.body` stuck with `pointer-events: none`, making the app feel frozen.
    if (typeof document === 'undefined') return;
    if (document.body.style.pointerEvents === 'none') {
      document.body.style.pointerEvents = '';
    }
  }, [location.pathname]);

  useEffect(() => {
    if (isPending || isRetrying || error || isOptimistic || !hasRawUser) {
      return;
    }
    if (!isMissingEmail(userEmail)) {
      return;
    }
    if (location.pathname === '/complete-email') {
      return;
    }
    const redirectPath =
      typeof window === 'undefined' ? location.pathname : getAppCurrentPathWithSearch();
    void navigate({ to: '/complete-email', search: { redirect: redirectPath }, replace: true });
  }, [
    error,
    hasRawUser,
    isOptimistic,
    isPending,
    isRetrying,
    location.pathname,
    location.search,
    navigate,
    userEmail,
  ]);

  useEffect(() => {
    if (hasRawUser && !confirmedUnauthenticated) {
      authInvalidationRef.current = false;
    }
  }, [confirmedUnauthenticated, hasRawUser]);

  useEffect(() => {
    if (!confirmedUnauthenticated || authInvalidationRef.current) {
      return;
    }
    if (location.pathname === '/onboarding') {
      return;
    }

    // A desktop deep-link sign-in is mid-flight: the browser handed the token
    // back but the session has not finished resolving. The brief
    // `confirmedUnauthenticated` window here is expected, not an expired session
    // — invalidating now would sign the user out, toast, and redirect right as
    // the login is about to succeed. Wait for it to resolve (or time out).
    if (electronSignInInProgress) {
      return;
    }
    if (nativeSignInInProgress) {
      return;
    }

    authInvalidationRef.current = true;
    const redirectPath =
      typeof window === 'undefined' ? location.pathname : getAppCurrentPathWithSearch();

    setUser(null);
    setAuthToken(null);
    setWorkspaceContext({ slug: null, workspaceId: null });

    void signOutWithoutRedirect(authClient);
    toast.error(i18next.t('login.sessionExpired'));
    void navigate({
      to: '/login',
      search: { redirect: redirectPath, expired: '1' },
      replace: true,
    });
  }, [
    authClient,
    confirmedUnauthenticated,
    electronSignInInProgress,
    location.pathname,
    nativeSignInInProgress,
    navigate,
    setAuthToken,
    setWorkspaceContext,
    setUser,
  ]);

  return null;
}

/**
 * The root Outlet wrapped in its error boundary. Subscribes to the location
 * (for `resetKeys`) so `RootApp` and the providers above don't have to.
 */
function RootOutletBoundary() {
  const location = useLocation({
    select: (l) => ({ pathname: l.pathname, search: l.search }),
  });
  return (
    <ErrorBoundary
      name="RootOutlet"
      variant="page"
      resetKeys={[location.pathname, location.search]}
      showErrorDetails
      propagateAuthErrors={false}
    >
      <ErrorBoundaryProbe />
      <Outlet />
    </ErrorBoundary>
  );
}

function isCodeVerifierNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes(CODE_VERIFIER_NOT_FOUND_MESSAGE);
}

/**
 * Navigate to a resolved path that may carry a query string (e.g.
 * `/acme/settings/billing?checkout=success`). TanStack Router's `to` does not
 * parse an embedded query, so the path must be split and the query passed as
 * `search` — otherwise the route fails to match and (for the settings deep
 * links) the wrong tab opens.
 */
function navigateToResolvedPath(navigate: ReturnType<typeof useNavigate>, path: string): void {
  const queryIndex = path.indexOf('?');
  if (queryIndex === -1) {
    void navigate({ to: path, replace: true });
    return;
  }
  const to = path.slice(0, queryIndex);
  const search = Object.fromEntries(new URLSearchParams(path.slice(queryIndex + 1)));
  void navigate({ to, search, replace: true });
}

function DesktopDeepLinkRouter() {
  const { desktopAuth } = useRouter().options.context;
  const location = useLocation();
  const navigate = useNavigate();
  const postHog = usePostHog();
  const setElectronSignInInProgress = useSetAtom(electronDeepLinkSignInInProgressAtom);
  const localMachineId = useAtomValue(localMachineIdAtom);
  const currentUser = useAtomValue(userAtom);
  const { isAuthenticated: isConvexAuthenticated, isLoading: isConvexAuthLoading } =
    useAuthenticatedConvex();
  const getConvexErrorMessage = useConvexErrorMessage();
  const claimMachinePairing = useCloudMutation(cloudOperations.machinePairing.claimFromDesktop);
  const [pendingMachinePairingRequestId, setPendingMachinePairingRequestId] = useState<
    string | null
  >(() => {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage.getItem(PENDING_MACHINE_PAIRING_KEY);
  });

  useEffect(() => {
    if (
      !pendingMachinePairingRequestId ||
      !localMachineId ||
      !currentUser ||
      isConvexAuthLoading ||
      !isConvexAuthenticated
    ) {
      return undefined;
    }
    let cancelled = false;
    void claimMachinePairing({
      requestId: pendingMachinePairingRequestId as never,
      machineId: localMachineId,
      machineName: window.__LODY_PLATFORM__?.machineName ?? localMachineId,
    })
      .then(() => {
        if (cancelled) return;
        window.sessionStorage.removeItem(PENDING_MACHINE_PAIRING_KEY);
        setPendingMachinePairingRequestId(null);
        toast.success(i18next.t('machinePairing.desktopClaimed', 'This machine is connected.'));
      })
      .catch((error) => {
        if (cancelled) return;
        window.sessionStorage.removeItem(PENDING_MACHINE_PAIRING_KEY);
        setPendingMachinePairingRequestId(null);
        toast.error(
          getConvexErrorMessage(
            error,
            i18next.t(
              'machinePairing.desktopClaimFailed',
              'Could not connect this machine. Create a new connection request and try again.'
            )
          )
        );
      });
    return () => {
      cancelled = true;
    };
  }, [
    claimMachinePairing,
    currentUser,
    getConvexErrorMessage,
    isConvexAuthenticated,
    isConvexAuthLoading,
    localMachineId,
    pendingMachinePairingRequestId,
  ]);

  useEffect(() => {
    if (typeof window === 'undefined' || window.__LODY_ELECTRON__ !== true) {
      return undefined;
    }
    return onIpcEvent('app.deepLink', (url) => {
      const authCallbackToken = readElectronAuthCallbackToken(url);
      const isAuthCallback = authCallbackToken != null;
      const invitePath = resolveDesktopInviteDeepLinkPath(url);
      const machinePairingRequestId = readDesktopMachinePairingRequestId(url);
      const openLocalProjectPath = resolveDesktopOpenLocalProjectDeepLinkPath(
        url,
        location.pathname
      );
      capturePostHogEvent(postHog, 'auth/electron_deep_link_received', {
        deep_link_kind: isAuthCallback
          ? 'auth_callback'
          : invitePath
            ? 'invite_open'
            : machinePairingRequestId
              ? 'machine_pairing'
              : openLocalProjectPath
                ? 'open_local_project'
                : 'other',
        is_auth_callback: isAuthCallback,
        has_auth_payload: isAuthCallback,
        auth_payload_chars: authCallbackToken?.length ?? 0,
      });

      if (machinePairingRequestId) {
        window.sessionStorage.setItem(PENDING_MACHINE_PAIRING_KEY, machinePairingRequestId);
        setPendingMachinePairingRequestId(machinePairingRequestId);
        return;
      }

      // The browser handed the auth token back. Flag the sign-in as in progress
      // so the login page shows a spinner immediately and the root invalidation
      // effect does not mistake the resolving window for an expired session.
      if (authCallbackToken != null) {
        setElectronSignInInProgress(true);
        void (async () => {
          try {
            if (!desktopAuth) {
              throw new Error('Electron auth coordinator is unavailable');
            }
            await desktopAuth.completeCallback(authCallbackToken);
          } catch (error) {
            const recovered = isCodeVerifierNotFoundError(error);
            capturePostHogEvent(postHog, 'auth/electron_auth_callback_exchange_failed', {
              error_signature: recovered ? 'code_verifier_not_found' : 'other',
              recovered,
            });

            if (!recovered) {
              return;
            }

            const currentPath =
              typeof window === 'undefined' ? location.pathname : getAppCurrentPathWithSearch();
            const currentLoginRedirect =
              typeof window === 'undefined'
                ? null
                : new URLSearchParams(window.location.search).get('redirect');
            const search =
              location.pathname === '/login'
                ? currentLoginRedirect
                  ? { redirect: currentLoginRedirect, expired: '1' }
                  : { expired: '1' }
                : { redirect: currentPath, expired: '1' };
            void navigate({
              to: '/login',
              search,
              replace: true,
            });
          } finally {
            if (!desktopAuth?.isCallbackActive()) {
              setElectronSignInInProgress(false);
            }
          }
        })();
        return;
      }

      // A desktop-initiated Stripe checkout/portal finished in the system
      // browser; land back on the billing settings tab. The billing page's
      // reconcile polling has usually already flipped the plan by now — this
      // deep link exists to focus the app and show the result.
      const checkoutReturnPath = resolveDesktopCheckoutReturnDeepLinkPath(url, location.pathname);
      if (checkoutReturnPath) {
        navigateToResolvedPath(navigate, checkoutReturnPath);
        return;
      }

      if (invitePath) {
        void navigate({ to: invitePath, replace: true });
        return;
      }

      // `lody app <dir>` in a terminal: land on the new-chat composer with the
      // local project the CLI already resolved preselected.
      if (openLocalProjectPath) {
        navigateToResolvedPath(navigate, openLocalProjectPath);
        return;
      }

      // Mid-onboarding the install was kicked off from the projects step —
      // returning to /settings/github would leave the user behind the
      // overlay once they finish. Land them on the workspace home so the
      // overlay continues uninterrupted and the projects list refreshes.
      if (location.pathname === '/onboarding') {
        return;
      }
      const target = 'settings';
      const targetPath = resolveDesktopGitHubInstallDeepLinkPath(url, location.pathname, {
        target,
      });
      if (!targetPath) {
        return;
      }

      navigateToResolvedPath(navigate, targetPath);
    });
  }, [desktopAuth, location.pathname, navigate, postHog, setElectronSignInInProgress]);

  return null;
}
