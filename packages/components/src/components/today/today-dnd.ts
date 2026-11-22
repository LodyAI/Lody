/**
 * Where a dragged node lands. Behavior: specs/today-outline.md (Node drag and
 * drop). The only drop target is a line between two visible rows; its depth
 * follows the pointer's horizontal position, clamped so the node can become at
 * most the first child of the row above and at least a sibling of the row
 * below. A drop under a folded row appends to its children and expands it.
 */
export type TodayDropRow = {
  id: string;
  parentId: string | null;
  depth: number;
  top: number;
  bottom: number;
  collapsed: boolean;
};

export type TodayDropTarget = {
  parentId: string | null;
  /** Sibling the node goes after; null = first child; 'end' = last child. */
  after: string | null | 'end';
  depth: number;
  expandParent: boolean;
  lineTop: number;
};

export function projectTodayDrop(
  rows: readonly TodayDropRow[],
  pointer: { x: number; y: number },
  /** Pointer x that means depth 0. */
  depthOrigin: number,
  indent: number,
  excluded: ReadonlySet<string>
): TodayDropTarget | null {
  const candidates = rows.filter((row) => !isInside(row, excluded, rows));
  const gap = candidates.filter((row) => (row.top + row.bottom) / 2 < pointer.y).length;
  const previous = candidates[gap - 1];
  const next = candidates[gap];
  const maxDepth = previous ? previous.depth + 1 : 0;
  const minDepth = next ? Math.min(next.depth, maxDepth) : 0;
  const wanted = Math.round((pointer.x - depthOrigin) / indent);
  const depth = Math.min(Math.max(wanted, minDepth), maxDepth);
  const lineTop = previous ? previous.bottom : (next?.top ?? 0);
  if (!previous) {
    return { parentId: null, after: null, depth: 0, expandParent: false, lineTop };
  }
  if (depth === previous.depth + 1) {
    return {
      parentId: previous.id,
      after: previous.collapsed ? 'end' : null,
      depth,
      expandParent: previous.collapsed,
      lineTop,
    };
  }
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  let sibling: TodayDropRow | undefined = previous;
  while (sibling && sibling.depth > depth) {
    sibling = sibling.parentId ? byId.get(sibling.parentId) : undefined;
  }
  return {
    parentId: sibling?.parentId ?? null,
    after: sibling?.id ?? null,
    depth,
    expandParent: false,
    lineTop,
  };
}

/** A row excluded itself or through an excluded ancestor (the dragged subtree). */
function isInside(row: TodayDropRow, excluded: ReadonlySet<string>, rows: readonly TodayDropRow[]) {
  const byId = new Map(rows.map((candidate) => [candidate.id, candidate] as const));
  for (let current: TodayDropRow | undefined = row; current;) {
    if (excluded.has(current.id)) return true;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}
