import { encodeSessionFilePath, type CodeCollabV2FileIndexState } from '@lody/shared';
import * as processCommands from '@lody/shared/node/process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  digestText,
  entryPaths,
  execFileAsync,
  gitCommitAll,
  gitText,
  initGitRepoWithCommit,
  makeResolver,
  plainSnapshotText,
  registerCodeCollabSeedCleanup,
  SESSION_ID,
  withWorkspace,
} from '../../../tests/code-collab-v2-service-helpers';
import { CodeCollabV2DiffStore } from './code-collab-v2-diff-store';
import {
  CodeCollabV2Service,
  type CodeCollabV2FileIndexPublication,
} from './code-collab-v2-service';

registerCodeCollabSeedCleanup();
describe('CodeCollabV2Service openAllChangesDiff', () => {
  it('isolates a failed Git comparison to its file and recovers on the next read', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await initGitRepoWithCommit(workspaceRoot);
      await execFileAsync('git', ['config', 'core.filemode', 'true'], { cwd: workspaceRoot });
      const modePath = path.join(workspaceRoot, 'mode.txt');
      await writeFile(modePath, 'same\n');
      await chmod(modePath, 0o644);
      await writeFile(path.join(workspaceRoot, 'healthy.txt'), 'before\n');
      await gitCommitAll(workspaceRoot, 'base');
      await chmod(modePath, 0o755);
      await writeFile(path.join(workspaceRoot, 'healthy.txt'), 'after\n');
      const run = processCommands.runCommandTextLegacy;
      const failure = vi
        .spyOn(processCommands, 'runCommandTextLegacy')
        .mockImplementation((request, options) =>
          request.command === 'git' && request.args?.includes('--raw')
            ? Promise.reject(new Error('Synthetic Git comparison failure'))
            : run(request, options)
        );
      const service = new CodeCollabV2Service({
        readOnly: true,
        resolveWorkspace: makeResolver(workspaceRoot),
      });
      try {
        const batch = await service.openAllChangesDiff({ sessionId: SESSION_ID });
        expect(batch).toMatchObject({ status: 'ok', truncated: true });
        if (batch.status !== 'ok') throw new Error('Expected a partial Git batch.');
        expect(batch.entries.find((entry) => entry.path === 'mode.txt')?.status).toBe('deferred');
        expect(batch.entries.find((entry) => entry.path === 'healthy.txt')?.status).toBe('ok');
        expect(
          await service.openCurrentDiff({ sessionId: SESSION_ID, path: 'mode.txt' })
        ).toMatchObject({ status: 'unavailable', reason: 'transient_io' });
        const manifest = await service.openDiffManifest({ sessionId: SESSION_ID });
        if (manifest.status !== 'ok') throw new Error('Expected a partial Git manifest.');
        expect(manifest.entries.find((entry) => entry.path === 'mode.txt')).toMatchObject({
          status: 'unavailable',
          error: { code: 'transient_io' },
        });
        expect(manifest.entries.find((entry) => entry.path === 'healthy.txt')?.status).toBe('ok');

        failure.mockRestore();
        const recovered = await service.openAllChangesDiff({ sessionId: SESSION_ID });
        expect(recovered).toMatchObject({ status: 'ok', truncated: false });
        if (recovered.status !== 'ok') throw new Error('Expected a recovered Git batch.');
        expect(recovered.entries.map((entry) => entry.status)).toEqual(['ok', 'ok']);
        expect(
          await service.openCurrentDiff({ sessionId: SESSION_ID, path: 'mode.txt' })
        ).toMatchObject({ status: 'ok' });
        const recoveredManifest = await service.openDiffManifest({ sessionId: SESSION_ID });
        if (recoveredManifest.status !== 'ok') throw new Error('Expected a recovered manifest.');
        expect(recoveredManifest.entries.map((entry) => entry.status)).toEqual(['ok', 'ok']);
      } finally {
        failure.mockRestore();
        await service.dispose();
      }
    });
  });

  it('prioritizes the focused non-Git diff and defers other files when the snapshot budget is exhausted', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const paths = ['focus.txt', 'later-b.txt', 'later-c.txt'];
      for (const workspacePath of paths) {
        await writeFile(path.join(workspaceRoot, workspacePath), `${workspacePath[0]}x\n`);
      }
      const diffStore = new CodeCollabV2DiffStore('workspace-v2', {
        dbPath: path.join(workspaceRoot, 'diff-store.sqlite3'),
      });
      try {
        const nowMs = Date.now();
        await diffStore.recordTurnDiffs({
          workspaceRoot,
          ownerSessionId: SESSION_ID,
          turnId: 'turn-cache-bound',
          capturedAtMs: nowMs,
          recordedAtMs: nowMs,
          events: paths.map((workspacePath) => ({
            path: path.join(workspaceRoot, workspacePath),
            oldText: `${workspacePath[0]}\n`,
            newText: `${workspacePath[0]}x\n`,
          })),
        });
        const service = new CodeCollabV2Service({
          resolveWorkspace: makeResolver(workspaceRoot),
          diffStore,
          allChangesSnapshotCacheMaxRawBytes: 5,
          allChangesDiffLimits: {
            perFileMaxRawBytes: 1024,
            perFileMaxCompressedBytes: 1024,
            responseBudgetCompressedBytes: 1024,
          },
        });

        const result = await service.openAllChangesDiff({
          sessionId: SESSION_ID,
          focusPath: 'focus.txt',
        });

        expect(result.status).toBe('ok');
        if (result.status !== 'ok') return;
        const byPath = new Map(result.entries.map((entry) => [entry.path, entry]));
        expect(byPath.get('focus.txt')?.status).toBe('ok');
        expect(byPath.get('later-b.txt')?.status).toBe('deferred');
        expect(byPath.get('later-c.txt')?.status).toBe('deferred');
        expect(result.truncated).toBe(true);
      } finally {
        await diffStore.close();
      }
    });
  });

  it('returns every changed file inline in one batch (modified, untracked, deleted)', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await initGitRepoWithCommit(workspaceRoot);
      await writeFile(path.join(workspaceRoot, 'tracked.txt'), 'one\n');
      await writeFile(path.join(workspaceRoot, 'gone.txt'), 'bye\n');
      await gitCommitAll(workspaceRoot, 'init');

      await writeFile(path.join(workspaceRoot, 'tracked.txt'), 'one\ntwo\n');
      await writeFile(path.join(workspaceRoot, 'untracked.txt'), 'new\n');
      await rm(path.join(workspaceRoot, 'gone.txt'));

      const service = new CodeCollabV2Service({ resolveWorkspace: makeResolver(workspaceRoot) });
      const result = await service.openAllChangesDiff({ sessionId: SESSION_ID });

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(typeof result.base).toBe('string');
      expect(result.base.length).toBeGreaterThan(0);
      expect(result.truncated).toBe(false);

      const manifest = await service.openDiffManifest({ sessionId: SESSION_ID });
      expect(manifest.status).toBe('ok');
      if (manifest.status !== 'ok') throw new Error('Expected manifest.');
      expect(manifest.entries.map((entry) => entry.path).toSorted()).toEqual([
        'gone.txt',
        'tracked.txt',
        'untracked.txt',
      ]);
      expect(manifest.entries.find((entry) => entry.path === 'gone.txt')).toMatchObject({
        status: 'ok',
        base: { key: expect.any(String) },
        head: null,
      });
      const single = await service.openDiffManifest({ sessionId: SESSION_ID, path: 'gone.txt' });
      expect(single).toMatchObject({ status: 'ok', entries: [{ status: 'ok', head: null }] });
      const byPath = new Map(result.entries.map((entry) => [entry.path, entry]));

      const modified = byPath.get('tracked.txt');
      expect(modified?.status).toBe('ok');
      if (modified?.status === 'ok') {
        expect(modified.add).toBe(1);
        expect(modified.del).toBe(0);
        expect(plainSnapshotText(modified.oldSnapshot)).toBe('one\n');
        expect(plainSnapshotText(modified.newSnapshot)).toBe('one\ntwo\n');
      }

      const untracked = byPath.get('untracked.txt');
      expect(untracked?.status).toBe('ok');
      if (untracked?.status === 'ok') {
        expect(untracked.oldSnapshot.kind).toBe('missing');
        expect(plainSnapshotText(untracked.newSnapshot)).toBe('new\n');
      }

      const deleted = byPath.get('gone.txt');
      expect(deleted?.status).toBe('ok');
      if (deleted?.status === 'ok') {
        expect(plainSnapshotText(deleted.oldSnapshot)).toBe('bye\n');
        expect(deleted.newSnapshot.kind).toBe('missing');
      }
    });
  });

  it('marks files that exceed the per-file budget as deferred (still carrying line stats)', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await initGitRepoWithCommit(workspaceRoot);
      await writeFile(path.join(workspaceRoot, 'tracked.txt'), 'one\n');
      await gitCommitAll(workspaceRoot, 'init');
      await writeFile(path.join(workspaceRoot, 'tracked.txt'), 'one\ntwo\n');

      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        allChangesDiffLimits: {
          perFileMaxRawBytes: 1,
          perFileMaxCompressedBytes: 1,
          responseBudgetCompressedBytes: 1,
        },
      });
      const result = await service.openAllChangesDiff({ sessionId: SESSION_ID });

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.truncated).toBe(true);
      const entry = result.entries.find((candidate) => candidate.path === 'tracked.txt');
      expect(entry?.status).toBe('deferred');
      expect(entry?.add).toBe(1);
      expect(entry?.del).toBe(0);
    });
  });
});

describe('Project group extra-root files', () => {
  it('opens, saves, indexes and reconstructs turn diffs independently of main', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'code-collab-roots-'));
    const main = path.join(base, 'main');
    const extra = path.join(base, 'extra');
    await mkdir(main);
    await mkdir(extra);
    await writeFile(path.join(main, 'a.txt'), 'main');
    await writeFile(path.join(extra, 'a.txt'), 'old');
    const rootId = 'member:docs';
    const key = encodeSessionFilePath({ rootId, relativePath: 'a.txt' });
    const store = new CodeCollabV2DiffStore('roots' as never, {
      dbPath: path.join(base, 'diff.sqlite3'),
    });
    const publications: CodeCollabV2FileIndexState[] = [];
    const stats: CodeCollabV2FileIndexPublication[] = [];
    const roots = [
      { id: 'main', absolutePath: main },
      { id: rootId, absolutePath: extra },
    ];
    const watchedRoots = new Map<string, string>();
    const service = new CodeCollabV2Service({
      workspaceWatchCoordinator: {
        subscribe: async ({ ownerSessionId, workspaceRoot }) => {
          watchedRoots.set(ownerSessionId, workspaceRoot);
          return {
            canonicalRoot: workspaceRoot,
            release: () => {
              watchedRoots.delete(ownerSessionId);
            },
          };
        },
      },
      resolveWorkspace: async (_, options) => {
        const root = roots.find((candidate) => candidate.id === (options?.rootId ?? 'main'));
        return root
          ? {
              ok: true,
              ownerSessionId: SESSION_ID,
              workspaceRoot: root.absolutePath,
              fileRoots: roots,
            }
          : { ok: false, code: 'permission_denied', message: 'unknown root' };
      },
      diffStore: store,
      publishFileIndex: async (state) => {
        publications.push(state.fileIndex);
        stats.push(state);
      },
    });
    try {
      const opened = await service.openText({ sessionId: SESSION_ID, rootId, path: 'a.txt' });
      expect(opened.text).toMatchObject({ text: 'old' });
      const saved = await service.saveText({
        sessionId: SESSION_ID,
        rootId,
        path: 'a.txt',
        requestedByUserId: 'u',
        baseDigest: opened.digest,
        text: { encoding: 'plain', text: 'new', rawBytes: 3 },
      });
      expect(saved.status).toBe('ok');
      expect(await readFile(path.join(extra, 'a.txt'), 'utf8')).toBe('new');
      expect(await readFile(path.join(main, 'a.txt'), 'utf8')).toBe('main');
      await store.recordTurnDiffs({
        workspaceRoot: main,
        fileRoots: roots,
        ownerSessionId: SESSION_ID,
        turnId: 'turn',
        events: [{ path: path.join(extra, 'a.txt'), oldText: 'old', newText: 'new' }],
      });
      await service.refreshSharedState({ sessionId: SESSION_ID });
      await service.refreshSharedStateAfterTurn({ sessionId: SESSION_ID });
      expect(stats.at(-1)).toMatchObject({
        allChangesDiffStats: { files: 1, allChange: { add: 1, del: 1 } },
        memberDiffStats: { docs: { files: 1, allChange: { add: 1, del: 1 } } },
        persistAllChangesDiffStats: true,
      });
      expect(new Set(watchedRoots.values())).toEqual(new Set([main, extra]));
      const index = publications.at(-1)!;
      expect(index).toHaveProperty('a.txt');
      expect(index[key]).toBeDefined();
      expect(
        (await service.getFileIndex({ sessionId: SESSION_ID, rootId })).fileIndex['a.txt']
      ).toBeDefined();
      expect(
        await service.openTurnDiff({ sessionId: SESSION_ID, rootId, path: 'a.txt', turnId: 'turn' })
      ).toMatchObject({ status: 'ok' });
      const manifest = await service.openDiffManifest({ sessionId: SESSION_ID, turnId: 'turn' });
      expect(manifest).toMatchObject({
        status: 'ok',
        entries: [
          { path: key, base: { key: digestText('old') }, head: { key: digestText('new') } },
        ],
      });
      const allChanges = await service.openDiffManifest({ sessionId: SESSION_ID });
      expect(allChanges).toMatchObject({
        status: 'ok',
        entries: [
          { path: key, base: { key: digestText('old') }, head: { key: digestText('new') } },
        ],
      });
      const page = await service.readBlob({
        sessionId: SESSION_ID,
        rootId,
        key: digestText('new'),
        offset: 0,
        length: 10,
      });
      expect(gunzipSync(Buffer.from(page.data, 'base64')).toString()).toBe('new');
      await expect(
        service.openText({ sessionId: SESSION_ID, rootId: 'member:unknown', path: 'a.txt' })
      ).rejects.toThrow();
    } finally {
      service.dispose();
      expect(watchedRoots.size).toBe(0);
      await store.close();
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('Cross-root manifest bases', () => {
  it('pins and reads each Git root independently, including a focused extra root', async () => {
    await withWorkspace(async (main) =>
      withWorkspace(async (extra) => {
        for (const [root, text] of [
          [main, 'main old\n'],
          [extra, 'extra old\n'],
        ]) {
          await initGitRepoWithCommit(root);
          await writeFile(path.join(root, 'a.txt'), text);
          await gitCommitAll(root, 'base');
          await writeFile(path.join(root, 'a.txt'), text.replace('old', 'new'));
        }
        const rootId = 'member:docs';
        const key = encodeSessionFilePath({ rootId, relativePath: 'a.txt' });
        const roots = [
          { id: 'main', absolutePath: main },
          { id: rootId, absolutePath: extra },
        ];
        const service = new CodeCollabV2Service({
          resolveWorkspace: async (_, options) => ({
            ok: true,
            ownerSessionId: SESSION_ID,
            workspaceRoot: options?.rootId === rootId ? extra : main,
            fileRoots: roots,
          }),
          readOnly: true,
        });
        try {
          const first = await service.openDiffManifest({
            sessionId: SESSION_ID,
            focusPath: key,
            limit: 1,
          });
          if (first.status !== 'ok' || !first.nextCursor || !first.entries[0]?.base)
            throw new Error('Expected a cross-root page.');
          expect(first.entries[0].path).toBe(key);
          const extraPage = await service.readBlob({
            sessionId: SESSION_ID,
            rootId,
            key: first.entries[0].base.key,
            offset: 0,
            length: 100,
          });
          expect(gunzipSync(Buffer.from(extraPage.data, 'base64')).toString()).toBe('extra old\n');
          const second = await service.openDiffManifest({
            sessionId: SESSION_ID,
            focusPath: key,
            limit: 1,
            cursor: first.nextCursor,
          });
          expect(second).toMatchObject({
            status: 'ok',
            entries: [{ path: 'a.txt' }],
            nextCursor: null,
          });
          await gitCommitAll(extra, 'advance extra base');
          await expect(
            service.openDiffManifest({
              sessionId: SESSION_ID,
              focusPath: key,
              limit: 1,
              cursor: first.nextCursor,
            })
          ).rejects.toMatchObject({ code: 'stale' });
        } finally {
          service.dispose();
        }
      })
    );
  });
});

describe('CodeCollabV2Service All Changes scope', () => {
  it('separates branch-cumulative and uncommitted changes and uses HEAD as the uncommitted base', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await initGitRepoWithCommit(workspaceRoot);
      await writeFile(path.join(workspaceRoot, 'base.txt'), 'base\n');
      await writeFile(path.join(workspaceRoot, 'gone.txt'), 'bye\n');
      await gitCommitAll(workspaceRoot, 'init');
      const baseCommit = await gitText(workspaceRoot, 'rev-parse', 'HEAD');

      await gitText(workspaceRoot, 'checkout', '-b', 'feature');
      await writeFile(path.join(workspaceRoot, 'committed.txt'), 'committed\n');
      await writeFile(path.join(workspaceRoot, 'modified.txt'), 'one\n');
      await gitCommitAll(workspaceRoot, 'feature work');
      const head = await gitText(workspaceRoot, 'rev-parse', 'HEAD');

      await writeFile(path.join(workspaceRoot, 'modified.txt'), 'one\ntwo\n');
      await writeFile(path.join(workspaceRoot, 'staged.txt'), 'staged\n');
      await execFileAsync('git', ['add', 'staged.txt'], { cwd: workspaceRoot });
      await writeFile(path.join(workspaceRoot, 'untracked.txt'), 'untracked\n');
      await rm(path.join(workspaceRoot, 'gone.txt'));

      const service = new CodeCollabV2Service({ resolveWorkspace: makeResolver(workspaceRoot) });
      try {
        const branch = await service.openAllChangesDiff({
          sessionId: SESSION_ID,
          scope: 'branch',
        });
        expect(branch).toMatchObject({ status: 'ok', base: baseCommit });
        expect(entryPaths(branch)).toEqual([
          'committed.txt',
          'gone.txt',
          'modified.txt',
          'staged.txt',
          'untracked.txt',
        ]);

        const uncommitted = await service.openAllChangesDiff({
          sessionId: SESSION_ID,
          scope: 'uncommitted',
        });
        expect(uncommitted).toMatchObject({ status: 'ok', base: head });
        expect(entryPaths(uncommitted)).toEqual([
          'gone.txt',
          'modified.txt',
          'staged.txt',
          'untracked.txt',
        ]);

        await gitCommitAll(workspaceRoot, 'commit worktree');
        const afterCommit = await service.openAllChangesDiff({
          sessionId: SESSION_ID,
          scope: 'uncommitted',
        });
        expect(entryPaths(afterCommit)).toEqual([]);
        const afterBranch = await service.openAllChangesDiff({
          sessionId: SESSION_ID,
          scope: 'branch',
        });
        expect(entryPaths(afterBranch)).toContain('committed.txt');
        expect(
          await service.openCurrentDiff({
            sessionId: SESSION_ID,
            path: 'committed.txt',
            scope: 'uncommitted',
          })
        ).toMatchObject({
          status: 'unavailable',
          reason: 'not_changed',
          message: 'This file has no uncommitted changes.',
        });
      } finally {
        service.dispose();
      }
    });
  });

  it('reports explicit unavailability for non-Git and unborn worktrees', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const service = new CodeCollabV2Service({ resolveWorkspace: makeResolver(workspaceRoot) });
      try {
        expect(
          await service.openAllChangesDiff({ sessionId: SESSION_ID, scope: 'uncommitted' })
        ).toMatchObject({ status: 'unavailable', reason: 'not_a_git_worktree' });
      } finally {
        service.dispose();
      }
    });

    await withWorkspace(async (workspaceRoot) => {
      await initGitRepoWithCommit(workspaceRoot);
      const service = new CodeCollabV2Service({ resolveWorkspace: makeResolver(workspaceRoot) });
      try {
        expect(
          await service.openAllChangesDiff({ sessionId: SESSION_ID, scope: 'uncommitted' })
        ).toMatchObject({ status: 'unavailable', reason: 'no_commits' });
      } finally {
        service.dispose();
      }
    });
  });

  it('keeps deferred single-file loads on the uncommitted base and never falls back to the diff store', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await initGitRepoWithCommit(workspaceRoot);
      await writeFile(path.join(workspaceRoot, 'file.txt'), 'old\n');
      await gitCommitAll(workspaceRoot, 'init');
      const head = await gitText(workspaceRoot, 'rev-parse', 'HEAD');
      await writeFile(path.join(workspaceRoot, 'file.txt'), 'old\nnew\n');

      const diffStore = new CodeCollabV2DiffStore('workspace-v2', {
        dbPath: path.join(workspaceRoot, 'diff-store.sqlite3'),
      });
      try {
        await diffStore.recordTurnDiffs({
          workspaceRoot,
          ownerSessionId: SESSION_ID,
          turnId: 'turn-stale',
          capturedAtMs: Date.now(),
          events: [
            {
              path: path.join(workspaceRoot, 'file.txt'),
              oldText: 'stale\n',
              newText: 'stale-new\n',
            },
          ],
        });
        const service = new CodeCollabV2Service({
          resolveWorkspace: makeResolver(workspaceRoot),
          diffStore,
          allChangesDiffLimits: {
            perFileMaxRawBytes: 1,
            perFileMaxCompressedBytes: 1,
            responseBudgetCompressedBytes: 1,
          },
        });
        try {
          const batch = await service.openAllChangesDiff({
            sessionId: SESSION_ID,
            scope: 'uncommitted',
          });
          expect(batch).toMatchObject({ status: 'ok', base: head });
          if (batch.status !== 'ok') return;
          expect(batch.entries.find((entry) => entry.path === 'file.txt')?.status).toBe('deferred');

          const single = await service.openCurrentDiff({
            sessionId: SESSION_ID,
            path: 'file.txt',
            scope: 'uncommitted',
          });
          expect(single.status).toBe('ok');
          if (single.status !== 'ok') return;
          expect(plainSnapshotText(single.oldSnapshot)).toBe('old\n');
          expect(plainSnapshotText(single.newSnapshot)).toBe('old\nnew\n');
        } finally {
          service.dispose();
        }
      } finally {
        await diffStore.close();
      }
    });
  });
});
