import { windowStorage } from './desktop-window';
import { isValidWorkspaceSlug } from './workspace';

const LAST_APP_ROUTE_STORAGE_KEY = 'lody:lastAppRoute';
const LAST_APP_ROUTE_STORAGE_VERSION = 1;
const FALLBACK_ORIGIN = 'http://localhost';

type StoredLastAppRoute = {
  version: typeof LAST_APP_ROUTE_STORAGE_VERSION;
  path: string;
  updatedAt: number;
};

function isStoredLastAppRoute(value: unknown): value is StoredLastAppRoute {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (!('version' in value) || !('path' in value) || !('updatedAt' in value)) {
    return false;
  }

  return (
    value.version === LAST_APP_ROUTE_STORAGE_VERSION &&
    typeof value.path === 'string' &&
    typeof value.updatedAt === 'number' &&
    Number.isFinite(value.updatedAt)
  );
}

function parseRelativeAppPath(path: string): URL | null {
  const trimmed = path.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) {
    return null;
  }

  try {
    return new URL(trimmed, FALLBACK_ORIGIN);
  } catch {
    return null;
  }
}

function extractWorkspaceSlugFromUrl(url: URL): string | null {
  const [workspaceSlug] = url.pathname.split('/').filter(Boolean);
  if (!workspaceSlug || !isValidWorkspaceSlug(workspaceSlug)) {
    return null;
  }
  return workspaceSlug;
}

function isRestorableConversationRouteUrl(url: URL): boolean {
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 3) {
    return false;
  }

  const [workspaceSlug, routeName, sessionId] = segments;
  return Boolean(
    workspaceSlug && isValidWorkspaceSlug(workspaceSlug) && routeName === 'sessions' && sessionId
  );
}

export function getWorkspaceSlugFromAppRoutePath(path: string): string | null {
  const url = parseRelativeAppPath(path);
  return url ? extractWorkspaceSlugFromUrl(url) : null;
}

export function normalizeLastAppRoutePath(path: string): string | null {
  const url = parseRelativeAppPath(path);
  if (!url || !isRestorableConversationRouteUrl(url)) {
    return null;
  }

  return `${url.pathname}${url.search}`;
}

export function readLastAppRoutePath(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = windowStorage().getItem(LAST_APP_ROUTE_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isStoredLastAppRoute(parsed)) {
      windowStorage().removeItem(LAST_APP_ROUTE_STORAGE_KEY);
      return null;
    }

    const normalized = normalizeLastAppRoutePath(parsed.path);
    if (!normalized) {
      windowStorage().removeItem(LAST_APP_ROUTE_STORAGE_KEY);
      return null;
    }

    return normalized;
  } catch {
    return null;
  }
}

export function writeLastAppRoutePath(path: string | null): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    if (!path) {
      windowStorage().removeItem(LAST_APP_ROUTE_STORAGE_KEY);
      return;
    }

    const normalized = normalizeLastAppRoutePath(path);
    if (!normalized) {
      if (parseRelativeAppPath(path)) {
        windowStorage().removeItem(LAST_APP_ROUTE_STORAGE_KEY);
      }
      return;
    }

    const stored: StoredLastAppRoute = {
      version: LAST_APP_ROUTE_STORAGE_VERSION,
      path: normalized,
      updatedAt: Date.now(),
    };
    windowStorage().setItem(LAST_APP_ROUTE_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // ignore
  }
}

export function clearLastAppRoutePath(): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    windowStorage().removeItem(LAST_APP_ROUTE_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function clearLastAppRoutePathIfWorkspaceMatch(workspaceSlug: string): void {
  const currentPath = readLastAppRoutePath();
  if (!currentPath) {
    return;
  }

  if (getWorkspaceSlugFromAppRoutePath(currentPath) === workspaceSlug) {
    clearLastAppRoutePath();
  }
}
