import { atom } from 'jotai';
import { isSessionWindow, windowStorage } from '@/lib/desktop-window';
import { atomWithStorage, createJSONStorage } from 'jotai/utils';
import { currentWorkspaceIdAtom } from './workspace-context';

/** In-memory viewport positions survive sidebar unmounts, scoped to each workspace. */
export const sidebarScrollTopByWorkspaceAtom = atom<Record<string, number>>({});

/**
 * Builds a Jotai JSON storage adapter that persists to `localStorage` (or the
 * given per-window storage) across mounts and reloads without subscribing to
 * cross-renderer `storage` events, so sidebar collapse and filter changes in
 * one renderer do not mutate other open renderers.
 */
function createRendererIsolatedJSONStorage<Value>(
  getStringStorage?: () => Storage
): ReturnType<typeof createJSONStorage<Value>> {
  const storage = getStringStorage
    ? createJSONStorage<Value>(getStringStorage)
    : createJSONStorage<Value>();
  return {
    getItem: storage.getItem,
    setItem: storage.setItem,
    removeItem: storage.removeItem,
  };
}

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
 * SOLUTION: Use jotai atoms with `atomWithStorage` and renderer-isolated storage to:
 * - Persist state to localStorage (or per-window storage) for new windows and reloads
 * - Provide global state within the current renderer that survives component unmount/remount
 * - Avoid live-syncing UI collapse and filter state across open renderers via `storage` events
 */

export type SidebarChatScope = 'my' | 'team';

/**
 * Chat scope filter - persisted to localStorage
 * 'my' = Show only current user's tasks
 * 'team' = Show all team tasks
 *
 * Default to the team view so a participant who has not chosen a scope sees
 * the complete workspace. An explicit choice remains persisted below.
 */
export const chatScopeAtom = atomWithStorage<SidebarChatScope>(
  'lody-sidebar-chat-scope',
  'team',
  createRendererIsolatedJSONStorage<SidebarChatScope>()
);

export type RepoCollapseState = Record<string, boolean>;

/**
 * Repo collapse states - persisted to localStorage
 * Key: repoFullName, Value: collapsed (true/false)
 */
export const repoCollapseStateAtom = atomWithStorage<RepoCollapseState>(
  'lody-sidebar-repo-collapse',
  {},
  createRendererIsolatedJSONStorage<RepoCollapseState>()
);

/**
 * Per-workspace repo ordering, persisted to localStorage as
 * `{ [workspaceId]: string[] }`. Use `repoOrderAtom` for the current workspace.
 */
const repoOrderByWorkspaceAtom = atomWithStorage<Record<string, string[]>>(
  'lody-sidebar-repo-order-by-workspace',
  {},
  createRendererIsolatedJSONStorage<Record<string, string[]>>()
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

/**
 * Chats section collapsed state - persisted to localStorage
 */
export const chatsCollapsedAtom = atomWithStorage<boolean>(
  'lody-sidebar-chats-collapsed',
  false,
  createRendererIsolatedJSONStorage<boolean>()
);

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
  false,
  createRendererIsolatedJSONStorage<boolean>()
);

/**
 * Folded user pin sections on this device, by section id (ids are unique
 * across workspaces). The default section keeps `pinnedSectionCollapsedAtom`.
 */
export const pinSectionsCollapsedAtom = atomWithStorage<Record<string, boolean>>(
  'lody-sidebar-pin-sections-collapsed',
  {},
  createRendererIsolatedJSONStorage<Record<string, boolean>>()
);

/**
 * Pin sections hidden on this device, keyed by `pinSectionKey(section.id)`
 * (`'default'` for the default section). The visibility menu on the Pinned
 * header can restore sections.
 */
export const pinSectionsHiddenAtom = atomWithStorage<Record<string, boolean>>(
  'lody-sidebar-pin-sections-hidden',
  {},
  createRendererIsolatedJSONStorage<Record<string, boolean>>()
);

export type LocalProjectCollapseState = Record<string, boolean>;

/**
 * Local project collapse states - persisted to localStorage
 * Key: `${machineId}:${localProjectId}`, Value: collapsed (true/false)
 */
export const localProjectCollapseStateAtom = atomWithStorage<LocalProjectCollapseState>(
  'lody-sidebar-local-project-collapse',
  {},
  createRendererIsolatedJSONStorage<LocalProjectCollapseState>()
);

/**
 * Per-workspace local-project ordering. Entries use the machine-qualified
 * `${machineId}:${localProjectId}` key because project ids are only unique
 * within their owning machine.
 */
const localProjectOrderByWorkspaceAtom = atomWithStorage<Record<string, string[]>>(
  'lody-sidebar-local-project-order-by-workspace',
  {},
  createRendererIsolatedJSONStorage<Record<string, string[]>>()
);

const EMPTY_LOCAL_PROJECT_ORDER: readonly string[] = Object.freeze([]);

/**
 * Local-project order scoped to the current workspace. Reading outside a
 * workspace returns an empty array; writing outside a workspace is a no-op.
 */
export const localProjectOrderAtom = atom<readonly string[], [readonly string[]], void>(
  (get) => {
    const workspaceId = get(currentWorkspaceIdAtom);
    if (!workspaceId) return EMPTY_LOCAL_PROJECT_ORDER;
    return get(localProjectOrderByWorkspaceAtom)[workspaceId] ?? EMPTY_LOCAL_PROJECT_ORDER;
  },
  (get, set, value) => {
    const workspaceId = get(currentWorkspaceIdAtom);
    if (!workspaceId) return;
    const map = get(localProjectOrderByWorkspaceAtom);
    set(localProjectOrderByWorkspaceAtom, {
      ...map,
      [workspaceId]: [...value],
    });
  }
);

/** Per-workspace Project group order: group ids, most recently arranged by the user. */
const projectGroupOrderByWorkspaceAtom = atomWithStorage<Record<string, string[]>>(
  'lody-sidebar-project-group-order-by-workspace',
  {},
  createRendererIsolatedJSONStorage<Record<string, string[]>>()
);

/** Project group order scoped to the current workspace, like `localProjectOrderAtom`. */
export const projectGroupOrderAtom = atom<readonly string[], [readonly string[]], void>(
  (get) => {
    const workspaceId = get(currentWorkspaceIdAtom);
    if (!workspaceId) return EMPTY_LOCAL_PROJECT_ORDER;
    return get(projectGroupOrderByWorkspaceAtom)[workspaceId] ?? EMPTY_LOCAL_PROJECT_ORDER;
  },
  (get, set, value) => {
    const workspaceId = get(currentWorkspaceIdAtom);
    if (!workspaceId) return;
    const map = get(projectGroupOrderByWorkspaceAtom);
    set(projectGroupOrderByWorkspaceAtom, { ...map, [workspaceId]: [...value] });
  }
);

/**
 * Reorder the visible projects in one machine section while retaining saved
 * entries that are currently absent or belong to another machine.
 */
export function moveLocalProjectOrder(
  persistedOrder: readonly string[],
  visibleKeys: readonly string[],
  activeKey: string,
  overKey: string
): readonly string[] | null {
  const fromIndex = visibleKeys.indexOf(activeKey);
  const toIndex = visibleKeys.indexOf(overKey);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return null;

  const nextVisibleOrder = [...visibleKeys];
  const [moved] = nextVisibleOrder.splice(fromIndex, 1);
  if (!moved) return null;
  nextVisibleOrder.splice(toIndex, 0, moved);

  const visibleSet = new Set(visibleKeys);
  return [...nextVisibleOrder, ...persistedOrder.filter((key) => !visibleSet.has(key))];
}

/**
 * Local Projects section header collapsed state (per machine section) - persisted.
 * Key: section.machineId ?? section.kind, Value: collapsed (true/false)
 */
export const localProjectsSectionCollapseStateAtom = atomWithStorage<Record<string, boolean>>(
  'lody-sidebar-local-projects-section-collapse',
  {},
  createRendererIsolatedJSONStorage<Record<string, boolean>>()
);

/**
 * Whether the "GitHub Worktrees" section header is collapsed - persisted.
 */
export const githubWorktreesSectionCollapsedAtom = atomWithStorage<boolean>(
  'lody-sidebar-github-worktrees-section-collapsed',
  false,
  createRendererIsolatedJSONStorage<boolean>()
);

/**
 * Whether the desktop left sidebar is collapsed (fully hidden). Persisted.
 * Mobile uses `mobileDrawerOpenAtom` and ignores this.
 */
export const sidebarCollapsedAtom: ReturnType<typeof atomWithStorage<boolean>> =
  atomWithStorage<boolean>(
    'lody-sidebar-collapsed',
    isSessionWindow(),
    createRendererIsolatedJSONStorage<boolean>(windowStorage),
    { getOnInit: true }
  );

/** Today pinned as a column next to the sidebar (specs/today-outline.md); per window. */
export const todayPinnedAtom: ReturnType<typeof atomWithStorage<boolean>> =
  atomWithStorage<boolean>(
    'lody-today-pinned',
    false,
    createRendererIsolatedJSONStorage<boolean>(windowStorage),
    { getOnInit: true }
  );

/**
 * A day opened while pinned (a Today link, or the sidebar entry with `{}` for
 * today): the column shows this member/date and clears it (in memory only).
 */
export const todayPinnedTargetAtom = atom<{ member?: string; date?: string } | null>(null);

/**
 * Today page spans the whole main area instead of the readable column
 * (specs/today-outline.md); a preference stored on this device.
 */
export const todayFullWidthAtom = atomWithStorage<boolean>(
  'lody-today-full-width',
  false,
  createRendererIsolatedJSONStorage<boolean>(),
  {
    getOnInit: true,
  }
);

export const TODAY_COLUMN_DEFAULT_WIDTH = 360;
export const TODAY_COLUMN_MIN_WIDTH = 280;
export const TODAY_COLUMN_MAX_WIDTH = 560;

/** Width of the pinned Today column in px; stored on this device. */
export const todayColumnWidthAtom = atomWithStorage<number>(
  'lody-today-column-width',
  TODAY_COLUMN_DEFAULT_WIDTH,
  createRendererIsolatedJSONStorage<number>(),
  { getOnInit: true }
);

/**
 * Last expanded width in px. Restored when the user re-opens the sidebar so
 * width preference survives collapse/expand cycles. 0 means "use default".
 * Read synchronously so React's first boot frame matches the document shell.
 */
export const sidebarLastWidthAtom = atomWithStorage<number>(
  'lody-sidebar-last-width',
  0,
  createRendererIsolatedJSONStorage<number>(),
  { getOnInit: true }
);

export type SidebarOrganizeMode = 'workspace' | 'updated' | 'status';

/**
 * How the sidebar groups items.
 * - 'workspace' = group by Chats / Local Projects / GitHub Worktrees (default)
 * - 'updated'   = single flat list sorted by latest-update recency
 * - 'status'    = the Status view: Pinned, then Focus / Later / Settled
 *                 (`specs/sidebar-status-view.md`)
 */
export const sidebarOrganizeModeAtom = atomWithStorage<SidebarOrganizeMode>(
  'lody-sidebar-organize-mode',
  'workspace',
  createRendererIsolatedJSONStorage<SidebarOrganizeMode>()
);

/**
 * Updated mode mixes every project into one recency list. When true, top-level
 * rows show the project mark and name under the title. Nested opened Sessions
 * stay one line. Workspace mode ignores this preference because its group
 * headers already identify each project.
 */
export const sidebarUpdatedShowProjectNamesAtom = atomWithStorage<boolean>(
  'lody-sidebar-updated-show-project-names',
  true,
  createRendererIsolatedJSONStorage<boolean>()
);

/**
 * Whether rows show the branch on their second (meta) line wherever one
 * exists: top-level GitHub and local-worktree rows in Workspace mode and
 * top-level repo rows in Updated mode. It defaults off so branch metadata does
 * not add a second line until the user opts in. Pairs with
 * `sidebarUpdatedShowProjectNamesAtom` as the two switches of the filter
 * popover's Details group — both stay interactive in every organize mode and
 * each segment simply appears where the row carries it.
 */
export const sidebarShowBranchNamesAtom = atomWithStorage<boolean>(
  'lody-sidebar-show-branch-names',
  false,
  createRendererIsolatedJSONStorage<boolean>()
);

/**
 * Project (Workspace) organize mode only: when true, a project with no visible
 * Session rows is left out of the sidebar, and a machine section with no
 * remaining projects goes with it. When false, every registered local project
 * and every workspace project is listed, empty or not. Defaults on.
 */
export const sidebarHideEmptyProjectsAtom = atomWithStorage<boolean>(
  'lody-sidebar-hide-empty-projects',
  true,
  createRendererIsolatedJSONStorage<boolean>()
);

/**
 * Per-bucket collapse state for the Updated and Status organize modes.
 * Keyed by Updated's single 'all' bucket and by each status group; value is
 * whether collapsed. (Persisted entries from the retired today/week/older
 * buckets are simply ignored.)
 */
export const sidebarUpdatedBucketCollapseStateAtom = atomWithStorage<Record<string, boolean>>(
  'lody-sidebar-updated-bucket-collapse',
  {},
  createRendererIsolatedJSONStorage<Record<string, boolean>>()
);

const storedUpdatedBucketRevealRowsAtom = atomWithStorage<Record<string, number | boolean>>(
  'lody-sidebar-updated-bucket-show-full',
  {},
  createRendererIsolatedJSONStorage<Record<string, number | boolean>>()
);

/**
 * Per-bucket incremental reveal for the Updated and Status organize modes:
 * extra top-level rows beyond the preview threshold. Buckets above the
 * threshold default to a compact preview; this map records how much further
 * each bucket was revealed through "Show more". Mirrors the pattern that
 * `sidebarRevealedRowsAtom` uses for Workspace task groups, keyed by Updated's
 * 'all' bucket and Status's 'settled' group. Persisted legacy boolean "show
 * all" values read as fully revealed.
 */
export const sidebarUpdatedBucketRevealedRowsAtom = atom(
  (get) => {
    const stored = get(storedUpdatedBucketRevealRowsAtom);
    let next: Record<string, number> | null = null;
    for (const [key, value] of Object.entries(stored)) {
      const rows =
        typeof value === 'number' && Number.isFinite(value) && value > 0
          ? Math.floor(value)
          : value === true
            ? Number.MAX_SAFE_INTEGER
            : 0;
      if (rows !== value) {
        next ??= { ...(stored as Record<string, number>) };
        next[key] = rows;
      }
    }
    return next ?? (stored as Record<string, number>);
  },
  (
    get,
    set,
    update: Record<string, number> | ((prev: Record<string, number>) => Record<string, number>)
  ) => {
    const current = get(sidebarUpdatedBucketRevealedRowsAtom);
    set(storedUpdatedBucketRevealRowsAtom, typeof update === 'function' ? update(current) : update);
  }
);

export type ArchiveScopeValue = 'my' | 'team';

/**
 * Archive scope filter - persisted to localStorage
 * 'my' = Show only current user's archived sessions
 * 'team' = Show all team archived sessions
 *
 * Default to the team view so a participant who has not chosen a scope sees
 * the complete workspace archive. An explicit choice remains persisted below.
 */
export const archiveScopeAtom = atomWithStorage<ArchiveScopeValue>(
  'lody-archive-scope',
  'team',
  createRendererIsolatedJSONStorage<ArchiveScopeValue>()
);
