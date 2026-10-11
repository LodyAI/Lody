import fs from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

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
  it('returns the on-disk spelling when only the letter case differs', () => {
    expect(walk('readme.md', { [ROOT]: ['README.md'] })).toBe(path.join(ROOT, 'README.md'));
  });

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

  it('declines rather than climbing out of the root', () => {
    // Built as raw strings, not through `path.join`, which would normalize the
    // traversal away before the function ever saw it.
    expect(walk(`..${path.sep}etc${path.sep}passwd`, { [ROOT]: ['..'] })).toBeNull();
    expect(walk(`.${path.sep}app.ts`, { [ROOT]: ['.', 'app.ts'] })).toBeNull();
  });

  it('declines when a directory on the way cannot be listed', () => {
    expect(walk(path.join('secret', 'app.ts'), { [ROOT]: ['Secret'] })).toBeNull();
  });

  it('declines when nothing folds to the requested name', () => {
    expect(walk('report2.md', { [ROOT]: ['report.md'] })).toBeNull();
  });

  it('declines an empty relative path instead of returning the root', () => {
    expect(walk('', { [ROOT]: ['README.md'] })).toBeNull();
  });
});

/**
 * Real filesystem for realpath/stat/containment, but a listing that answers
 * case- and normalization-STRICTLY even on a volume that folds.
 *
 * Honest scope: this does NOT force the fold branch on a folding volume. The
 * literal-spelling step runs `fs.realpathSync` — deliberately not injectable,
 * authorization must see the real filesystem — and on case-insensitive APFS it
 * already resolves a wrong-case request, so these scenarios pass through the
 * realpath route there and the injected reader goes unconsulted. What this
 * describe guarantees on every machine is the CONTRACT (resolved spelling
 * reported, out-of-root rejection, symlinked-root handling); the fold branch
 * itself executes here only on a case-sensitive volume. Its per-machine
 * coverage is the pure-walk describe above, which needs no filesystem.
 */
const CASE_STRICT_READER: FilePreviewDirectoryReader = {
  exists: (candidatePath) => {
    const parent = path.dirname(candidatePath);
    const name = path.basename(candidatePath);
    try {
      return fs.readdirSync(parent).includes(name);
    } catch {
      return false;
    }
  },
  readNames: (directoryPath) => {
    try {
      return fs.readdirSync(directoryPath);
    } catch {
      return null;
    }
  },
};

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

  const authorize = (workspaceRoot: string, requestedPath: string) =>
    resolveFilePreviewPath({
      workspaceRoot,
      requestedPath,
      extraRoots: [],
      options: { directoryReader: CASE_STRICT_READER },
    });

  it('resolves a differently-cased request to the real file and reports its spelling', async () => {
    const workspaceRoot = await makeDir('policy-ws-');
    await mkdir(path.join(workspaceRoot, 'Src'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'Src', 'App.ts'), 'const a = 1;\n');

    const result = authorize(workspaceRoot, 'src/app.ts');

    expect(result.ok && result.resolved.reportedPath).toBe('Src/App.ts');
    expect(result.ok && result.resolved.external).toBe(false);
  });

  it('still refuses a tolerantly-resolved path that leaves the workspace', async () => {
    // The walk finds `link/id_rsa` from `LINK/ID_RSA`; containment must then
    // reject it on the symlink-resolved target. This is the case that proves
    // resolution did not become authorization.
    const workspaceRoot = await makeDir('policy-ws-');
    const outside = await makeDir('policy-outside-');
    await writeFile(path.join(outside, 'id_rsa'), 'PRIVATE KEY');
    await symlink(outside, path.join(workspaceRoot, 'link'));

    const result = authorize(workspaceRoot, 'LINK/ID_RSA');

    expect(result.ok ? 'ok' : result.rejection.code).toBe('path_not_allowed');
  });

  it('resolves through a workspace root that is itself reached by a symlink', async () => {
    // Exercises the two-root branch: the lexical candidate is built from the
    // unresolved spelling, so only the unresolved root contains it, while
    // authorization compares against the resolved one.
    const parent = await makeDir('policy-parent-');
    const realRoot = path.join(parent, 'real');
    const linkedRoot = path.join(parent, 'linked');
    await mkdir(realRoot, { recursive: true });
    await writeFile(path.join(realRoot, 'README.md'), '# hi\n');
    await symlink(realRoot, linkedRoot);

    const result = authorize(linkedRoot, 'readme.md');

    expect(result.ok && result.resolved.reportedPath).toBe('README.md');
  });

  it('declines an ambiguous fold rather than opening an arbitrary one of the two', async (ctx) => {
    const workspaceRoot = await makeDir('policy-ws-');
    await writeFile(path.join(workspaceRoot, 'README.md'), 'a\n');
    // Needs a volume that can hold both spellings at once.
    try {
      await writeFile(path.join(workspaceRoot, 'ReadMe.md'), 'b\n');
      if (fs.readdirSync(workspaceRoot).length < 2) ctx.skip();
    } catch {
      ctx.skip();
    }

    const result = authorize(workspaceRoot, 'readme.md');

    expect(result.ok ? 'ok' : result.rejection.code).toBe('file_not_found');
  });
});
