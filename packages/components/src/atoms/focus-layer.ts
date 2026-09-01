import { atom } from 'jotai';

/** Group key for the "Chats" (no-repo) sidebar group. */
export const ONLY_CHATS_KEY = '__only_chats__';

export const WORKSPACE_FOCUS_SCOPES = {
  chatLanding: 'chat-landing',
  sessionConversation: 'session-conversation',
  sessionSidePanel: 'session-side-panel',
  sidebar: 'workspace-sidebar',
  content: 'workspace-content',
} as const;

/**
 * Represents a navigable item in the sidebar flat list.
 */
export type SidebarNavItem =
  | { kind: 'group-header'; groupKey: string; collapsed: boolean }
  | { kind: 'session'; sessionId: string; groupKey: string }
  | { kind: 'show-more'; groupKey: string; expanded: boolean }
  | { kind: 'local-project'; machineId: string; localProjectId: string; collapsed: boolean };

/**
 * Flat list of navigable sidebar items, written by the sidebar and read by
 * the keyboard navigation handler.
 */
export const sidebarNavItemsAtom = atom<SidebarNavItem[]>([]);

/**
 * Callbacks from the sidebar for keyboard navigation actions.
 * Written by the sidebar component.
 */
export type SidebarNavCallbacks = {
  onNavigateToSession: (sessionId: string) => void;
  onNavigateToNewSession: (repoFullName?: string) => void;
  onToggleRepoCollapsed: (repoFullName: string) => void;
  onToggleChatsCollapsed: () => void;
  onToggleLocalProjectCollapsed?: (machineId: string, localProjectId: string) => void;
  getSelectedSessionId: () => string | null;
  getSessionGroupKey?: (sessionId: string) => string | null;
  isChatLanding: () => boolean;
};

export const sidebarNavCallbacksAtom = atom<SidebarNavCallbacks | null>(null);

/**
 * Per-group "show full list" toggle state, shared between SessionList and
 * keyboard navigation so the flat nav list stays in sync with the
 * rendered sidebar.
 */
export const sidebarShowFullListAtom = atom<Record<string, boolean>>({});

/**
 * Opener session ids whose MCP-opened independent Sessions are collapsed in the
 * sidebar tree (`lib/session-opened-by-tree.ts`). Absence means EXPANDED: the
 * opened Sessions are ordinary sidebar rows, so defaulting to collapsed would
 * hide conversations the user can see today. Shared with the keyboard
 * navigation model so the flat nav list matches what is rendered.
 */
export const sidebarCollapsedOpenedBySessionsAtom = atom<Record<string, boolean>>({});

/**
 * Fold/unfold one opener's Sessions. Every session list renders the same
 * disclosure, so the update lives here once instead of as an identical
 * `useCallback` in each of them.
 */
export const toggleSidebarCollapsedOpenedBySessionAtom = atom(
  null,
  (get, set, openerSessionId: string) => {
    const current = get(sidebarCollapsedOpenedBySessionsAtom);
    set(sidebarCollapsedOpenedBySessionsAtom, {
      ...current,
      [openerSessionId]: !current[openerSessionId],
    });
  }
);
