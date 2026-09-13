import type { SharePackageManifest } from '@lody/shared/session-sharing';

export function resolveSharePanes(
  manifest: SharePackageManifest,
  selectedId: string,
  sideId?: string | null
) {
  const selected =
    manifest.conversations.find((entry) => entry.id === selectedId) ??
    manifest.conversations.find((entry) => entry.id === manifest.rootConversationId)!;
  const root =
    manifest.conversations.find((entry) => entry.id === selected.parentConversationId) ?? selected;
  const tabs = manifest.conversations.filter(
    (entry) =>
      entry.id === root.id ||
      (entry.parentConversationId === root.id && entry.childSessionPlacement !== 'side-panel')
  );
  const sides = manifest.conversations.filter(
    (entry) =>
      entry.parentConversationId === root.id && entry.childSessionPlacement === 'side-panel'
  );
  return {
    root,
    tabs,
    sides,
    main: selected.childSessionPlacement === 'side-panel' ? root : selected,
    side:
      sides.find((entry) => entry.id === sideId) ??
      (selected.childSessionPlacement === 'side-panel' ? selected : sides[0]),
  };
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
export function navigateSessionShareTab(
  sessionId: string,
  replace = false,
  pane: 'main' | 'side' = 'main'
): void {
  const url = new URL(window.location.href);
  url.searchParams.set(pane === 'side' ? 'side' : 'tab', sessionId);
  if (url.href === window.location.href) return;
  if (replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
