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

export const createRouter = (options: CreateRouterOptions) => {
  const router = createTanstackRouter({
    routeTree,
    basepath: options.basepath ?? '',
    history: options.history,
    defaultPreload: 'intent',
    scrollRestoration: true,
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
