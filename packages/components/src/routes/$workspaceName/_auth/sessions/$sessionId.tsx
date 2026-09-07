import type { SessionId } from '@lody/shared';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { AppThemeShell } from '@/components/app-theme-shell';
import SessionDetail from '@/components/sessions/session-detail';
import { useIsMobile } from '@/hooks/use-mobile';
import { readStoredLastActiveTabState } from '@/lib/session-draft-tabs';
import { formatSessionTabSearch } from '@/lib/session-tab-url';

export type SessionDetailSearch = {
  tab?: string;
  /** When set, opens the PR sidebar tab (desktop) or full-screen PR view (mobile). */
  pr?: number;
  /** When true, opens the full-screen Browser view on mobile. */
  browser?: boolean;
};

const SessionDetailRoute = () => {
  const { sessionId } = Route.useParams();
  const search = Route.useSearch();
  const isMobile = useIsMobile();

  /* Do NOT wrap `SessionDetail` in `useDeferredValue` to make session switches
     interruptible. It renders faster, but `SessionDetail` IS the session
     identity boundary: it owns the composer's send path (`addSessionHistory` +
     `requestSessionDispatch(session.id, …)`) and registers the global
     `session.archiveCurrent` / `toggleCurrentPinned` / `renameCurrent` commands
     for whichever session it currently holds. Deferring it keeps the PREVIOUS
     session interactive while the URL and sidebar already show the next one, so
     a message typed in that window is written to the session the user just left
     — and no DOM-level guard closes it, because the command registry is not in
     the DOM. Any interruptible-switch work has to put the deferral boundary
     BELOW session identity (read-only transcript only). */

  /* On mobile the session detail is rendered by `MobileWorkspaceStack` as a
     drawer layered over the persistent home/project base, so back reveals the
     base live (mirroring the session ↔ PR relationship). The stack reads this
     route's params/search directly, so the route itself renders nothing. */
  if (isMobile) {
    return null;
  }

  return (
    <AppThemeShell>
      <SessionDetail
        sessionId={sessionId as SessionId}
        urlTab={search.tab}
        urlPrNumber={search.pr}
        urlBrowser={search.browser}
      />
    </AppThemeShell>
  );
};

const parsePrNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    if (parsed > 0) return parsed;
  }
  return undefined;
};

const parseBrowserFlag = (value: unknown): boolean | undefined => {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if (normalized === '1' || normalized === 'true') return true;
  }
  return undefined;
};

export const Route = createFileRoute('/$workspaceName/_auth/sessions/$sessionId')({
  validateSearch: (search: Record<string, unknown>): SessionDetailSearch => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
    pr: parsePrNumber(search.pr),
    browser: parseBrowserFlag(search.browser),
  }),
  /* Entry-scoped last-active-tab restoration. An ABSENT `?tab` means "no
     explicit choice" (external entries: sidebar rows, notifications, pasted
     URLs) and is filled in from the per-session last-active store as ONE
     replace redirect before anything renders. In-session tab activation
     always writes an explicit value — the parent tab included
     (`formatExplicitSessionTabSearch`) — so a user's return to the parent is
     never re-restored, and the replace keeps tab-less entries out of the
     history stack. This is the only non-user `?tab` writer; `SessionDetail`
     itself never rewrites the URL from derived state. */
  beforeLoad: ({ params, search }) => {
    if (search.tab !== undefined) {
      return;
    }
    const storedTabId = readStoredLastActiveTabState(params.sessionId as SessionId)?.sessionTabId;
    const tab = storedTabId ? formatSessionTabSearch(storedTabId, params.sessionId) : undefined;
    if (tab === undefined) {
      return;
    }
    throw redirect({
      to: '/$workspaceName/sessions/$sessionId',
      params,
      search: { ...search, tab },
      replace: true,
    });
  },
  component: SessionDetailRoute,
});
