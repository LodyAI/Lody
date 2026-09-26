import { createRouter as createTanstackRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import type { LodyAuthClient } from './lib/auth';

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
 * conversation's viewport is owned by its follow controller
 * (`hooks/use-sticky-scroll.ts`); a second writer fights it and costs a storage
 * write per switch.
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
  return router;
};

// Register router for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>;
  }
}
