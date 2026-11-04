import { describe, expect, it } from 'vitest';
import type { TreeDataItem } from '../src/components/tree-view';
import {
  flattenVisibleFileTreeRows,
  pruneExpandedFileTreeIds,
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
});
