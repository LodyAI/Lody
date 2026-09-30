import { createRouter as createTanStackRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

export function createRouter() {
  return createTanStackRouter({
    routeTree,
    defaultPreload: 'intent',
    trailingSlash: 'always',
    scrollRestoration: true,
  });
}

let router: ReturnType<typeof createRouter> | undefined;

export async function getRouter() {
  if (import.meta.env.SSR) {
    return createRouter();
  }

  router ??= createRouter();
  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>;
  }
}
