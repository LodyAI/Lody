import { describe, expect, it } from 'vitest';
import type { TreeDataItem } from '../src/components/tree-view';
import {
  flattenVisibleFileTreeRows,
  pruneExpandedFileTreeIds,
  shouldVirtualizeVisibleFileTreeRows,
} from '../src/lib/file-tree-virtualization';

const tree = [
  {
    id: 'src',
    name: 'src',
    children: [
      { id: 'src/index.ts', name: 'index.ts' },
      {
        id: 'src/components',
        name: 'components',
        children: [{ id: 'src/components/button.tsx', name: 'button.tsx' }],
      },
    ],
  },
  { id: 'README.md', name: 'README.md' },
] satisfies TreeDataItem[];

describe('file tree virtualization helpers', () => {
  it('virtualizes based on visible row count after source selection', () => {
    expect(shouldVirtualizeVisibleFileTreeRows(50)).toBe(false);
    expect(shouldVirtualizeVisibleFileTreeRows(51)).toBe(true);
  });

  it('flattens only visible rows based on expanded directories', () => {
    expect(flattenVisibleFileTreeRows(tree, new Set()).map((row) => row.item.id)).toEqual([
      'src',
      'README.md',
    ]);

    expect(
      flattenVisibleFileTreeRows(tree, new Set(['src', 'src/components'])).map((row) => ({
        id: row.item.id,
        level: row.level,
        isOpen: row.isOpen,
      }))
    ).toEqual([
      { id: 'src', level: 0, isOpen: true },
      { id: 'src/index.ts', level: 1, isOpen: false },
      { id: 'src/components', level: 1, isOpen: true },
      { id: 'src/components/button.tsx', level: 2, isOpen: false },
      { id: 'README.md', level: 0, isOpen: false },
    ]);
  });

  it('drops stale expanded ids when the tree changes', () => {
    expect([
      ...pruneExpandedFileTreeIds(new Set(['src', 'missing', 'src/index.ts']), tree),
    ]).toEqual(['src']);
  });

  // The result is fed straight to setState, and the file tree's source data churns
  // by reference on every file-watcher tick. A fresh equal Set would schedule a
  // render plus a re-flatten and a virtualizer pass for a no-op prune.
  it('keeps the same Set reference when nothing was pruned', () => {
    const expanded = new Set(['src', 'src/components']);
    expect(pruneExpandedFileTreeIds(expanded, tree)).toBe(expanded);

    // A rebuilt-but-equivalent tree still must not allocate.
    const rebuilt = structuredClone(tree) as TreeDataItem[];
    expect(pruneExpandedFileTreeIds(expanded, rebuilt)).toBe(expanded);
  });

  it('returns a new Set only when an id actually goes away', () => {
    const expanded = new Set(['src', 'gone']);
    const pruned = pruneExpandedFileTreeIds(expanded, tree);
    expect(pruned).not.toBe(expanded);
    expect([...pruned]).toEqual(['src']);
  });

  // Row objects are the memo boundary for virtual rows: scrolling must not
  // re-flatten, and re-flattening the same inputs must stay cheap and stable.
  it('reuses the underlying item objects it was given', () => {
    const expanded = new Set(['src']);
    const first = flattenVisibleFileTreeRows(tree, expanded);
    const second = flattenVisibleFileTreeRows(tree, expanded);
    expect(second.map((row) => row.item)).toEqual(first.map((row) => row.item));
    expect(second[0]!.item).toBe(first[0]!.item);
  });
});
