import { CodeCollabOpenDiffManifestResponseSchema, type SessionId } from '@lody/shared';
import { writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  activeWorkspaceWatchCount,
  collectPublishedSharedStates,
  digestText,
  execFileAsync,
  gitCommitAll,
  initGitRepoWithCommit,
  makeResolver,
  makeWorkspaceWatchCoordinator,
  registerCodeCollabSeedCleanup,
  SESSION_ID,
  withWorkspace,
} from '../../../tests/code-collab-v2-service-helpers';
import { CodeCollabV2DiffStore } from './code-collab-v2-diff-store';
import {
  CodeCollabV2Service,
  CodeCollabV2ServiceError,
  type CodeCollabV2FileIndexPublication,
} from './code-collab-v2-service';

registerCodeCollabSeedCleanup();

it('reads encrypted file content without starting watchers or publishing an index', async () => {
  await withWorkspace(async (workspaceRoot) => {
    await writeFile(path.join(workspaceRoot, 'readonly.txt'), 'synthetic original');
    const publish = collectPublishedSharedStates();
    const watch = makeWorkspaceWatchCoordinator();
    const service = new CodeCollabV2Service({
      readOnly: true,
      resolveWorkspace: makeResolver(workspaceRoot),
      workspaceWatchCoordinator: watch.coordinator,
      ...publish,
    });
    try {
      const first = await service.openText({ sessionId: SESSION_ID, path: 'readonly.txt' });
      expect(first.status).toBe('ok');
      expect(
        await service.refreshText({
          sessionId: SESSION_ID,
          path: 'readonly.txt',
          digest: first.digest,
        })
      ).toMatchObject({ status: 'up_to_date' });
      expect(activeWorkspaceWatchCount(service)).toBe(0);
      expect(publish.published).toEqual([]);
      expect(publish.signals).toEqual([]);
      expect(await readFile(path.join(workspaceRoot, 'readonly.txt'), 'utf8')).toBe(
        'synthetic original'
      );
    } finally {
      await service.dispose();
    }
  });
});

it('does not rescan for watcher events confined to .gitignore paths', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const git = (...args: string[]) => execFileAsync('git', args, { cwd: workspaceRoot });
    await git('-c', 'init.defaultBranch=main', 'init');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test User');
    await writeFile(path.join(workspaceRoot, '.gitignore'), 'coverage/\n');
    await writeFile(path.join(workspaceRoot, 'README.md'), '# test\n');
    await git('add', '.');
    await git('-c', 'commit.gpgsign=false', 'commit', '-m', 'initial');
    await mkdir(path.join(workspaceRoot, 'coverage'));

    const publish = collectPublishedSharedStates();
    const watch = makeWorkspaceWatchCoordinator();
    const service = new CodeCollabV2Service({
      resolveWorkspace: makeResolver(workspaceRoot),
      workspaceWatchCoordinator: watch.coordinator,
      ...publish,
    });
    // The debounced watcher refresh, awaited directly so its decision is settled.
    const refreshWatched = (
      service as unknown as {
        refreshWatchedWorkspace: (
          ownerSessionId: SessionId,
          watchRoot: string,
          dirtyPaths: ReadonlySet<string> | null
        ) => Promise<void>;
      }
    ).refreshWatchedWorkspace.bind(service);
    try {
      await service.initDirectory({ sessionId: SESSION_ID, path: '.' });
      const baseline = publish.published.length;
      await writeFile(path.join(workspaceRoot, 'late.ts'), 'late\n');
      await writeFile(path.join(workspaceRoot, 'coverage', 'lcov.info'), 'x\n');

      await refreshWatched(SESSION_ID, workspaceRoot, new Set(['coverage/lcov.info']));
      expect(publish.published).toHaveLength(baseline);

      // One visible path in the batch is enough to rescan.
      await refreshWatched(SESSION_ID, workspaceRoot, new Set(['coverage/lcov.info', 'late.ts']));
      expect(publish.published).toHaveLength(baseline + 1);
      expect(Object.keys(publish.published.at(-1)?.fileIndex ?? {})).toContain('late.ts');

      // Dirt without a path (overflow, OS gave none) always rescans.
      await writeFile(path.join(workspaceRoot, 'unreported.ts'), 'x\n');
      await refreshWatched(SESSION_ID, workspaceRoot, null);
      expect(Object.keys(publish.published.at(-1)?.fileIndex ?? {})).toContain('unreported.ts');
    } finally {
      await service.dispose();
    }
  });
});

describe('CodeCollabV2Service text RPC boundary', () => {
  it.each(['sha1', 'sha256'])(
    'serves verified %s Git and disk bytes by session-scoped handles',
    async (objectFormat) => {
      await withWorkspace(async (workspaceRoot) => {
        const git = async (...args: string[]) =>
          (
            await execFileAsync('git', ['-c', 'commit.gpgsign=false', ...args], {
              cwd: workspaceRoot,
            })
          ).stdout.trim();
        await git('init', `--object-format=${objectFormat}`, '-b', 'main');
        await git('config', 'user.name', 'Test');
        await git('config', 'user.email', 'test@example.com');
        const oldText = '\uFEFF旧版本\r\n🙂\r\n';
        const newText = '\uFEFF新版本\r\n🙂\r\n';
        await writeFile(path.join(workspaceRoot, 'a.txt'), oldText);
        await git('add', '.');
        await git('commit', '-m', 'base');
        await writeFile(path.join(workspaceRoot, 'a.txt'), newText);
        let now = 0;
        const service = new CodeCollabV2Service({
          resolveWorkspace: async () => ({ ok: true, ownerSessionId: SESSION_ID, workspaceRoot }),
          diffBlobNow: () => now,
          readOnly: true,
        });
        try {
          const result = await service.openDiffManifest({ sessionId: SESSION_ID, path: 'a.txt' });
          expect(result.status).toBe('ok');
          if (result.status !== 'ok') throw new Error('Expected a manifest.');
          const entry = result.entries[0];
          if (!entry?.base || !entry.head) throw new Error('Expected both blobs.');
          expect(entry.base.key).toBe(`git:${await git('rev-parse', 'HEAD:a.txt')}`);
          expect(entry.head.key).toBe(digestText(newText));
          for (const [blob, text] of [
            [entry.base, oldText],
            [entry.head, newText],
          ] as const) {
            const chunks: Buffer[] = [];
            for (let offset = 0; offset < blob.rawBytes;) {
              const page = await service.readBlob({
                sessionId: SESSION_ID,
                key: blob.key,
                offset,
                length: 5,
              });
              chunks.push(gunzipSync(Buffer.from(page.data, 'base64')));
              offset += page.length;
            }
            expect(Buffer.concat(chunks)).toEqual(Buffer.from(text));
          }
          await expect(
            service.readBlob({
              sessionId: 'another-session',
              key: entry.head.key,
              offset: 0,
              length: 5,
            })
          ).rejects.toMatchObject({ code: 'stale' });
          const diskKey = entry.head.key;
          await withWorkspace(async (outside) => {
            await writeFile(path.join(outside, 'secret.txt'), 'outside');
            await rm(path.join(workspaceRoot, 'a.txt'));
            await symlink(path.join(outside, 'secret.txt'), path.join(workspaceRoot, 'a.txt'));
            await expect(
              service.readBlob({ sessionId: SESSION_ID, key: diskKey, offset: 5, length: 5 })
            ).rejects.toMatchObject({ code: 'invalid_path' });
          });
          now = 600_001;
          await expect(
            service.readBlob({ sessionId: SESSION_ID, key: entry.base.key, offset: 0, length: 5 })
          ).rejects.toMatchObject({ code: 'stale' });
        } finally {
          service.dispose();
        }
      });
    }
  );

  it('keeps symlinks, directories and fetched or unfetched gitlinks local to their own entry', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const git = async (...args: string[]) =>
        (
          await execFileAsync('git', ['-c', 'commit.gpgsign=false', ...args], {
            cwd: workspaceRoot,
          })
        ).stdout.trim();
      await initGitRepoWithCommit(workspaceRoot);
      await writeFile(path.join(workspaceRoot, 'healthy.txt'), 'before\n');
      await writeFile(path.join(workspaceRoot, 'directory.txt'), 'before\n');
      await symlink('healthy.txt', path.join(workspaceRoot, 'link'));
      await symlink('healthy.txt', path.join(workspaceRoot, 'deleted-link'));
      await gitCommitAll(workspaceRoot, 'files');
      const existingCommit = await git('rev-parse', 'HEAD');
      for (const [name, oid] of [
        ['fetched', existingCommit],
        ['unfetched', '1'.repeat(40)],
      ]) {
        await git('update-index', '--add', '--cacheinfo', `160000,${oid},${name}`);
        await mkdir(path.join(workspaceRoot, name));
      }
      await git('commit', '-m', 'gitlinks');
      for (const name of ['fetched', 'unfetched'])
        await git('update-index', '--cacheinfo', `160000,${'2'.repeat(40)},${name}`);
      await writeFile(path.join(workspaceRoot, 'healthy.txt'), 'after\n');
      await rm(path.join(workspaceRoot, 'link'));
      await symlink('directory.txt', path.join(workspaceRoot, 'link'));
      await rm(path.join(workspaceRoot, 'deleted-link'));
      await rm(path.join(workspaceRoot, 'directory.txt'));
      await mkdir(path.join(workspaceRoot, 'directory.txt'));
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        readOnly: true,
      });
      try {
        const manifest = await service.openDiffManifest({ sessionId: SESSION_ID });
        expect(manifest.status).toBe('ok');
        if (manifest.status !== 'ok') throw new Error('Expected manifest.');
        for (const unsupported of [
          'link',
          'deleted-link',
          'directory.txt',
          'fetched',
          'unfetched',
        ]) {
          expect(manifest.entries.find((entry) => entry.path === unsupported)).toMatchObject({
            status: 'binary',
          });
          expect(
            await service.openDiffManifest({ sessionId: SESSION_ID, path: unsupported })
          ).toMatchObject({ status: 'ok', entries: [{ status: 'binary' }] });
        }
        const healthy = manifest.entries.find((entry) => entry.path === 'healthy.txt');
        expect(healthy?.status).toBe('ok');
        if (!healthy?.head) throw new Error('Missing healthy blob.');
        const page = await service.readBlob({
          sessionId: SESSION_ID,
          key: healthy.head.key,
          offset: 0,
          length: 100,
        });
        expect(gunzipSync(Buffer.from(page.data, 'base64')).toString()).toBe('after\n');
        await expect(
          service.openDiffManifest({ sessionId: SESSION_ID, path: '../outside' })
        ).rejects.toMatchObject({ code: 'invalid_path' });
      } finally {
        service.dispose();
      }
    });
  });

  it('isolates file read failures and recovers a stale capture against the pinned base', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await initGitRepoWithCommit(workspaceRoot);
      for (const name of ['blocked.txt', 'healthy.txt'])
        await writeFile(path.join(workspaceRoot, name), 'before\n');
      await gitCommitAll(workspaceRoot, 'base');
      for (const name of ['blocked.txt', 'healthy.txt'])
        await writeFile(path.join(workspaceRoot, name), 'after\n');
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        readOnly: true,
      });
      const internal = service as unknown as {
        describeDiffFile: (...args: unknown[]) => Promise<unknown>;
      };
      const describe = internal.describeDiffFile.bind(service);
      let code: 'permission_denied' | 'stale' = 'permission_denied';
      let remainingFailures = Infinity;
      const fault = vi.spyOn(internal, 'describeDiffFile').mockImplementation((...args) => {
        if (
          (args[1] as { workspacePath: string }).workspacePath === 'blocked.txt' &&
          remainingFailures-- > 0
        )
          throw new CodeCollabV2ServiceError(code, 'Synthetic read refusal.');
        return describe(...args);
      });
      try {
        expect(
          CodeCollabOpenDiffManifestResponseSchema.parse(
            await service.openDiffManifest({ sessionId: SESSION_ID })
          )
        ).toMatchObject({
          status: 'ok',
          entries: expect.arrayContaining([
            {
              path: 'blocked.txt',
              status: 'unavailable',
              base: null,
              head: null,
              error: {
                status: 'error',
                code: 'permission_denied',
                message: 'Synthetic read refusal.',
              },
              add: 1,
              del: 1,
            },
            expect.objectContaining({
              path: 'healthy.txt',
              status: 'ok',
              head: expect.any(Object),
            }),
          ]),
        });
        code = 'stale';
        remainingFailures = 1;
        expect(await service.openDiffManifest({ sessionId: SESSION_ID })).toMatchObject({
          status: 'ok',
          entries: expect.arrayContaining([
            expect.objectContaining({
              path: 'blocked.txt',
              status: 'ok',
              base: expect.any(Object),
              head: expect.any(Object),
            }),
            expect.objectContaining({ path: 'healthy.txt', status: 'ok' }),
          ]),
        });
        remainingFailures = Infinity;
        expect(await service.openDiffManifest({ sessionId: SESSION_ID })).toMatchObject({
          status: 'ok',
          entries: expect.arrayContaining([
            expect.objectContaining({
              path: 'blocked.txt',
              status: 'unavailable',
              error: expect.objectContaining({ code: 'stale' }),
            }),
            expect.objectContaining({ path: 'healthy.txt', status: 'ok' }),
          ]),
        });
      } finally {
        fault.mockRestore();
        service.dispose();
      }
    });
  });

  it('isolates an escaping parent path without granting file or request access', async () => {
    await withWorkspace(async (outside) => {
      await withWorkspace(async (workspaceRoot) => {
        await initGitRepoWithCommit(workspaceRoot);
        await mkdir(path.join(workspaceRoot, 'directory'));
        await writeFile(path.join(workspaceRoot, 'directory', 'blocked.txt'), 'before\n');
        await writeFile(path.join(workspaceRoot, 'healthy.txt'), 'before\n');
        await gitCommitAll(workspaceRoot, 'base');
        const outsideText = 'synthetic outside content\n';
        await writeFile(path.join(outside, 'blocked.txt'), outsideText);
        await rm(path.join(workspaceRoot, 'directory'), { recursive: true });
        await symlink(outside, path.join(workspaceRoot, 'directory'));
        await writeFile(path.join(workspaceRoot, 'healthy.txt'), 'after\n');
        let authorized = true;
        const service = new CodeCollabV2Service({
          readOnly: true,
          resolveWorkspace: async () =>
            authorized
              ? { ok: true, ownerSessionId: SESSION_ID, workspaceRoot }
              : { ok: false, code: 'permission_denied', message: 'Synthetic request refusal.' },
        });
        try {
          const result = CodeCollabOpenDiffManifestResponseSchema.parse(
            await service.openDiffManifest({ sessionId: SESSION_ID })
          );
          expect(result).toMatchObject({
            status: 'ok',
            entries: expect.arrayContaining([
              expect.objectContaining({
                path: 'directory/blocked.txt',
                status: 'unavailable',
                base: null,
                head: null,
                error: expect.objectContaining({ code: 'invalid_path' }),
              }),
              expect.objectContaining({ path: 'healthy.txt', status: 'ok' }),
            ]),
          });
          if (result.status !== 'ok') throw new Error('Expected a manifest.');
          const healthy = result.entries.find((entry) => entry.path === 'healthy.txt');
          if (!healthy?.head) throw new Error('Expected a readable healthy file.');
          const body = await service.readBlob({
            sessionId: SESSION_ID,
            key: healthy.head.key,
            offset: 0,
            length: healthy.head.rawBytes,
          });
          expect(gunzipSync(Buffer.from(body.data, 'base64')).toString('utf8')).toBe('after\n');
          await expect(
            service.readBlob({
              sessionId: SESSION_ID,
              key: digestText(outsideText),
              offset: 0,
              length: 1,
            })
          ).rejects.toMatchObject({ code: 'stale' });
          await expect(
            service.openDiffManifest({ sessionId: SESSION_ID, path: '../blocked.txt' })
          ).rejects.toMatchObject({ code: 'invalid_path' });
          authorized = false;
          await expect(service.openDiffManifest({ sessionId: SESSION_ID })).rejects.toMatchObject({
            code: 'permission_denied',
          });
        } finally {
          service.dispose();
        }
      });
    });
  });

  it('returns stale when a disk blob is deleted or replaced by a directory after its manifest', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await initGitRepoWithCommit(workspaceRoot);
      await writeFile(path.join(workspaceRoot, 'a.txt'), 'before\n');
      await gitCommitAll(workspaceRoot, 'base');
      await writeFile(path.join(workspaceRoot, 'a.txt'), 'after\n');
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        readOnly: true,
      });
      try {
        const manifest = await service.openDiffManifest({ sessionId: SESSION_ID, path: 'a.txt' });
        if (manifest.status !== 'ok' || !manifest.entries[0]?.head)
          throw new Error('Expected disk blob.');
        const key = manifest.entries[0].head.key;
        await rm(path.join(workspaceRoot, 'a.txt'));
        await expect(
          service.readBlob({ sessionId: SESSION_ID, key, offset: 0, length: 10 })
        ).rejects.toMatchObject({ code: 'stale' });
        expect(
          await service.openDiffManifest({ sessionId: SESSION_ID, path: 'a.txt' })
        ).toMatchObject({ status: 'ok', entries: [{ head: null }] });
        await mkdir(path.join(workspaceRoot, 'a.txt'));
        await expect(
          service.readBlob({ sessionId: SESSION_ID, key, offset: 0, length: 10 })
        ).rejects.toMatchObject({ code: 'stale' });
      } finally {
        service.dispose();
      }
    });
  });

  it('serves bounded remote hunks and full local blobs for the same large file', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await initGitRepoWithCommit(workspaceRoot);
      const before = Array.from({ length: 2500 }, (_, i) => `line ${i} ${'x'.repeat(120)}\n`).join(
        ''
      );
      const after = before.replace('line 1200 ', 'CHANGED 1200 ');
      await writeFile(path.join(workspaceRoot, 'large.txt'), before);
      await gitCommitAll(workspaceRoot, 'base');
      await writeFile(path.join(workspaceRoot, 'large.txt'), after);
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        readOnly: true,
      });
      try {
        const request = { sessionId: SESSION_ID, path: 'large.txt' };
        const list = await service.openDiffManifest(
          { sessionId: SESSION_ID },
          {
            plane: 'remote',
            measureResponse: async (value) => Buffer.byteLength(JSON.stringify(value)),
          }
        );
        if (list.status !== 'ok') throw new Error('Expected a change list.');
        expect(list.entries).toMatchObject([{ path: 'large.txt', status: 'ok', add: 1, del: 1 }]);
        expect(list.entries[0]?.hunks).toBeUndefined();
        const remote = await service.openDiffManifest(request, {
          plane: 'remote',
          measureResponse: async (value) => Buffer.byteLength(JSON.stringify(value)),
        });
        expect(remote).toMatchObject({
          status: 'ok',
          entries: [{ status: 'ok', hunks: expect.stringContaining('+CHANGED 1200 ') }],
        });
        if (remote.status !== 'ok') throw new Error('Expected a manifest.');
        expect(Buffer.byteLength(remote.entries[0]?.hunks ?? '')).toBeLessThan(4096);
        const local = await service.openDiffManifest(request);
        if (local.status !== 'ok') throw new Error('Expected a local manifest.');
        expect(local.entries[0]?.hunks).toBeUndefined();
        expect(local.entries[0]?.head).toEqual(remote.entries[0]?.head);
        expect(list.entries[0]?.head).toEqual(remote.entries[0]?.head);
        await writeFile(
          path.join(workspaceRoot, 'large.txt'),
          Array.from({ length: 2500 }, (_, i) => `rewritten ${i} ${'y'.repeat(120)}\n`).join('')
        );
        expect(
          await service.openDiffManifest(request, {
            plane: 'remote',
            measureResponse: async (value) => Buffer.byteLength(JSON.stringify(value)),
          })
        ).toMatchObject({
          status: 'ok',
          entries: [{ status: 'ok', base: expect.any(Object), head: expect.any(Object) }],
        });
        // A 350-line replacement also exceeds the edit budget, despite a small patch.
        await writeFile(
          path.join(workspaceRoot, 'large.txt'),
          before
            .split('\n')
            .map((line, i) => (i < 350 ? line.replace('line', 'changed') : line))
            .join('\n')
        );
        const fallback = await service.openDiffManifest(request, {
          plane: 'remote',
          measureResponse: async (value) => Buffer.byteLength(JSON.stringify(value)),
        });
        if (fallback.status !== 'ok' || !fallback.entries[0]?.head)
          throw new Error('Expected blobs.');
        expect(fallback.entries[0].status).toBe('ok');
        expect(fallback.entries[0].hunks).toBeUndefined();
        const body = await service.readBlob({
          sessionId: SESSION_ID,
          key: fallback.entries[0].head.key,
          offset: 0,
          length: 512 * 1024,
        });
        expect(gunzipSync(Buffer.from(body.data, 'base64')).toString()).toBe(
          await readFile(path.join(workspaceRoot, 'large.txt'), 'utf8')
        );
        expect(activeWorkspaceWatchCount(service)).toBe(0);
      } finally {
        service.dispose();
      }
    });
  });

  it('uses the same disk snapshot for remote hunk coordinates and content identity', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await initGitRepoWithCommit(workspaceRoot);
      const before = Array.from({ length: 2000 }, (_, i) => `line ${i} ${'x'.repeat(125)}\n`).join(
        ''
      );
      const first = before.replace('line 500 ', 'first500 ');
      const later = before.replace('line 1000 ', 'later1000 ');
      await writeFile(path.join(workspaceRoot, 'race.txt'), before);
      await gitCommitAll(workspaceRoot, 'base');
      await writeFile(path.join(workspaceRoot, 'race.txt'), first);
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        readOnly: true,
      });
      const registry = (
        service as unknown as {
          diffBlobs: {
            issue: (session: string, key: string, handle: { source: { kind: string } }) => void;
          };
        }
      ).diffBlobs;
      const issue = registry.issue.bind(registry);
      const spy = vi.spyOn(registry, 'issue').mockImplementation((session, key, handle) => {
        issue(session, key, handle);
        if (handle.source.kind === 'disk')
          writeFileSync(path.join(workspaceRoot, 'race.txt'), later);
      });
      try {
        const result = await service.openDiffManifest(
          { sessionId: SESSION_ID, path: 'race.txt' },
          {
            plane: 'remote',
            measureResponse: async (value) => Buffer.byteLength(JSON.stringify(value)),
          }
        );
        expect(result).toMatchObject({
          status: 'ok',
          entries: [
            { head: { key: digestText(first) }, hunks: expect.stringContaining('+first500 ') },
          ],
        });
        if (result.status !== 'ok') throw new Error('Expected manifest.');
        expect(result.entries[0]?.hunks).not.toContain('+later1000 ');
        // Wire envelope pressure also falls back to blobs without losing availability.
        const reduced = await service.openDiffManifest(
          { sessionId: SESSION_ID, path: 'race.txt' },
          {
            plane: 'remote',
            measureResponse: async (value) =>
              JSON.stringify(value).includes('hunks') ? 600_000 : 1000,
          }
        );
        if (reduced.status !== 'ok') throw new Error('Expected manifest.');
        expect(reduced.entries[0]).toMatchObject({
          status: 'ok',
          head: { key: digestText(later) },
        });
        expect(reduced.entries[0]?.hunks).toBeUndefined();
      } finally {
        spy.mockRestore();
        service.dispose();
      }
    });
  });

  it('reports missing evidence without creating a database or workspace watcher', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, 'a.txt'), 'disk only');
      const reader = new CodeCollabV2DiffStore('workspace-v2', {
        dbPath: path.join(workspaceRoot, 'missing-evidence', 'db.sqlite3'),
        readOnly: true,
      });
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        diffStore: reader,
        readOnly: true,
      });
      try {
        expect(await service.openDiffManifest({ sessionId: SESSION_ID, path: 'a.txt' })).toEqual({
          status: 'unavailable',
          reason: 'base_unavailable',
        });
        expect(
          await service.openDiffManifest({
            sessionId: SESSION_ID,
            path: 'a.txt',
            turnId: 'missing-turn',
          })
        ).toEqual({ status: 'unavailable', reason: 'turn_unavailable' });
        expect(await readdir(workspaceRoot)).toEqual(['a.txt']);
        expect(activeWorkspaceWatchCount(service)).toBe(0);
      } finally {
        service.dispose();
        await reader.close();
      }
    });
  });

  it('reads retained non-Git and historical bytes through the read-only worker and refuses expired handles', async () => {
    await withWorkspace(async (workspaceRoot) => {
      let now = 1000;
      const dbPath = path.join(workspaceRoot, 'evidence.sqlite3');
      const before = '\uFEFF' + '中文🙂\r\n'.repeat(40_000);
      const after = before + 'recorded\r\n';
      const writer = new CodeCollabV2DiffStore('workspace-v2', { dbPath, now: () => now });
      await writer.recordTurnDiffs({
        workspaceRoot,
        ownerSessionId: SESSION_ID,
        turnId: 'turn-1',
        capturedAtMs: now,
        events: [{ path: path.join(workspaceRoot, 'a.txt'), oldText: before, newText: after }],
      });
      await writer.close();
      const reader = new CodeCollabV2DiffStore('workspace-v2', {
        dbPath,
        readOnly: true,
        now: () => now,
      });
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        diffStore: reader,
        readOnly: true,
        diffBlobNow: () => 1000,
      });
      try {
        await writeFile(path.join(workspaceRoot, 'a.txt'), 'current disk');
        const historical = await service.openDiffManifest({
          sessionId: SESSION_ID,
          path: 'a.txt',
          turnId: 'turn-1',
        });
        if (historical.status !== 'ok' || !historical.entries[0]?.head)
          throw new Error('Expected history.');
        const head = historical.entries[0].head;
        const chunks: Buffer[] = [];
        for (let offset = 0; offset < head.rawBytes;) {
          const page = await service.readBlob({
            sessionId: SESSION_ID,
            key: head.key,
            offset,
            length: 131_073,
          });
          chunks.push(gunzipSync(Buffer.from(page.data, 'base64')));
          offset += page.length;
        }
        expect(Buffer.concat(chunks)).toEqual(Buffer.from(after));
        expect(historical.entries[0].base?.key).toBe(digestText(before));
        const current = await service.openDiffManifest({ sessionId: SESSION_ID, path: 'a.txt' });
        expect(current).toMatchObject({
          status: 'ok',
          entries: [
            { base: { key: digestText(before) }, head: { key: digestText('current disk') } },
          ],
        });
        const oldKey = historical.entries[0].base?.key;
        if (!oldKey) throw new Error('Expected pre-image.');
        now += 101 * 86_400_000;
        await expect(
          service.readBlob({ sessionId: SESSION_ID, key: oldKey, offset: 0, length: 100 })
        ).rejects.toMatchObject({ code: 'stale' });
        expect(activeWorkspaceWatchCount(service)).toBe(0);
      } finally {
        service.dispose();
        await reader.close();
      }
    });
  });

  it('invalidates only a changed file when its line counts stay equal', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await initGitRepoWithCommit(workspaceRoot);
      await writeFile(path.join(workspaceRoot, 'a.txt'), 'old a\n');
      await writeFile(path.join(workspaceRoot, 'b.txt'), 'old b\n');
      await gitCommitAll(workspaceRoot, 'base');
      await writeFile(path.join(workspaceRoot, 'a.txt'), 'new a\n');
      await writeFile(path.join(workspaceRoot, 'b.txt'), 'new b\n');
      const published: CodeCollabV2FileIndexPublication[] = [];
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        publishFileIndex: async (state) => {
          published.push(state);
          return { changed: true };
        },
      });
      try {
        await service.refreshSharedState({ sessionId: SESSION_ID });
        const initial = published.at(-1);
        await writeFile(path.join(workspaceRoot, 'a.txt'), 'nexta\n');
        await utimes(path.join(workspaceRoot, 'a.txt'), new Date(1000), new Date(2000));
        await service.refreshSharedStateAfterTurn({ sessionId: SESSION_ID });
        const changed = published.at(-1);
        expect(changed?.fileIndex).toEqual(initial?.fileIndex);
        expect(changed?.resetDiffGenerations).toBe(false);
        expect(changed?.bumpDiffPaths).toEqual(['a.txt']);
        await service.refreshSharedStateAfterTurn({ sessionId: SESSION_ID });
        expect(published.at(-1)?.fileIndex).toEqual(changed?.fileIndex);
        expect(published.at(-1)?.bumpDiffPaths).toEqual([]);
        expect(published.at(-1)?.allChangesDiffStats).toEqual({
          files: 2,
          allChange: { add: 2, del: 2 },
        });
      } finally {
        service.dispose();
      }
    });
  });

  it('publishes full workspace totals before the shared file index is trimmed', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await initGitRepoWithCommit(workspaceRoot);
      const directory = path.join(workspaceRoot, 'a'.repeat(180));
      await mkdir(directory);
      const count = 256;
      const paths = Array.from({ length: count }, (_, index) =>
        path.join(directory, `${String(index).padStart(3, '0')}-${'b'.repeat(180)}.txt`)
      );
      await Promise.all(paths.map((file) => writeFile(file, 'before\n')));
      await gitCommitAll(workspaceRoot, 'baseline');
      await Promise.all(paths.map((file) => writeFile(file, 'after\n')));
      const { published, publishFileIndex } = collectPublishedSharedStates();
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        publishFileIndex,
      });
      try {
        await service.initDirectory({ sessionId: SESSION_ID, path: '.' });
        const snapshot = published.at(-1);
        expect(Object.keys(snapshot?.allChanges ?? {}).length).toBeLessThan(count);
        expect(snapshot?.allChangesDiffStats).toEqual({
          files: count,
          allChange: { add: count, del: count },
        });
      } finally {
        service.dispose();
      }
    });
  });

  it('clamps blob pages against the encoded response budget and rejects a cursor after its base moves', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const git = async (...args: string[]) =>
        (
          await execFileAsync('git', ['-c', 'commit.gpgsign=false', ...args], {
            cwd: workspaceRoot,
          })
        ).stdout.trim();
      await git('init', '-b', 'main');
      await git('config', 'user.name', 'Test');
      await git('config', 'user.email', 'test@example.com');
      await writeFile(path.join(workspaceRoot, 'base.txt'), 'base\n');
      await git('add', '.');
      await git('commit', '-m', 'base');
      let seed = 42;
      const random = Array.from({ length: 700_000 }, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return String.fromCharCode(32 + (seed % 95));
      }).join('');
      await writeFile(path.join(workspaceRoot, 'a.txt'), random);
      await writeFile(path.join(workspaceRoot, 'b.txt'), 'b\n');
      const service = new CodeCollabV2Service({
        resolveWorkspace: async () => ({ ok: true, ownerSessionId: SESSION_ID, workspaceRoot }),
      });
      try {
        const first = await service.openDiffManifest({ sessionId: SESSION_ID, limit: 1 });
        if (first.status !== 'ok' || !first.nextCursor)
          throw new Error('Expected a paged manifest.');
        const single = await service.openDiffManifest({ sessionId: SESSION_ID, path: 'a.txt' });
        if (single.status !== 'ok' || !single.entries[0]?.head) throw new Error('Expected a blob.');
        const key = single.entries[0].head.key;
        const meter = async (value: unknown) =>
          Math.ceil((Buffer.byteLength(JSON.stringify(value)) * 4) / 3) + 2048;
        const page = await service.readBlob(
          { sessionId: SESSION_ID, key, offset: 0, length: Number.MAX_SAFE_INTEGER },
          { plane: 'remote', measureResponse: meter }
        );
        expect(await meter(page)).toBeLessThanOrEqual(512 * 1024);
        expect(gunzipSync(Buffer.from(page.data, 'base64'))).toEqual(
          Buffer.from(random).subarray(0, page.length)
        );
        expect(page.length).toBeLessThan(512 * 1024);
        await git('add', '.');
        await git('commit', '-m', 'advance base');
        await expect(
          service.openDiffManifest({ sessionId: SESSION_ID, limit: 1, cursor: first.nextCursor })
        ).rejects.toMatchObject({ code: 'stale' });
      } finally {
        service.dispose();
      }
    });
  });
});
