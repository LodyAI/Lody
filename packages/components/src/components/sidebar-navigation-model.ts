import type { SidebarNavItem } from '@/atoms/focus-layer';
import type { SidebarOrganizeMode } from '@/atoms/sidebar-state';
import {
  buildGroups,
  getVisibleSessionGroupRows,
  MAX_VISIBLE_SESSIONS,
  sessionGroupOverflowsPreview,
  type SessionRowGroup,
  type SessionListRepoState,
  type SessionListRow,
} from '@/components/session-list';
import { buildOpenedBySessionTree, countOpenedByTreeRoots } from '@/lib/session-opened-by-tree';
import {
  getVisibleUpdatedItems,
  sortUpdatedItems,
  SIDEBAR_UPDATED_OPENED_BY_TREE_ACCESSORS,
  type SidebarUpdatedItem,
} from '@/components/sidebar-updated-session-list';

type SidebarNavigationLocalProject = {
  machineId: string;
  localProjectId: string;
  collapsed: boolean;
  showFull: boolean;
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
};

export type SidebarNavigationModelOptions = {
  organizeMode: SidebarOrganizeMode;
  showFullSessionGroups: Record<string, boolean>;
  /**
   * Opener session ids whose opened Sessions are collapsed in the sidebar tree.
   * Keyboard navigation must skip rows the user cannot see.
   */
  collapsedOpenedBySessions?: Record<string, boolean>;
  pinnedItems: SidebarUpdatedItem[];
  pinnedSectionCollapsed: boolean;
  workspace: {
    localSections: SidebarNavigationLocalSection[];
    githubSectionCollapsed: boolean;
    repoSessions: SessionListRow[];
    repos: SessionListRepoState[];
    chatSessions: SessionListRow[];
    chatsCollapsed: boolean;
  };
  updated: {
    items: SidebarUpdatedItem[];
    collapsed: boolean;
    showFull: boolean;
  };
};

function emitSessionGroup(
  items: SidebarNavItem[],
  group: SessionRowGroup,
  showFullSessionGroups: Record<string, boolean>,
  collapsedOpenedBySessions: Record<string, boolean>
): void {
  items.push({ kind: 'group-header', groupKey: group.key, collapsed: group.collapsed });
  if (group.collapsed) return;

  const showFull = showFullSessionGroups[group.key] ?? false;
  for (const session of getVisibleSessionGroupRows(group, showFull, collapsedOpenedBySessions)) {
    items.push({ kind: 'session', sessionId: session.sessionId, groupKey: group.key });
  }

  if (sessionGroupOverflowsPreview(group)) {
    items.push({ kind: 'show-more', groupKey: group.key, expanded: showFull });
  }
}

function emitLocalSections(
  items: SidebarNavItem[],
  sections: SidebarNavigationLocalSection[],
  collapsedOpenedBySessions: Record<string, boolean>
): void {
  for (const section of sections) {
    if (section.collapsed) continue;
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
        ...(project.showFull ? {} : { maxRoots: MAX_VISIBLE_SESSIONS }),
      });
      for (const node of nodes) {
        items.push({ kind: 'session', sessionId: node.item.id, groupKey: projectKey });
      }
      if (
        countOpenedByTreeRoots(project.sessions, {
          getId: (session) => session.id,
          getOpenedBySessionId: (session) => session.openedByRowSessionId ?? null,
        }) > MAX_VISIBLE_SESSIONS
      ) {
        items.push({ kind: 'show-more', groupKey: projectKey, expanded: project.showFull });
      }
    }
  }
}

export function buildSidebarNavigationItems({
  organizeMode,
  showFullSessionGroups,
  collapsedOpenedBySessions = {},
  pinnedItems,
  pinnedSectionCollapsed,
  workspace,
  updated,
}: SidebarNavigationModelOptions): SidebarNavItem[] {
  const items: SidebarNavItem[] = [];

  if (!pinnedSectionCollapsed) {
    // The Pinned section renders through the same list component, so it gets the
    // same opened-by tree — resolved inside the pinned items ONLY, which is what
    // keeps a pinned opener from swallowing an unpinned row (and vice versa).
    const pinnedNodes = buildOpenedBySessionTree(sortUpdatedItems(pinnedItems), {
      ...SIDEBAR_UPDATED_OPENED_BY_TREE_ACCESSORS,
      isCollapsed: (openerId) => collapsedOpenedBySessions[openerId] === true,
    });
    for (const node of pinnedNodes) {
      items.push({ kind: 'session', sessionId: node.item.id, groupKey: '__pinned__' });
    }
  }

  if (organizeMode === 'updated') {
    if (updated.collapsed) return items;
    const orderedItems = sortUpdatedItems(updated.items);
    for (const item of getVisibleUpdatedItems(
      orderedItems,
      true,
      updated.showFull,
      collapsedOpenedBySessions
    )) {
      items.push({ kind: 'session', sessionId: item.id, groupKey: '__updated__' });
    }
    return items;
  }

  emitLocalSections(items, workspace.localSections, collapsedOpenedBySessions);

  if (!workspace.githubSectionCollapsed) {
    for (const group of buildGroups(workspace.repoSessions, workspace.repos, false)) {
      emitSessionGroup(items, group, showFullSessionGroups, collapsedOpenedBySessions);
    }
  }

  for (const group of buildGroups(workspace.chatSessions, [], workspace.chatsCollapsed)) {
    emitSessionGroup(items, group, showFullSessionGroups, collapsedOpenedBySessions);
  }

  return items;
}
