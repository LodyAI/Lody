import type { TreeDataItem } from '@/components/tree-view';

export type VirtualFileTreeRow = {
  readonly item: TreeDataItem;
  readonly level: number;
  readonly hasChildren: boolean;
  readonly isOpen: boolean;
};

export const FILE_TREE_VIRTUALIZE_THRESHOLD = 50;

/**
 * Whether the flat row list is long enough to virtualize.
 *
 * This is the SINGLE virtualization gate for the file tree, and it counts
 * VISIBLE rows. An earlier second gate counted every node in the tree including
 * collapsed ones, and crossing it swapped the whole renderer, so a lazily
 * growing tree could thrash between two very different row implementations.
 */
export function shouldVirtualizeVisibleFileTreeRows(
  rowCount: number,
  threshold = FILE_TREE_VIRTUALIZE_THRESHOLD
): boolean {
  return rowCount > threshold;
}

export function flattenVisibleFileTreeRows(
  items: readonly TreeDataItem[],
  expandedIds: ReadonlySet<string>
): VirtualFileTreeRow[] {
  const rows: VirtualFileTreeRow[] = [];
  const walk = (nodes: readonly TreeDataItem[], level: number) => {
    for (const item of nodes) {
      const hasChildren = Boolean(item.children?.length) || item.forceNode === true;
      const isOpen = hasChildren && expandedIds.has(item.id);
      rows.push({ item, level, hasChildren, isOpen });
      if (isOpen && item.children) {
        walk(item.children, level + 1);
      }
    }
  };
  walk(items, 0);
  return rows;
}

/**
 * Drop expanded ids that no longer name an expandable node in `items`.
 *
 * Returns the SAME set reference when nothing was pruned. The caller feeds this
 * straight into `setState`, and the file tree's source data churns by reference
 * on every file-watcher tick — allocating a fresh equal Set each time forced an
 * extra render plus a re-flatten and a virtualizer pass per tick.
 */
export function pruneExpandedFileTreeIds<T extends ReadonlySet<string>>(
  expandedIds: T,
  items: readonly TreeDataItem[]
): T | Set<string> {
  const validIds = new Set<string>();
  const walk = (nodes: readonly TreeDataItem[]) => {
    for (const node of nodes) {
      if (node.children?.length || node.forceNode === true) {
        validIds.add(node.id);
        walk(node.children ?? []);
      }
    }
  };
  walk(items);
  const retained = [...expandedIds].filter((id) => validIds.has(id));
  if (retained.length === expandedIds.size) {
    return expandedIds;
  }
  return new Set(retained);
}
