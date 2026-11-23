import { hydrateStart } from '@tanstack/react-start/client';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode, startTransition } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { prepareHydration } from '@site/lib/prepare-hydration';
import { getRouter } from './router';

void prepareHydration(
  window,
  async () => {
    await hydrateStart();
    const router = await getRouter();
    // Server loader data alone does not populate Fumadocs' browser MDX cache.
    // Run the matched loaders (including their content preloads) before React
    // owns the document. Static server functions read the generated cache files.
    await router.invalidate({ sync: true });
    if (router.state.matches.some((match) => match.status !== 'success')) {
      throw new Error('The initial page is not ready for hydration.');
    }
    return router;
  },
  (router) => {
    startTransition(() => {
      hydrateRoot(
        document,
        <StrictMode>
          <RouterProvider router={router} />
        </StrictMode>
      );
    });
  }
);
