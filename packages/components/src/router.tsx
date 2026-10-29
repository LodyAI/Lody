import { createRouter as createTanstackRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import type { LodyAuthClient } from './lib/auth';
import { setTelemetryRouteTarget } from './lib/posthog-privacy';

export type RouterContext = {
  authClient: LodyAuthClient;
};

type CreateRouterOptions = {
  authClient: LodyAuthClient;
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
    scrollRestoration: ({ location }) => shouldRouterRestoreScroll(location.pathname),
    context: {
      authClient: options.authClient,
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
