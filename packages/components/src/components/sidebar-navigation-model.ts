import type { SidebarNavItem } from '@/atoms/focus-layer';
import type { SidebarOrganizeMode } from '@/atoms/sidebar-state';
import {
  buildGroups,
  getVisibleSessionGroupRows,
  MAX_VISIBLE_SESSIONS,
  SESSION_ROW_OPENED_BY_TREE_ACCESSORS,
  sessionGroupOverflowsPreview,
  type SessionRowGroup,
  type SessionListProjectGroupState,
  type SessionListRepoState,
  type SessionListRow,
} from '@/components/session-list';
import { buildOpenedBySessionTree, countOpenedByTreeRoots } from '@/lib/session-opened-by-tree';
import { isSidebarBucketCollapsed } from '@/lib/sidebar-status-group';
import {
  buildSidebarUpdatedBuckets,
  getVisibleUpdatedItems,
  sortUpdatedItems,
  SIDEBAR_UPDATED_OPENED_BY_TREE_ACCESSORS,
  updatedBucketCanFold,
  type SidebarUpdatedBucketKey,
  type SidebarUpdatedItem,
} from '@/components/sidebar-updated-session-list';

type SidebarNavigationLocalProject = {
  machineId: string;
  localProjectId: string;
  collapsed: boolean;
  /** Extra top-level rows revealed beyond the preview, like the render. */
  revealedRows: number;
  sessions: Array<{
    id: string;
    /** Sidebar row to nest under; resolved by the sidebar (child Tab → root). */
    openedByRowSessionId?: string | null;
    /** Effective latest activity, so nav ranks groups exactly like the render. */
    rootRankMs?: number;
  }>;
};

export function getLocalProjectSessionGroupKey(machineId: string, localProjectId: string): string {
  return `local-project:${machineId}:${localProjectId}`;
}

export type SidebarNavigationLocalSection = {
  collapsed: boolean;
  projects: SidebarNavigationLocalProject[];
  /**
   * Multi-repository projects that need this machine, listed after its
   * folders, with the conversations filed under them.
   */
  projectGroups?: SessionListProjectGroupState[];
  projectGroupSessions?: SessionListRow[];
};

export type SidebarNavigationModelOptions = {
  organizeMode: SidebarOrganizeMode;
  /** Extra top-level rows each capped group reveals beyond the preview. */
  revealedRowsByGroup: Record<string, number>;
  /**
   * Opener session ids whose opened Sessions are collapsed in the sidebar tree.
   * Keyboard navigation must skip rows the user cannot see.
   */
  collapsedOpenedBySessions?: Record<string, boolean>;
  pinnedItems?: SidebarUpdatedItem[];
  pinnedSectionCollapsed?: boolean;
  /**
   * Pin sections as rendered (default first, rows in manual order). When
   * present it replaces {@link pinnedItems}/{@link pinnedSectionCollapsed}.
   */
  pinnedSections?: readonly SidebarNavPinSection[];
  workspace: {
    localSections: SidebarNavigationLocalSection[];
    githubSectionCollapsed: boolean;
    /** Includes the conversations of the multi-repository projects listed here. */
    repoSessions: SessionListRow[];
    repos: SessionListRepoState[];
    /** Multi-repository projects that run on any machine, listed with GitHub. */
    projectGroups?: SessionListProjectGroupState[];
    chatSessions: SessionListRow[];
    chatsCollapsed: boolean;
  };
  /** Rows of the Updated and Status organize modes, which split them differently. */
  updated: {
    items: SidebarUpdatedItem[];
    /** Per-section collapse state; missing keys are expanded. */
    collapsedBuckets: Partial<Record<SidebarUpdatedBucketKey, boolean>>;
    /** Per-section incremental reveal; missing keys show the preview. */
    revealedRowsByBucket: Partial<Record<SidebarUpdatedBucketKey, number>>;
  };
};

function emitSessionGroup(
  items: SidebarNavItem[],
  group: SessionRowGroup,
  revealedRowsByGroup: Record<string, number>,
  collapsedOpenedBySessions: Record<string, boolean>
): void {
  items.push({ kind: 'group-header', groupKey: group.key, collapsed: group.collapsed });
  if (group.collapsed) return;

  const revealedRows = revealedRowsByGroup[group.key] ?? 0;
  for (const session of getVisibleSessionGroupRows(
    group,
    revealedRows,
    collapsedOpenedBySessions
  )) {
    items.push({ kind: 'session', sessionId: session.sessionId, groupKey: group.key });
  }

  if (sessionGroupOverflowsPreview(group)) {
    if (
      countOpenedByTreeRoots(group.sessions, SESSION_ROW_OPENED_BY_TREE_ACCESSORS) >
      MAX_VISIBLE_SESSIONS + revealedRows
    ) {
      items.push({ kind: 'show-more', groupKey: group.key });
    }
    if (revealedRows > 0) {
      items.push({ kind: 'show-less', groupKey: group.key });
    }
  }
}

function emitLocalSections(
  items: SidebarNavItem[],
  sections: SidebarNavigationLocalSection[],
  revealedRowsByGroup: Record<string, number>,
  collapsedOpenedBySessions: Record<string, boolean>
): void {
  for (const section of sections) {
    if (section.collapsed) continue;
    emitLocalProjects(items, section, collapsedOpenedBySessions);
    if (section.projectGroups?.length) {
      for (const group of buildGroups(
        section.projectGroupSessions ?? [],
        [],
        false,
        undefined,
        section.projectGroups
      )) {
        emitSessionGroup(items, group, revealedRowsByGroup, collapsedOpenedBySessions);
      }
    }
  }
}

function emitLocalProjects(
  items: SidebarNavItem[],
  section: SidebarNavigationLocalSection,
  collapsedOpenedBySessions: Record<string, boolean>
): void {
  for (const project of section.projects) {
    const projectKey = getLocalProjectSessionGroupKey(project.machineId, project.localProjectId);
    items.push({
      kind: 'local-project',
      machineId: project.machineId,
      localProjectId: project.localProjectId,
      collapsed: project.collapsed,
    });
    if (project.collapsed) continue;
    // Same opened-by tree the local project section renders, so arrow keys
    // never land on a row hidden behind a collapsed opener.
    const nodes = buildOpenedBySessionTree(project.sessions, {
      getId: (session) => session.id,
      getOpenedBySessionId: (session) => session.openedByRowSessionId ?? null,
      isCollapsed: (openerId) => collapsedOpenedBySessions[openerId] === true,
      rootRank: (session) => session.rootRankMs ?? 0,
      maxRoots: MAX_VISIBLE_SESSIONS + project.revealedRows,
    });
    for (const node of nodes) {
      items.push({ kind: 'session', sessionId: node.item.id, groupKey: projectKey });
    }
    const rootCount = countOpenedByTreeRoots(project.sessions, {
      getId: (session) => session.id,
      getOpenedBySessionId: (session) => session.openedByRowSessionId ?? null,
    });
    if (rootCount > MAX_VISIBLE_SESSIONS) {
      if (rootCount > MAX_VISIBLE_SESSIONS + project.revealedRows) {
        items.push({ kind: 'show-more', groupKey: projectKey });
      }
      if (project.revealedRows > 0) {
        items.push({ kind: 'show-less', groupKey: projectKey });
      }
    }
  }
}

export type SidebarNavPinSection = {
  id: string | null;
  items: SidebarUpdatedItem[];
  collapsed: boolean;
};

export function buildSidebarNavigationItems({
  organizeMode,
  revealedRowsByGroup,
  collapsedOpenedBySessions = {},
  pinnedItems = [],
  pinnedSectionCollapsed = false,
  pinnedSections,
  workspace,
  updated,
}: SidebarNavigationModelOptions): SidebarNavItem[] {
  const items: SidebarNavItem[] = [];

  if (pinnedSections) {
    for (const section of pinnedSections) {
      if (section.collapsed) continue;
      // Manual order: roots stay where the user put them, nesting as rendered.
      const nodes = buildOpenedBySessionTree(section.items, {
        ...SIDEBAR_UPDATED_OPENED_BY_TREE_ACCESSORS,
        isCollapsed: (openerId) => collapsedOpenedBySessions[openerId] === true,
      });
      for (const node of nodes) {
        items.push({ kind: 'session', sessionId: node.item.id, groupKey: '__pinned__' });
      }
    }
  } else if (!pinnedSectionCollapsed) {
    // The Pinned section renders through the same list component, so it gets the
    // same opened-by tree, including descendants placed here with a pinned opener.
    const pinnedNodes = buildOpenedBySessionTree(sortUpdatedItems(pinnedItems), {
      ...SIDEBAR_UPDATED_OPENED_BY_TREE_ACCESSORS,
      isCollapsed: (openerId) => collapsedOpenedBySessions[openerId] === true,
    });
    for (const node of pinnedNodes) {
      items.push({ kind: 'session', sessionId: node.item.id, groupKey: '__pinned__' });
    }
  }

  if (organizeMode === 'updated' || organizeMode === 'status') {
    const grouping = organizeMode === 'updated' ? 'recency' : 'status';
    for (const bucket of buildSidebarUpdatedBuckets(updated.items, grouping)) {
      if (isSidebarBucketCollapsed(bucket.key, updated.collapsedBuckets)) continue;
      const groupKey = bucket.key === 'all' ? '__updated__' : `__status:${bucket.key}__`;
      for (const item of getVisibleUpdatedItems(
        bucket.items,
        updatedBucketCanFold(bucket.key),
        updated.revealedRowsByBucket[bucket.key] ?? 0,
        collapsedOpenedBySessions,
        bucket.key === 'focus' || bucket.key === 'later'
      )) {
        items.push({ kind: 'session', sessionId: item.id, groupKey });
      }
    }
    return items;
  }

  emitLocalSections(items, workspace.localSections, revealedRowsByGroup, collapsedOpenedBySessions);

  if (!workspace.githubSectionCollapsed) {
    for (const group of buildGroups(
      workspace.repoSessions,
      workspace.repos,
      false,
      undefined,
      workspace.projectGroups
    )) {
      emitSessionGroup(items, group, revealedRowsByGroup, collapsedOpenedBySessions);
    }
  }

  for (const group of buildGroups(workspace.chatSessions, [], workspace.chatsCollapsed)) {
    emitSessionGroup(items, group, revealedRowsByGroup, collapsedOpenedBySessions);
  }

  return items;
}
