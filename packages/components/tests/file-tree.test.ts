import { describe, expect, it } from 'vitest';
import { buildFileTreeFromPaths, markFileTreeModified } from '../src/lib/file-tree';
import type { TreeDataItem } from '../src/components/tree-view';
import {
  flattenVisibleFileTreeRows,
  pruneExpandedFileTreeIds,
} from '../src/lib/file-tree-virtualization';

describe('file-tree', () => {
  describe('buildFileTreeFromPaths', () => {
    it('builds a sorted tree with directories before files', () => {
      const tree = buildFileTreeFromPaths([
        'src/index.ts',
        'README.md',
        'src/utils/math.ts',
        'src/components/button.tsx',
      ]);

      expect(tree.map((item) => `${item.type}:${item.path}`)).toEqual([
        'directory:src',
        'file:README.md',
      ]);

      const srcNode = tree[0];
      expect(srcNode?.type).toBe('directory');
      if (!srcNode || srcNode.type !== 'directory') {
        return;
      }

      expect(srcNode.children?.map((item) => `${item.type}:${item.path}`)).toEqual([
        'directory:src/components',
        'directory:src/utils',
        'file:src/index.ts',
      ]);
    });
  });

  describe('markFileTreeModified', () => {
    it('re-derives modified highlight from the changed-paths set and propagates to directories', () => {
      // Provider trees arrive with every `modified` already false (live metadata
      // strips per-file modifiedTime); the Changes list is the authoritative source.
      const tree = buildFileTreeFromPaths(['a/b.txt', 'a/c/d.ts', 'x.ts']);

      const marked = markFileTreeModified(tree, new Set(['a/c/d.ts']));

      const aNode = marked.find((item) => item.path === 'a');
      const xNode = marked.find((item) => item.path === 'x.ts');
      expect(aNode?.modified).toBe(true);
      expect(xNode?.modified).toBe(false);

      if (!aNode || aNode.type !== 'directory') {
        return;
      }
      const cNode = aNode.children?.find((item) => item.path === 'a/c');
      const bNode = aNode.children?.find((item) => item.path === 'a/b.txt');
      const dNode = cNode?.type === 'directory' ? cNode.children?.[0] : undefined;
      expect(cNode?.modified).toBe(true);
      expect(bNode?.modified).toBe(false);
      expect(dNode?.modified).toBe(true);
    });

    it('clears stale modified flags when a path leaves the changed set', () => {
      const tree = buildFileTreeFromPaths(['a/b.txt'], new Set(['a/b.txt']));
      expect(tree.find((item) => item.path === 'a')?.modified).toBe(true);

      const cleared = markFileTreeModified(tree, new Set());
      const aNode = cleared.find((item) => item.path === 'a');
      expect(aNode?.modified).toBe(false);
      if (!aNode || aNode.type !== 'directory') {
        return;
      }
      expect(aNode.children?.[0]?.modified).toBe(false);
    });
  });
});

describe('file-tree-virtualization', () => {
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
});
