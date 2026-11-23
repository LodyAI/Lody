import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveExistingPathIgnoringCaseAndNormalization,
  resolveFilePreviewPath,
  type FilePreviewDirectoryReader,
} from './file-preview-path-policy';

const ROOT = path.resolve('/ws');

/**
 * An in-memory tree, so the folding rule is exercised on every machine.
 *
 * Against the real filesystem this code is unreachable on a case-insensitive
 * volume — `exists` answers true for the requested spelling and the fold branch
 * never runs — which is most development machines, and this repository gates
 * changes on a local check rather than CI.
 */
function reader(tree: Record<string, readonly string[]>): FilePreviewDirectoryReader {
  const entriesOf = (directoryPath: string): readonly string[] | null =>
    tree[directoryPath] ?? null;
  return {
    exists: (candidatePath) => {
      if (tree[candidatePath] !== undefined) return true;
      const entries = entriesOf(path.dirname(candidatePath));
      return entries !== null && entries.includes(path.basename(candidatePath));
    },
    readNames: entriesOf,
  };
}

const walk = (relativePath: string, tree: Record<string, readonly string[]>) =>
  resolveExistingPathIgnoringCaseAndNormalization(ROOT, relativePath, reader(tree));

describe('resolveExistingPathIgnoringCaseAndNormalization', () => {
  it('returns the on-disk spelling when only Unicode normalization differs', () => {
    const decomposed = 'café.md'.normalize('NFD');
    const docs = path.join(ROOT, 'docs');
    expect(
      walk(path.join('docs', 'café.md'.normalize('NFC')), {
        [ROOT]: ['docs'],
        [docs]: [decomposed],
      })
    ).toBe(path.join(docs, decomposed));
  });

  it('folds a directory segment as well as the file name', () => {
    const src = path.join(ROOT, 'Src');
    expect(walk(path.join('src', 'app.ts'), { [ROOT]: ['Src'], [src]: ['app.ts'] })).toBe(
      path.join(src, 'app.ts')
    );
  });

  it('prefers the byte-identical name over a folded sibling', () => {
    // The exact-name probe runs first, so a request that exists verbatim must
    // never be answered with a differently-cased neighbour.
    expect(walk('readme.md', { [ROOT]: ['README.md', 'readme.md'] })).toBe(
      path.join(ROOT, 'readme.md')
    );
  });

  it('declines when two entries answer to the same folded spelling', () => {
    // Two real files, no right answer. Guessing would hand back whichever the
    // directory listing happened to return first.
    expect(walk('readme.md', { [ROOT]: ['README.md', 'ReadMe.md'] })).toBeNull();
  });

  it('takes the byte-identical name when normalization twins both exist', () => {
    // `café.md` in NFC and in NFD are two distinct files that compare equal
    // once normalized. The request names one of them exactly, so the ambiguity
    // is only apparent — the exact-name probe settles it before folding.
    const composed = 'café.md'.normalize('NFC');
    expect(walk(composed, { [ROOT]: [composed, 'café.md'.normalize('NFD')] })).toBe(
      path.join(ROOT, composed)
    );
  });

  it('declines when normalization twins collide and neither is the requested spelling', () => {
    // Request NFC; on disk are the NFD spelling and a differently-cased NFD
    // spelling. Both fold to the same key and neither is byte-identical, so
    // there is no right answer. `code-collab-v2-service.ts` rejects the
    // equivalent case as `path_conflict`.
    expect(
      walk('café.md'.normalize('NFC'), {
        [ROOT]: ['café.md'.normalize('NFD'), 'CAFÉ.md'.normalize('NFD')],
      })
    ).toBeNull();
  });
});

describe('resolveFilePreviewPath tolerant resolution against a real filesystem', () => {
  const created: string[] = [];
  afterEach(async () => {
    await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  const makeDir = async (prefix: string) => {
    const dir = await mkdtemp(path.join(tmpdir(), prefix));
    created.push(dir);
    return dir;
  };
  it('resolves absolute and home-rooted local paths without a workspace, but never guesses a relative base', async () => {
    const homeDir = await makeDir('preview-home-');
    const file = path.join(homeDir, 'notes.md');
    await writeFile(file, '# Synthetic note');
    const absolutePath = fs.realpathSync(file);
    for (const requestedPath of [file, '~/notes.md']) {
      expect(
        resolveFilePreviewPath({
          workspaceRoot: null,
          requestedPath,
          extraRoots: [],
          options: { allowArbitraryPaths: true, homeDir },
        })
      ).toMatchObject({
        ok: true,
        resolved: { absolutePath, reportedPath: absolutePath, external: true },
      });
      expect(
        resolveFilePreviewPath({ workspaceRoot: null, requestedPath, extraRoots: [] })
      ).toMatchObject({ ok: false, rejection: { code: 'workspace_root_unavailable' } });
    }
    for (const requestedPath of ['notes.md', '../notes.md']) {
      expect(
        resolveFilePreviewPath({
          workspaceRoot: null,
          requestedPath,
          options: { allowArbitraryPaths: true, homeDir },
        })
      ).toMatchObject({ ok: false, rejection: { code: 'workspace_root_unavailable' } });
    }
    expect(
      resolveFilePreviewPath({
        workspaceRoot: null,
        requestedPath: '~/missing.md',
        options: { allowArbitraryPaths: true, homeDir },
      })
    ).toMatchObject({ ok: false, rejection: { code: 'file_not_found' } });
    expect(
      resolveFilePreviewPath({
        workspaceRoot: null,
        requestedPath: homeDir,
        options: { allowArbitraryPaths: true, homeDir },
      })
    ).toMatchObject({ ok: false, rejection: { code: 'not_a_file' } });
  });
});

describe('filesystem error classification', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['EACCES', 'permission_denied'],
    ['EPERM', 'permission_denied'],
    ['EIO', 'transient_io'],
    ['ELOOP', 'transient_io'],
    ['ENOENT', 'file_not_found'],
    ['ENOTDIR', 'file_not_found'],
  ])('preserves %s instead of guessing absence', async (code, expected) => {
    const root = await mkdtemp(path.join(tmpdir(), 'preview-error-'));
    try {
      const target = path.join(root, 'present.md');
      await writeFile(target, 'synthetic content');
      expect(fs.existsSync(target)).toBe(true);
      const fail = () => {
        throw Object.assign(new Error('synthetic filesystem failure'), { code });
      };
      vi.spyOn(fs.realpathSync, 'native').mockImplementation(fail);
      vi.spyOn(fs, 'realpathSync').mockImplementation(fail);
      const failures: unknown[] = [];
      expect(
        resolveFilePreviewPath({
          workspaceRoot: root,
          requestedPath: target,
          extraRoots: [],
          options: { allowArbitraryPaths: true, onIoError: (event) => failures.push(event) },
        })
      ).toMatchObject({ ok: false, rejection: { code: expected } });
      expect(failures).toContainEqual({ operation: 'realpath', path: target, code });
      // Error classification must not introduce an outside-root existence oracle.
      expect(
        resolveFilePreviewPath({
          workspaceRoot: root,
          requestedPath: '/outside/private.md',
          extraRoots: [],
          options: { allowArbitraryPaths: false },
        })
      ).toMatchObject({ ok: false, rejection: { code: 'path_not_allowed' } });
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });
});
