import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import { currentWorkspaceIdAtom } from './workspace-context';

/**
 * Sidebar state atoms with localStorage persistence
 *
 * WHY: Previously, sidebar UI state (chat scope, repo collapse, repo order, etc.) was stored
 * in local React useState within LoroAppSidebar. This caused several issues:
 *
 * 1. On mobile, opening/closing the sidebar drawer would reset all state because the
 *    component re-mounts, losing user preferences like which repos are collapsed.
 *
 * 2. Page refresh would lose all sidebar customizations (repo order, collapse states,
 *    My/Team tasks filter), forcing users to re-configure every time.
 *
 * 3. State couldn't be shared across components if needed in the future.
 *
 * SOLUTION: Use jotai atoms with `atomWithStorage` to:
 * - Persist state to localStorage automatically
 * - Provide global state that survives component unmount/remount
 * - Follow existing patterns in the codebase (see settings.ts for similar usage)
 *
 * These atoms manage:
 * - Chat scope (my/team tasks filter)
 * - Repo collapse states
 * - Repo ordering
 * - Pinned section collapsed state
 * - Chats section collapsed state
 */

// ============================================================================
// Chat Scope (My Tasks / Team Tasks)
// ============================================================================

export type SidebarChatScope = 'my' | 'team';

/**
 * Chat scope filter - persisted to localStorage
 * 'my' = Show only current user's tasks
 * 'team' = Show all team tasks
 *
 * Default to the team view so a participant who has not chosen a scope sees
 * the complete workspace. An explicit choice remains persisted below.
 */
export const chatScopeAtom = atomWithStorage<SidebarChatScope>('lody-sidebar-chat-scope', 'team');

// ============================================================================
// Repo State (Collapse + Ordering)
// ============================================================================

export type RepoCollapseState = Record<string, boolean>;

/**
 * Repo collapse states - persisted to localStorage
 * Key: repoFullName, Value: collapsed (true/false)
 */
export const repoCollapseStateAtom = atomWithStorage<RepoCollapseState>(
  'lody-sidebar-repo-collapse',
  {}
);

/**
 * Per-workspace repo ordering, persisted to localStorage as
 * `{ [workspaceId]: string[] }`. Use `repoOrderAtom` for the current workspace.
 */
const repoOrderByWorkspaceAtom = atomWithStorage<Record<string, string[]>>(
  'lody-sidebar-repo-order-by-workspace',
  {}
);

/**
 * BC-2026-04-17-SIDEBAR-REPO-ORDER-LEGACY-FALLBACK
 *
 * Pre-workspace-scoping, repo order was stored globally under
 * `lody-sidebar-repo-order`. If a workspace has no entry in the new
 * per-workspace map yet, we read the legacy value once as a default so users
 * don't lose their saved order on first load after the upgrade. The legacy
 * value is never written — first real write (drag or new repo discovery)
 * persists under the new per-workspace key.
 */
const LEGACY_REPO_ORDER_KEY = 'lody-sidebar-repo-order';
function readLegacyRepoOrder(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LEGACY_REPO_ORDER_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string');
  } catch {
    return [];
  }
}

const EMPTY_REPO_ORDER: readonly string[] = Object.freeze([]);

/**
 * Repo order scoped to the current workspace. Reading outside a workspace
 * returns an empty array; writing outside a workspace is a no-op.
 */
export const repoOrderAtom = atom<readonly string[], [readonly string[]], void>(
  (get) => {
    const workspaceId = get(currentWorkspaceIdAtom);
    if (!workspaceId) return EMPTY_REPO_ORDER;
    const map = get(repoOrderByWorkspaceAtom);
    const saved = map[workspaceId];
    if (saved !== undefined) return saved;
    return readLegacyRepoOrder();
  },
  (get, set, value) => {
    const workspaceId = get(currentWorkspaceIdAtom);
    if (!workspaceId) return;
    const map = get(repoOrderByWorkspaceAtom);
    set(repoOrderByWorkspaceAtom, {
      ...map,
      [workspaceId]: [...value],
    });
  }
);

/**
 * Update repo collapse state for a specific repo
 */
export const toggleRepoCollapsedAtom = atom(null, (get, set, repoFullName: string) => {
  const current = get(repoCollapseStateAtom);
  set(repoCollapseStateAtom, {
    ...current,
    [repoFullName]: !current[repoFullName],
  });
});

/**
 * Set repo order for the current workspace.
 */
export const setRepoOrderAtom = atom(null, (_get, set, order: string[]) => {
  set(repoOrderAtom, order);
});

// ============================================================================
// Chats Section Collapsed
// ============================================================================

/**
 * Chats section collapsed state - persisted to localStorage
 */
export const chatsCollapsedAtom = atomWithStorage<boolean>('lody-sidebar-chats-collapsed', false);

/**
 * Toggle chats section collapsed state
 */
export const toggleChatsCollapsedAtom = atom(null, (get, set) => {
  set(chatsCollapsedAtom, !get(chatsCollapsedAtom));
});

/**
 * Pinned section collapsed state - persisted to localStorage
 */
export const pinnedSectionCollapsedAtom = atomWithStorage<boolean>(
  'lody-sidebar-pinned-section-collapsed',
  false
);

// ============================================================================
// Local Project Collapse State (folders under Local Projects / <Machine> project)
// ============================================================================

export type LocalProjectCollapseState = Record<string, boolean>;

/**
 * Local project collapse states - persisted to localStorage
 * Key: `${machineId}:${localProjectId}`, Value: collapsed (true/false)
 */
export const localProjectCollapseStateAtom = atomWithStorage<LocalProjectCollapseState>(
  'lody-sidebar-local-project-collapse',
  {}
);

// ============================================================================
// Section Collapsed (Local Projects + GitHub Worktrees headers)
// ============================================================================

/**
 * Local Projects section header collapsed state (per machine section) - persisted.
 * Key: section.machineId ?? section.kind, Value: collapsed (true/false)
 */
export const localProjectsSectionCollapseStateAtom = atomWithStorage<Record<string, boolean>>(
  'lody-sidebar-local-projects-section-collapse',
  {}
);

/**
 * Whether the "GitHub Worktrees" section header is collapsed - persisted.
 */
export const githubWorktreesSectionCollapsedAtom = atomWithStorage<boolean>(
  'lody-sidebar-github-worktrees-section-collapsed',
  false
);

// ============================================================================
// Sidebar Collapsed (Desktop)
// ============================================================================

/**
 * Whether the desktop left sidebar is collapsed (fully hidden). Persisted.
 * Mobile uses `mobileDrawerOpenAtom` and ignores this.
 */
export const sidebarCollapsedAtom = atomWithStorage<boolean>('lody-sidebar-collapsed', false);

/**
 * Last expanded width in px. Restored when the user re-opens the sidebar so
 * width preference survives collapse/expand cycles. 0 means "use default".
 */
export const sidebarLastWidthAtom = atomWithStorage<number>('lody-sidebar-last-width', 0);

// ============================================================================
// Sidebar Organize Mode (Workspace vs Updated)
// ============================================================================

export type SidebarOrganizeMode = 'workspace' | 'updated';

/**
 * How the sidebar groups items.
 * - 'workspace' = group by Chats / Local Projects / GitHub Worktrees (default)
 * - 'updated'   = single flat list sorted by latest-update recency
 */
export const sidebarOrganizeModeAtom = atomWithStorage<SidebarOrganizeMode>(
  'lody-sidebar-organize-mode',
  'workspace'
);

/**
 * Per-bucket collapse state for the Updated organize mode.
 * Keyed by the single 'all' bucket; value is whether collapsed. (Persisted
 * entries from the retired today/week/older buckets are simply ignored.)
 */
export const sidebarUpdatedBucketCollapseStateAtom = atomWithStorage<Record<string, boolean>>(
  'lody-sidebar-updated-bucket-collapse',
  {}
);

/**
 * Per-bucket "show all" state for the Updated organize mode. Buckets above the
 * preview threshold default to a compact preview; this map records which
 * buckets the user has explicitly expanded. Mirrors the pattern that
 * `sidebarShowFullListAtom` uses for Workspace task groups, but keyed by the
 * single 'all' bucket.
 */
export const sidebarUpdatedBucketShowFullStateAtom = atomWithStorage<Record<string, boolean>>(
  'lody-sidebar-updated-bucket-show-full',
  {}
);

// ============================================================================
// Archive Scope (My Tasks / All Tasks for archive view)
// ============================================================================

export type ArchiveScopeValue = 'my' | 'team';

/**
 * Archive scope filter - persisted to localStorage
 * 'my' = Show only current user's archived sessions
 * 'team' = Show all team archived sessions
 */
export const archiveScopeAtom = atomWithStorage<ArchiveScopeValue>('lody-archive-scope', 'my');
