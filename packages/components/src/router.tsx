import { useEffect, useRef, type ComponentType } from 'react';
import {
  createRouter as createTanstackRouter,
  type ErrorComponentProps,
} from '@tanstack/react-router';
import { redactedTelemetryException } from '@lody/platform/telemetry';
import { routeTree } from './routeTree.gen';
import type { E2eeRuntimeFactory, PlatformE2eeWorkspaces } from '@lody/platform';
import type { LodyAuthClient } from './lib/auth';
import { setTelemetryRouteTarget } from './lib/posthog-privacy';
import { deferredPostHog } from './lib/deferred-posthog';
import { recordClientError } from './lib/client-log';
import { ErrorBoundaryFallback } from './components/error-boundary-fallback';

function RouterErrorComponent({ error, info, reset }: ErrorComponentProps) {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  const reportedErrorRef = useRef<unknown>(null);

  useEffect(() => {
    if (reportedErrorRef.current === error) return;
    reportedErrorRef.current = error;
    recordClientError('react.router_error_boundary', normalizedError, {
      boundary: 'RouterErrorBoundary',
      variant: 'page',
      componentStack: info?.componentStack ?? null,
    });
    try {
      const properties = redactedTelemetryException({ source: 'errorBoundary' }, normalizedError);
      const diagnostic = new Error(properties.error_code);
      diagnostic.name = properties.error_type;
      diagnostic.stack = undefined;
      deferredPostHog.captureException(diagnostic, properties);
    } catch {}
  }, [error, info?.componentStack, normalizedError]);

  return (
    <ErrorBoundaryFallback
      error={normalizedError}
      resetErrorBoundary={reset}
      variant="page"
      componentStack={info?.componentStack ?? null}
      boundaryName="RouterErrorBoundary"
      showErrorDetails
    />
  );
}

export type RouterContext = {
  authClient: LodyAuthClient;
  recoveryPage?: ComponentType;
  /** Optional application-owned browser/native-shell host; local and Electron keep their owners. */
  createE2eeRuntime?: E2eeRuntimeFactory;
  /** Optional protected device-creation capability for a portable host. */
  prepareE2eeCreation?: PlatformE2eeWorkspaces['prepareCreation'];
};

type CreateRouterOptions = {
  authClient: LodyAuthClient;
  recoveryPage?: ComponentType;
  /** Optional application-owned browser/native-shell host; local and Electron keep their owners. */
  createE2eeRuntime?: E2eeRuntimeFactory;
  prepareE2eeCreation?: PlatformE2eeWorkspaces['prepareCreation'];
  basepath?: string;
  history?: Parameters<typeof createTanstackRouter>[0]['history'];
};

const CONVERSATION_PATH = /\/sessions\/[^/]+\/?$/;

/**
 * The router restores scroll by CSS selector per URL: it records every element
 * that scrolled and writes `scrollTop` back after the next render. A
 * conversation's viewport is owned by the conversation scroll engine
 * (`lib/conversation-scroll`), its only writer; a second writer fights it and
 * costs a storage write per switch.
 */
export function shouldRouterRestoreScroll(pathname: string): boolean {
  return !CONVERSATION_PATH.test(pathname);
}

export const createRouter = (options: CreateRouterOptions) => {
  const router = createTanstackRouter({
    routeTree,
    basepath: options.basepath ?? '',
    history: options.history,
    defaultPreload: 'intent',
    defaultErrorComponent: RouterErrorComponent,
    scrollRestoration: ({ location }) => shouldRouterRestoreScroll(location.pathname),
    context: {
      authClient: options.authClient,
      recoveryPage: options.recoveryPage,
      createE2eeRuntime: options.createE2eeRuntime,
      prepareE2eeCreation: options.prepareE2eeCreation,
    },
  });
  const publishTelemetryTarget = (pathname: string, committed: boolean) => {
    const matches = router.matchRoutes(pathname);
    const workspace = matches.find((match) => 'workspaceName' in match.params);
    const slug = workspace?.params as { workspaceName?: string } | undefined;
    setTelemetryRouteTarget(slug?.workspaceName ?? null, committed);
  };
  // Subscribe outside React so a switch closes the gate before route rendering,
  // and never enables a new scope while the old DOM is still committed.
  router.subscribe('onBeforeNavigate', ({ toLocation }) =>
    publishTelemetryTarget(toLocation.pathname, false)
  );
  router.subscribe('onResolved', ({ toLocation }) =>
    publishTelemetryTarget(toLocation.pathname, true)
  );
  return router;
};

// Register router for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>;
  }
}
