import type { SessionId, SessionMeta } from '@lody/shared';

import {
  buildSessionMetaById,
  resolveSidebarOpenerRowId,
} from '@/components/sessions/session-list-rows';

/**
 * One row of the related-Sessions tree: a root Session and its top Tabs.
 * Tabs share the root's workspace, so they render as one row split into pills.
 */
export type SessionRelationTreeNode = {
  session: SessionMeta;
  tabs: SessionMeta[];
  /** Root Sessions opened from this row (from the root or any of its Tabs). */
  children: SessionRelationTreeNode[];
};

const append = (map: Map<string, SessionMeta[]>, key: string, session: SessionMeta) => {
  const list = map.get(key);
  if (list) list.push(session);
  else map.set(key, [session]);
};

const byCreatedAt = (left: SessionMeta, right: SessionMeta): number =>
  left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;

/**
 * The complete `openedBySessionId` tree the current Session belongs to: walk
 * up from its row to the topmost live opener, then include every descendant.
 * Edges connect ROWS (root Sessions): a precise opener that is a Tab resolves
 * to its root, exactly like the sidebar tree, but without its depth cap.
 *
 * Archived Sessions and side chats are left out, so an archived opener ends
 * the upward walk. Cycles, including a self-opener, stop at the first repeated
 * row.
 */
export function buildSessionRelationTree(
  sessions: readonly SessionMeta[],
  currentSessionId: SessionId
): SessionRelationTreeNode | null {
  const live = sessions.filter(
    (session) => !session.isArchived && session.childSessionPlacement !== 'side-panel'
  );
  const byId = buildSessionMetaById(live);
  const currentRowId = resolveSidebarOpenerRowId(currentSessionId, byId);
  if (!currentRowId || !byId.has(currentRowId)) return null;

  const parentRowOf = (root: SessionMeta): string | null => {
    const rowId = resolveSidebarOpenerRowId(root.openedBySessionId, byId);
    return rowId && byId.has(rowId) ? rowId : null;
  };

  const tabsByRow = new Map<string, SessionMeta[]>();
  const childrenByRow = new Map<string, SessionMeta[]>();
  for (const session of [...live].sort(byCreatedAt)) {
    if (session.parentSessionId) {
      // A closed Tab stays out, as in the tab strip, unless it is the current one.
      if (!session.isTabClosed || session.id === currentSessionId) {
        append(tabsByRow, session.parentSessionId, session);
      }
      continue;
    }
    const parentRowId = parentRowOf(session);
    if (parentRowId) append(childrenByRow, parentRowId, session);
  }

  let topId = currentRowId;
  const walked = new Set([topId]);
  for (;;) {
    const parentRowId = parentRowOf(byId.get(topId)!);
    if (!parentRowId || walked.has(parentRowId)) break;
    walked.add(parentRowId);
    topId = parentRowId;
  }

  const built = new Set<string>();
  const build = (root: SessionMeta): SessionRelationTreeNode => {
    built.add(root.id);
    return {
      session: root,
      tabs: tabsByRow.get(root.id) ?? [],
      children: (childrenByRow.get(root.id) ?? [])
        .filter((child) => !built.has(child.id))
        .map(build),
    };
  };
  return build(byId.get(topId)!);
}

/** Whether the tree says anything beyond the current row's own plain Tabs. */
export function hasSessionRelations(tree: SessionRelationTreeNode | null): boolean {
  return !!tree && (tree.children.length > 0 || tree.tabs.some((tab) => !!tab.openedBySessionId));
}

/** Every Session shown in the tree (roots and Tabs). */
export function countSessionRelationTree(node: SessionRelationTreeNode): number {
  return node.children.reduce(
    (total, child) => total + countSessionRelationTree(child),
    1 + node.tabs.length
  );
}
