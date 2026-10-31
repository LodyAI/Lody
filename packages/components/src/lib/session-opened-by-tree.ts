/**
 * Presentation model for the sidebar's "opened by" tree.
 *
 * `SessionMeta.openedBySessionId` records the Session that CREATED another
 * Session — today that is `lody session create` running with a current session
 * in scope, which is how the `lody_session_create` MCP tool spawns independent
 * work. It is deliberately NOT `parentSessionId`:
 *
 * - `parentSessionId` is a semantic child (child tab / side chat). Those share
 *   the parent's workspace, are filtered out of the sidebar entirely
 *   (`sessionListAtom`), and roll their activity up into the parent row.
 * - `openedBySessionId` is a presentation-only provenance link. The opened
 *   Session keeps its own work context, machine, project, and lifecycle; it is
 *   a first-class sidebar row that merely renders INDENTED under its opener so
 *   the fan-out is legible.
 *
 * The two must not be conflated: a Session carrying both is already excluded
 * from the sidebar by `parentSessionId`, so it can never be nested twice.
 *
 * Rules encoded here (the narrowest ones the current data supports):
 *
 * 1. A row nests only when its opener is VISIBLE in the same list. An opener
 *    that is archived, owned by another scope, sitting in a different repo
 *    group, or simply gone leaves the opened Session as a normal top-level row
 *    (the "orphan fallback"). Nothing is ever hidden by this model.
 * 2. Depth is capped at one. A grandchild (A opened B, B opened C) attaches to
 *    the topmost visible ancestor A, so the sidebar stays a dense two-level
 *    tree rather than an unbounded outline.
 * 3. Cycles and self-references degrade to top-level rows. Every input item
 *    appears exactly once in the output, in a deterministic order.
 * 4. Roots keep their incoming order (the caller has already sorted by pinned /
 *    latest activity); nested rows keep their incoming order under their opener.
 */

export type OpenedBySessionTreeNode<T> = {
  item: T;
  /** Stable row id (the session id). */
  id: string;
  /** 0 = top-level row, 1 = opened Session nested under its opener. */
  depth: 0 | 1;
  /** Opener row id when nested; null at depth 0. */
  openedById: string | null;
  /** True for the last nested row under an opener (ends the connector trunk). */
  isLastChild: boolean;
  /** Opened Sessions attached to this row. Always 0 at depth 1. */
  childCount: number;
  /** False only when `childCount > 0` and the user collapsed the opener. */
  expanded: boolean;
};

export type BuildOpenedBySessionTreeOptions<T> = {
  getId: (item: T) => string;
  getOpenedBySessionId: (item: T) => string | null | undefined;
  /** Opener rows whose nested Sessions are hidden. Default: everything expanded. */
  isCollapsed?: (openerId: string) => boolean;
  /**
   * Optional ranking for TOP-LEVEL rows, HIGHER first. A root is ranked by the
   * maximum of its own rank and the ranks of the Sessions it opened.
   *
   * Every sidebar list this model feeds is sorted by "latest activity", and
   * nesting moves a row out of that flat order. Without this, a Session that
   * was updated a minute ago would be buried under an opener last touched days
   * ago — which silently breaks the ordering contract of the Updated mode and
   * of each Workspace group. Ranking the whole group by its freshest member
   * keeps the promise: whatever moved most recently is still near the top.
   *
   * Ties keep the incoming order, so the caller's own sort (pinned first, then
   * time, then title) still decides everything this does not.
   */
  rootRank?: (item: T) => number;
  /**
   * Cap on TOP-LEVEL rows (the sidebar's "show latest N" preview). Applied
   * AFTER `rootRank`. Nested rows of a kept root always come along, so a
   * preview never splits an opener from the Sessions it opened.
   */
  maxRoots?: number;
};

/**
 * Trim a session id to null. Shared with the sidebar lists, which normalize the
 * same two provenance fields (`openedBySessionId` / `openedByRowSessionId`)
 * before feeding them here or into navigation.
 */
export function normalizeSessionRowId(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed : null;
}

/**
 * Above every real epoch-ms timestamp, so a pinned row still outranks an
 * unpinned one. Every caller's own sort puts pinned first, and the tree's root
 * ranking must not undo that.
 */
const PINNED_ROOT_RANK_OFFSET = 1e15;

/** The {@link BuildOpenedBySessionTreeOptions.rootRank} every list uses: pinned first, then latest activity. */
export function pinnedFirstRootRank(latestMessageAtMs: number, isPinned?: boolean): number {
  return isPinned ? PINNED_ROOT_RANK_OFFSET + latestMessageAtMs : latestMessageAtMs;
}

/**
 * Visible opener each item attaches to, or null when it is a top-level row.
 * `null` for the whole map means no item in the list has an opener at all.
 */
function resolve<T>(
  items: readonly T[],
  getId: (item: T) => string,
  getOpenedBySessionId: (item: T) => string | null | undefined
): Map<string, string | null> | null {
  // Almost every real list has no opened-by relationship whatsoever. Detecting
  // that with one scan skips three Maps, a Set per item, and the grouping pass
  // below — this runs per group/bucket on every sidebar data change.
  if (!items.some((item) => normalizeSessionRowId(getOpenedBySessionId(item)) !== null)) {
    return null;
  }

  const indexById = new Map<string, number>();
  items.forEach((item, index) => {
    const id = getId(item);
    if (!indexById.has(id)) indexById.set(id, index);
  });

  // Pass 1: walk each chain up to the topmost ancestor that is visible here.
  const candidateById = new Map<string, string | null>();
  items.forEach((item) => {
    const selfId = getId(item);
    let cursor = normalizeSessionRowId(getOpenedBySessionId(item));
    let topmostVisible: string | null = null;
    if (cursor !== null) {
      // Allocated only for a row that actually has a chain to walk.
      const seen = new Set<string>([selfId]);
      while (cursor && !seen.has(cursor)) {
        const index = indexById.get(cursor);
        if (index === undefined) break;
        seen.add(cursor);
        topmostVisible = cursor;
        const opener = items[index];
        cursor = opener === undefined ? null : normalizeSessionRowId(getOpenedBySessionId(opener));
      }
    }
    candidateById.set(selfId, topmostVisible);
  });

  // Pass 2: only a row that is itself top-level may host nested rows. This is
  // what makes a cycle (A opened B, B opened A) degrade to two top-level rows
  // instead of two rows that each hide inside the other and disappear.
  const openerById = new Map<string, string | null>();
  candidateById.forEach((candidate, id) => {
    openerById.set(
      id,
      candidate !== null && candidateById.get(candidate) === null ? candidate : null
    );
  });

  return openerById;
}

/**
 * Cross-group placement for the Workspace sidebar, applied before each group
 * builds its own tree. An opened Session whose topmost rendered ancestor sits in
 * another group moves into that ancestor's group, so the tree there can indent
 * it: a Role dispatched from a Local Project to another Machine lands in Chats
 * or a GitHub group, and would otherwise lose its place under the opener.
 *
 * `groupBySessionId` holds every row the Workspace groups render, keyed by its
 * natural group. Returns only the moved rows and their target group. A chain
 * whose ancestor is missing stays put; a cycle stays put, matching the tree's
 * degradation to top-level rows. Each row still lands in exactly one group.
 */
export function placeOpenedSessionsWithOpeners<G>(
  groupBySessionId: ReadonlyMap<string, G>,
  getOpenedBySessionId: (sessionId: string) => string | null | undefined
): Map<string, G> {
  const topmostById = new Map<string, string | null>();
  for (const selfId of groupBySessionId.keys()) {
    let cursor = normalizeSessionRowId(getOpenedBySessionId(selfId));
    let topmost: string | null = null;
    const seen = new Set<string>([selfId]);
    while (cursor && !seen.has(cursor) && groupBySessionId.has(cursor)) {
      seen.add(cursor);
      topmost = cursor;
      cursor = normalizeSessionRowId(getOpenedBySessionId(cursor));
    }
    topmostById.set(selfId, topmost);
  }

  const moved = new Map<string, G>();
  topmostById.forEach((topmost, id) => {
    // Only a root hosts nested rows; a cycle has no root and stays put.
    if (topmost === null || topmostById.get(topmost) !== null) return;
    const target = groupBySessionId.get(topmost);
    if (target !== undefined && target !== groupBySessionId.get(id)) moved.set(id, target);
  });
  return moved;
}

export function buildOpenedBySessionTree<T>(
  items: readonly T[],
  options: BuildOpenedBySessionTreeOptions<T>
): OpenedBySessionTreeNode<T>[] {
  const { getId, getOpenedBySessionId, isCollapsed, rootRank, maxRoots } = options;
  if (items.length === 0) return [];

  const openerById = resolve(items, getId, getOpenedBySessionId);

  const roots: T[] = [];
  const childrenByOpener = new Map<string, T[]>();
  if (openerById === null) {
    // No nesting anywhere in this list: every item is a top-level row.
    roots.push(...items);
  } else {
    for (const item of items) {
      const openerId = openerById.get(getId(item)) ?? null;
      if (openerId === null) {
        roots.push(item);
        continue;
      }
      const existing = childrenByOpener.get(openerId);
      if (existing) existing.push(item);
      else childrenByOpener.set(openerId, [item]);
    }
  }

  const orderedRoots = rootRank
    ? roots
        .map((root, index) => {
          let rank = rootRank(root);
          for (const child of childrenByOpener.get(getId(root)) ?? []) {
            const childRank = rootRank(child);
            if (childRank > rank) rank = childRank;
          }
          return { root, index, rank };
        })
        // Stable: equal ranks fall back to the caller's incoming order.
        .sort((left, right) => right.rank - left.rank || left.index - right.index)
        .map((entry) => entry.root)
    : roots;

  const visibleRoots =
    typeof maxRoots === 'number' && maxRoots >= 0 ? orderedRoots.slice(0, maxRoots) : orderedRoots;

  const nodes: OpenedBySessionTreeNode<T>[] = [];
  for (const root of visibleRoots) {
    const rootId = getId(root);
    const children = childrenByOpener.get(rootId) ?? [];
    const expanded = children.length === 0 || !isCollapsed?.(rootId);
    nodes.push({
      item: root,
      id: rootId,
      depth: 0,
      openedById: null,
      isLastChild: false,
      childCount: children.length,
      expanded,
    });
    if (!expanded) continue;
    children.forEach((child, index) => {
      nodes.push({
        item: child,
        id: getId(child),
        depth: 1,
        openedById: rootId,
        isLastChild: index === children.length - 1,
        childCount: 0,
        expanded: true,
      });
    });
  }

  return nodes;
}

/**
 * Number of TOP-LEVEL rows the list would render with no preview cap. The
 * sidebar's "Show all" affordance gates on this rather than the raw session
 * count, so a group of five openers plus their opened Sessions is not treated
 * as an overflowing list.
 */
export function countOpenedByTreeRoots<T>(
  items: readonly T[],
  options: Pick<BuildOpenedBySessionTreeOptions<T>, 'getId' | 'getOpenedBySessionId'>
): number {
  if (items.length === 0) return 0;
  const openerById = resolve(items, options.getId, options.getOpenedBySessionId);
  if (openerById === null) return items.length;
  let count = 0;
  openerById.forEach((openerId) => {
    if (openerId === null) count += 1;
  });
  return count;
}

/**
 * True when the list contains at least one nesting relationship, i.e. the rows
 * need the tree presentation wrapper. A list with no MCP-opened Sessions keeps
 * its existing flat geometry exactly.
 */
export function hasOpenedByTreeNesting<T>(nodes: readonly OpenedBySessionTreeNode<T>[]): boolean {
  return nodes.some((node) => node.depth === 1 || node.childCount > 0);
}
