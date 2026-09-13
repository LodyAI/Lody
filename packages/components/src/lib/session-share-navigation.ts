import type { SharePackageManifest } from '@lody/shared/session-sharing';

export function resolveSharePanes(manifest: SharePackageManifest, selectedId: string) {
  const selected =
    manifest.conversations.find((entry) => entry.id === selectedId) ??
    manifest.conversations.find((entry) => entry.id === manifest.rootConversationId)!;
  const root =
    manifest.conversations.find((entry) => entry.id === selected.parentConversationId) ?? selected;
  // The reader has no right pane, so a side-panel child is a Tab like any other
  // child. It must stay reachable: the publisher chose to publish it, and a
  // pane the reader dropped would silently remove it from the share.
  const tabs = manifest.conversations.filter(
    (entry) => entry.id === root.id || entry.parentConversationId === root.id
  );
  return { root, tabs, main: selected };
}

/** The manifest, never a requested URL target, grants access. */
export function resolveSessionShareTab(
  manifest: SharePackageManifest | null,
  search: string
): string | null {
  if (!manifest) return null;
  const requested = new URLSearchParams(search).get('tab');
  return manifest.conversations.some((target) => target.id === requested)
    ? requested
    : manifest.rootConversationId;
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
  // A link minted while the reader still had a right pane must not keep
  // pinning one; there is nothing left to select.
  url.searchParams.delete('side');
  if (url.href === window.location.href) return;
  if (replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
