import { isReservedWorkspaceSlug } from './workspace-slugs';

const WORKSPACE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WORKSPACE_ROUTE_CHILD_SEGMENTS = new Set([
  'archive',
  'chat',
  'local',
  'sessions',
  'settings',
]);

function getRouteUrl(routePath: string): URL | null {
  try {
    return new URL(routePath, 'http://lody.local');
  } catch {
    return null;
  }
}

function isNavigableWorkspaceSlug(slug: string): boolean {
  return WORKSPACE_SLUG_PATTERN.test(slug) && !isReservedWorkspaceSlug(slug);
}

/**
 * Extract a workspace slug only from routes that are known to be inside the
 * authenticated workspace shell. Top-level app routes such as `/login` or
 * `/workspace/create` deliberately return null so callers do not synthesize
 * `/login/chat` or `/workspace/chat`.
 */
export function getWorkspaceSlugFromAppRoutePath(routePath: string | null): string | null {
  if (!routePath) return null;

  const routeUrl = getRouteUrl(routePath);
  if (!routeUrl) return null;

  const [workspaceSlug, childSegment] = routeUrl.pathname.split('/').filter(Boolean);
  if (!workspaceSlug || !isNavigableWorkspaceSlug(workspaceSlug)) return null;
  if (!childSegment) return workspaceSlug;
  if (WORKSPACE_ROUTE_CHILD_SEGMENTS.has(childSegment)) return workspaceSlug;
  return null;
}
