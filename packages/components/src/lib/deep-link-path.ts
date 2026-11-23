import type { useNavigate } from '@tanstack/react-router';

/** Extract the leading workspace slug from an in-app path (`/slug/...`). */
export function readWorkspaceSlugFromPath(pathname: string): string | null {
  const [workspaceSlug] = pathname.split('/').filter(Boolean);
  return workspaceSlug || null;
}

/** Route a desktop return without ever parsing its fragment as query parameters. */
export function navigateToResolvedPath(
  navigate: ReturnType<typeof useNavigate>,
  path: string
): void {
  const hashIndex = path.indexOf('#');
  const route = hashIndex === -1 ? path : path.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : path.slice(hashIndex + 1);
  const queryIndex = route.indexOf('?');
  const to = queryIndex === -1 ? route : route.slice(0, queryIndex);
  const search =
    queryIndex === -1 ? {} : Object.fromEntries(new URLSearchParams(route.slice(queryIndex + 1)));
  void navigate({ to, search, hash, replace: true });
}
