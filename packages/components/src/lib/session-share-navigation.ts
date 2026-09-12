import type { SessionShareManifest } from '@lody/shared/session-sharing';

/** The manifest, never a requested URL target, grants access. */
export function resolveSessionShareTab(
  manifest: SessionShareManifest | null,
  search: string
): string | null {
  if (!manifest) return null;
  const requested = new URLSearchParams(search).get('tab');
  return manifest.targets.some((target) => target.sessionId === requested)
    ? requested
    : manifest.rootSessionId;
}

export function subscribeSessionShareNavigation(changed: () => void): () => void {
  window.addEventListener('popstate', changed);
  return () => window.removeEventListener('popstate', changed);
}

export const getSessionShareSearch = (): string => window.location.search;

/** Keeps the access fragment intact; never transfers the secret into a query. */
export function navigateSessionShareTab(sessionId: string, replace = false): void {
  const url = new URL(window.location.href);
  url.searchParams.set('tab', sessionId);
  if (url.href === window.location.href) return;
  if (replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
