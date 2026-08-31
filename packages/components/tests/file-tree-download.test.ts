import { describe, expect, it } from 'vitest';
import type { FileTreeItem } from '@lody/shared';
import {
  findFileTreeItem,
  planFileTreeFolderDownload,
  toArchiveEntryName,
} from '../src/lib/file-tree-download';
import { joinLocalPath } from '../src/components/sessions/components/file-tree-row-menu';
import { buildFileMentionInsertion } from '../src/components/mentions/mention-registry';

const file = (path: string): FileTreeItem => ({ path, type: 'file' });
const dir = (path: string, children: FileTreeItem[]): FileTreeItem => ({
  path,
  type: 'directory',
  children,
});

const TREE: FileTreeItem[] = [
  dir('src', [
    dir('src/lib', [file('src/lib/a.ts'), file('src/lib/b.ts')]),
    file('src/index.ts'),
  ]),
  file('README.md'),
];

describe('planFileTreeFolderDownload', () => {
  it('collects every file under the folder, depth first', () => {
    expect(planFileTreeFolderDownload(TREE, 'src')).toEqual({
      status: 'ready',
      filePaths: ['src/lib/a.ts', 'src/lib/b.ts', 'src/index.ts'],
    });
  });

  it('reports an empty folder rather than producing an empty archive', () => {
    expect(planFileTreeFolderDownload([dir('empty', [])], 'empty')).toEqual({ status: 'empty' });
  });

  it('refuses a file path and an unknown path', () => {
    expect(planFileTreeFolderDownload(TREE, 'README.md')).toEqual({ status: 'empty' });
    expect(planFileTreeFolderDownload(TREE, 'nope')).toEqual({ status: 'empty' });
  });

  // A zip that quietly omits a subtree looks exactly like a complete one, so an
  // unlisted directory must fail the whole plan and name the ids to load.
  it('fails over to needs-directory-load instead of skipping an unlisted directory', () => {
    const tree: FileTreeItem[] = [
      dir('src', [
        file('src/index.ts'),
        { path: 'src/vendor', type: 'directory', lazyDirectoryId: 'src/vendor' },
      ]),
    ];

    expect(planFileTreeFolderDownload(tree, 'src')).toEqual({
      status: 'needs-directory-load',
      lazyDirectoryIds: ['src/vendor'],
    });
  });

  // A lazy directory that HAS been listed carries children; it is ordinary then.
  it('descends into a lazy directory once it has children', () => {
    const tree: FileTreeItem[] = [
      dir('src', [
        {
          path: 'src/vendor',
          type: 'directory',
          lazyDirectoryId: 'src/vendor',
          children: [file('src/vendor/pkg.js')],
        },
      ]),
    ];

    expect(planFileTreeFolderDownload(tree, 'src')).toEqual({
      status: 'ready',
      filePaths: ['src/vendor/pkg.js'],
    });
  });

  it('refuses a folder over the file-count limit and reports both numbers', () => {
    const children = Array.from({ length: 5 }, (_, index) => file(`big/f${index}.ts`));
    expect(planFileTreeFolderDownload([dir('big', children)], 'big', { maxFiles: 4 })).toEqual({
      status: 'too-many-files',
      fileCount: 5,
      limit: 4,
    });
  });
});

describe('findFileTreeItem', () => {
  it('resolves nested paths and rejects a partial segment match', () => {
    expect(findFileTreeItem(TREE, 'src/lib/b.ts')?.type).toBe('file');
    expect(findFileTreeItem(TREE, 'src/lib')?.type).toBe('directory');
    // `src2/...` must not be found by walking into `src`.
    expect(findFileTreeItem(TREE, 'src2/index.ts')).toBeNull();
  });
});

describe('toArchiveEntryName', () => {
  it('keeps the downloaded folder itself as the archive root', () => {
    expect(toArchiveEntryName('src/lib/a.ts', 'src/lib')).toBe('lib/a.ts');
    expect(toArchiveEntryName('src/index.ts', 'src')).toBe('src/index.ts');
  });
});

describe('joinLocalPath', () => {
  it('joins POSIX roots with forward slashes', () => {
    expect(joinLocalPath('/home/me/proj', 'src/a.ts')).toBe('/home/me/proj/src/a.ts');
    expect(joinLocalPath('/home/me/proj/', 'src/a.ts')).toBe('/home/me/proj/src/a.ts');
  });

  it('converts to backslashes for a Windows root', () => {
    expect(joinLocalPath('C:\\Users\\me\\proj', 'src/a.ts')).toBe('C:\\Users\\me\\proj\\src\\a.ts');
    expect(joinLocalPath('\\\\server\\share\\proj', 'a.ts')).toBe('\\\\server\\share\\proj\\a.ts');
  });

  it('returns the root itself for an empty relative path', () => {
    expect(joinLocalPath('/home/me/proj', '')).toBe('/home/me/proj');
  });
});

// The `@` menu's own commit (`toFileCandidate`) is the contract these have to
// match: a directory's VALUE keeps its trailing slash — that is what the
// known-path set and the hydrator match on — while its committed TEXT drops it.
describe('buildFileMentionInsertion', () => {
  it('writes a file mention as its plain path', () => {
    expect(buildFileMentionInsertion([], { path: 'src/a.ts', isDirectory: false })).toEqual({
      text: '@src/a.ts',
      value: 'src/a.ts',
      kind: 'file',
      separate: true,
      suffix: ' ',
    });
  });

  it('keeps the trailing slash on a directory value but not in its text', () => {
    expect(buildFileMentionInsertion([], { path: 'src/lib', isDirectory: true })).toEqual({
      text: '@src/lib',
      value: 'src/lib/',
      kind: 'dir',
      separate: true,
      suffix: ' ',
    });
  });

  it('refuses a duplicate so the caller can leave the gesture unacknowledged', () => {
    expect(
      buildFileMentionInsertion([{ value: 'src/a.ts', kind: 'file' }], {
        path: 'src/a.ts',
        isDirectory: false,
      })
    ).toBeNull();
    expect(
      buildFileMentionInsertion([{ value: 'src/lib/', kind: 'dir' }], {
        path: 'src/lib',
        isDirectory: true,
      })
    ).toBeNull();
    // A same-named mention of another kind is a different token.
    expect(
      buildFileMentionInsertion([{ value: 'src/lib', kind: 'session' }], {
        path: 'src/lib',
        isDirectory: true,
      })
    ).not.toBeNull();
  });

  it('rejects a path that is only slashes', () => {
    expect(buildFileMentionInsertion([], { path: '/', isDirectory: true })).toBeNull();
  });
});
