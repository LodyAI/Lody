import { buildSessionLink, parseSessionLink, type SessionLink } from '@lody/shared/session-link';
import { atom, type createStore } from 'jotai';
import type { WorkspacesState } from '@lody/platform';
import { formatExplicitSessionTabSearch } from './session-tab-url';

export const pendingSessionLinkAtom = atom<SessionLink | null>(null);
export const SESSION_LINK_LOAD_TIMEOUT_MS = 15_000;

/** Own only this request: a stale failure/timeout must not clear a newer click. */
export function watchSessionLinkRequest(
  store: ReturnType<typeof createStore>,
  target: SessionLink,
  onTimeout: () => void
): () => void {
  const timer = setTimeout(() => {
    if (store.get(pendingSessionLinkAtom) !== target) return;
    store.set(pendingSessionLinkAtom, null);
    onTimeout();
  }, SESSION_LINK_LOAD_TIMEOUT_MS);
  return () => clearTimeout(timer);
}

/** Parent redirects may change the route ID, but must retain the exact child tab. */
export function isSessionLinkDestination(
  target: SessionLink,
  workspaceSlug: string,
  pathname: string,
  tab: unknown
): boolean {
  return (
    pathname.startsWith(`/${encodeURIComponent(workspaceSlug)}/sessions/`) &&
    tab === formatExplicitSessionTabSearch(target.tabSessionId ?? target.sessionId)
  );
}

export const SESSION_DEEP_LINK_EVENT = 'lody:open-session-link';

export function openSessionDeepLink(target: SessionLink): void {
  window.dispatchEvent(
    new CustomEvent(SESSION_DEEP_LINK_EVENT, { detail: buildSessionLink(target) })
  );
}

/** Paste only within the known source workspace; never reinterpret a foreign ID. */
export function readPastedSessionLink(raw: string, workspaceId: string | null): SessionLink | null {
  const link = parseSessionLink(raw.trim());
  return link && workspaceId && (!link.workspaceId || link.workspaceId === workspaceId)
    ? {
        sessionId: link.tabSessionId ?? link.sessionId,
        ...(link.workspaceId ? { workspaceId: link.workspaceId } : {}),
      }
    : null;
}

export function resolveSessionLinkWorkspace(
  link: SessionLink,
  workspaces: WorkspacesState,
  currentWorkspaceId: string | null
):
  | { kind: 'wait' }
  | { kind: 'unavailable'; workspaceId: string }
  | { kind: 'open'; workspaceId: string; slug: string } {
  if (workspaces.status !== 'ready' || !currentWorkspaceId) return { kind: 'wait' };
  const workspaceId = link.workspaceId ?? currentWorkspaceId;
  const workspace = workspaces.workspaces.find((item) => item.id === workspaceId);
  return workspace?.slug
    ? { kind: 'open', workspaceId, slug: workspace.slug }
    : { kind: 'unavailable', workspaceId };
}
