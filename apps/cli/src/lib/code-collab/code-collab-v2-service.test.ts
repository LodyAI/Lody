import { gunzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { symlink, utimes } from 'node:fs/promises';
import { encodeSessionFilePath } from '@lody/shared';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import {
  codeCollabFileIndexToSharedState,
  CodeCollabOpenDiffManifestResponseSchema,
  type CodeCollabV2AllChangesState,
  type CodeCollabV2FileIndexState,
  type CodeCollabV2FileTreeState,
  type SessionId,
} from '@lody/shared';
import {
  CodeCollabV2Service,
  CodeCollabV2ServiceError,
  type CodeCollabV2FileIndexPublication,
  type CodeCollabV2FileIndexSignalPublication,
  type CodeCollabV2WorkspaceResolver,
} from './code-collab-v2-service';
import { CodeCollabV2DiffStore } from './code-collab-v2-diff-store';
import { getGitDiffStats } from '../git/git-diff-stats';
import type {
  WorkspaceWatchCoordinatorApi,
  WorkspaceWatchDirtyReason,
} from './workspace-watch-coordinator';

const SESSION_ID = 'session-v2' as SessionId;
const execFileAsync = promisify(execFile);

const digestText = (text: string): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`;

const digestRaw = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

type PublishedSharedState = {
  readonly fileTree: CodeCollabV2FileTreeState;
  readonly allChanges: CodeCollabV2AllChangesState;
  readonly fileIndex: CodeCollabV2FileIndexState;
  readonly allChangesDiffStats: CodeCollabV2FileIndexPublication['allChangesDiffStats'];
  readonly persistAllChangesDiffStats: boolean;
  readonly updatedAtMs: number;
};

function collectPublishedSharedStates(): {
  readonly published: PublishedSharedState[];
  readonly signals: CodeCollabV2FileIndexSignalPublication[];
  readonly publishFileIndex: (state: CodeCollabV2FileIndexPublication) => Promise<void>;
  readonly publishFileIndexSignal: (state: CodeCollabV2FileIndexSignalPublication) => Promise<void>;
} {
  const published: PublishedSharedState[] = [];
  const signals: CodeCollabV2FileIndexSignalPublication[] = [];
  return {
    published,
    signals,
    publishFileIndex: async (state) => {
      const { fileTree, allChanges } = codeCollabFileIndexToSharedState(state.fileIndex);
      published.push({
        fileTree,
        allChanges,
        fileIndex: state.fileIndex,
        allChangesDiffStats: state.allChangesDiffStats,
        persistAllChangesDiffStats: state.persistAllChangesDiffStats,
        updatedAtMs: state.updatedAtMs,
      });
    },
    publishFileIndexSignal: async (state) => {
      signals.push(state);
    },
  };
}

const makeResolver =
  (workspaceRoot: string): CodeCollabV2WorkspaceResolver =>
  async () => ({
    ok: true,
    ownerSessionId: SESSION_ID,
    workspaceRoot,
  });

async function withWorkspace<T>(fn: (workspaceRoot: string) => Promise<T>): Promise<T> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'lody-code-collab-v2-'));
  try {
    return await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function activeWorkspaceWatchCount(service: CodeCollabV2Service): number {
  return (
    service as unknown as {
      readonly watchByOwnerSessionId: ReadonlyMap<SessionId, unknown>;
    }
  ).watchByOwnerSessionId.size;
}

function makeWorkspaceWatchCoordinator(): {
  coordinator: WorkspaceWatchCoordinatorApi;
  dirty: (reason?: WorkspaceWatchDirtyReason) => void;
  releaseCount: () => number;
} {
  let onDirty: ((reason: WorkspaceWatchDirtyReason) => void) | null = null;
  let releases = 0;
  return {
    coordinator: {
      subscribe: async (options) => {
        onDirty = options.onDirty;
        return {
          canonicalRoot: options.workspaceRoot,
          release: () => {
            releases += 1;
          },
        };
      },
    },
    dirty: (reason = 'event') => onDirty?.(reason),
    releaseCount: () => releases,
  };
}

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
        expect(published.at(-1)).toBe(changed);
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

  it('uses the configured refresh deadline, cancels publication and lets a queued refresh publish newer files', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, 'old.ts'), 'old');
      let release = () => {};
      let started = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      let heldSignal: AbortSignal | undefined;
      let attempts = 0;
      const snapshots: string[][] = [];
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        publishFileIndex: async (publication) => {
          if (++attempts === 2) {
            heldSignal = publication.signal;
            started();
            await gate;
          }
          publication.signal?.throwIfAborted();
          snapshots.push(Object.keys(publication.fileIndex));
          return { changed: true };
        },
      });
      try {
        await service.refreshSharedState({ sessionId: SESSION_ID });
        vi.stubEnv('LODY_CODE_COLLAB_TASK_TIMEOUT_MS', '100');
        vi.useFakeTimers();
        const expired = expect(
          service.refreshSharedStateAfterTurn({ sessionId: SESSION_ID })
        ).rejects.toThrow('exceeded 100ms');
        await entered;
        await writeFile(path.join(workspaceRoot, 'new.ts'), 'new');
        // Wait for actual queue admission before advancing the clock; filesystem
        // resolution of the next request must not race its own deadline.
        const queueApi = service as unknown as {
          enqueueSharedStateRefresh: (...args: unknown[]) => Promise<void>;
        };
        const enqueue = queueApi.enqueueSharedStateRefresh.bind(service);
        let admitted = () => {};
        const queued = new Promise<void>((resolve) => {
          admitted = resolve;
        });
        const admission = vi
          .spyOn(queueApi, 'enqueueSharedStateRefresh')
          .mockImplementation((...args) => {
            const result = enqueue(...args);
            admitted();
            return result;
          });
        const next = service.refreshSharedStateAfterTurn({ sessionId: SESSION_ID });
        await queued;
        admission.mockRestore();
        await vi.advanceTimersByTimeAsync(100);
        await expired;
        await next;
        expect(heldSignal?.aborted).toBe(true);
        expect(snapshots.at(-1)).toContain('new.ts');
        release();
        await gate;
        expect(snapshots).toHaveLength(2);
      } finally {
        release();
        service.dispose();
        vi.useRealTimers();
        vi.unstubAllEnvs();
      }
    });
  });

  it.runIf(process.platform !== 'win32')(
    'keeps ordinary POSIX mode on an existing file after a successful save',
    async () => {
      const modeOf = async (filePath: string) => ((await stat(filePath)).mode & 0o777).toString(8);
      const script = '#!/bin/sh\nprintf "saved\\n"\n';

      await withWorkspace(async (workspaceRoot) => {
        const previousMask = process.umask(0o022);
        try {
          const filePath = path.join(workspaceRoot, 'run.sh');
          await writeFile(filePath, '#!/bin/sh\nprintf "old\\n"\n');
          await chmod(filePath, 0o755);
          const service = new CodeCollabV2Service({
            resolveWorkspace: makeResolver(workspaceRoot),
          });
          const opened = await service.openText({ sessionId: SESSION_ID, path: 'run.sh' });
          const saved = await service.saveText({
            sessionId: SESSION_ID,
            requestedByUserId: 'user-1',
            path: 'run.sh',
            baseDigest: opened.digest,
            text: {
              encoding: 'plain',
              text: script,
              rawBytes: Buffer.byteLength(script),
            },
          });
          expect(saved.status).toBe('ok');
          expect(await readFile(filePath, 'utf8')).toBe(script);
          expect(await modeOf(filePath)).toBe('755');
          const ran = spawnSync(filePath, [], { encoding: 'utf8' });
          expect(ran.error).toBeUndefined();
          expect(ran.status).toBe(0);
          expect(ran.stdout).toBe('saved\n');
        } finally {
          process.umask(previousMask);
        }
      });

      await withWorkspace(async (workspaceRoot) => {
        const filePath = path.join(workspaceRoot, 'secret.txt');
        await writeFile(filePath, 'old\n');
        await chmod(filePath, 0o600);
        const service = new CodeCollabV2Service({
          resolveWorkspace: makeResolver(workspaceRoot),
        });
        const opened = await service.openText({ sessionId: SESSION_ID, path: 'secret.txt' });
        const saved = await service.saveText({
          sessionId: SESSION_ID,
          requestedByUserId: 'user-1',
          path: 'secret.txt',
          baseDigest: opened.digest,
          text: {
            encoding: 'plain',
            text: 'new\n',
            rawBytes: Buffer.byteLength('new\n'),
          },
        });
        expect(saved.status).toBe('ok');
        expect(await readFile(filePath, 'utf8')).toBe('new\n');
        expect(await modeOf(filePath)).toBe('600');
      });
    }
  );

  it('does not recreate a deleted file when save reports file_deleted', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'gone.ts');
      await writeFile(filePath, 'old\n');
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
      });
      const opened = await service.openText({ sessionId: SESSION_ID, path: 'gone.ts' });
      await rm(filePath);
      const deleted = await service.saveText({
        sessionId: SESSION_ID,
        requestedByUserId: 'user-1',
        path: 'gone.ts',
        baseDigest: opened.digest,
        text: {
          encoding: 'plain',
          text: 'new\n',
          rawBytes: Buffer.byteLength('new\n'),
        },
      });
      expect(deleted).toEqual({
        status: 'conflict',
        reason: 'file_deleted',
        path: 'gone.ts',
        baseDigest: opened.digest,
      });
      await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('returns after the durable save without waiting for shared-state publishing', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'hello.ts');
      await writeFile(filePath, 'old\n');
      let resolvePublishStarted: (() => void) | undefined;
      const publishStarted = new Promise<void>((resolve) => {
        resolvePublishStarted = resolve;
      });
      let releasePublish: (() => void) | undefined;
      const publishGate = new Promise<void>((resolve) => {
        releasePublish = resolve;
      });
      let published = false;
      let publication: Promise<void> | undefined;
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        publishFileIndex: () => {
          publication = publishGate.then(() => {
            published = true;
          });
          resolvePublishStarted?.();
          return publication;
        },
      });
      let save: ReturnType<CodeCollabV2Service['saveText']> | undefined;
      try {
        const opened = await service.openText({ sessionId: SESSION_ID, path: 'hello.ts' });
        save = service.saveText({
          sessionId: SESSION_ID,
          requestedByUserId: 'user-1',
          path: 'hello.ts',
          baseDigest: opened.digest,
          text: {
            encoding: 'plain',
            text: 'new\n',
            rawBytes: Buffer.byteLength('new\n'),
          },
        });
        const saved = await save;
        expect(saved).toEqual({
          status: 'ok',
          path: 'hello.ts',
          digest: digestText('new\n'),
          rawBytes: Buffer.byteLength('new\n'),
        });
        expect(await readFile(filePath, 'utf8')).toBe('new\n');
        await publishStarted;
        expect(published).toBe(false);
        releasePublish?.();
        await publication;
        expect(published).toBe(true);
      } finally {
        releasePublish?.();
        // Never remove the workspace while the durable save is still writing.
        try {
          await save;
          await publication;
        } finally {
          service.dispose();
        }
      }
    });
  });

  it('serializes concurrent saves to the same file so the loser reports a conflict', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'note.txt');
      await writeFile(filePath, 'base\n');
      const service = new CodeCollabV2Service({ resolveWorkspace: makeResolver(workspaceRoot) });
      const opened = await service.openText({ sessionId: SESSION_ID, path: 'note.txt' });

      // Both saves race against the same base digest. Without per-path serialization
      // they would both pass the digest check and the second write would silently
      // clobber the first; with it, the loser re-reads the just-written digest and
      // reports a digest_mismatch conflict instead.
      const [first, second] = await Promise.all([
        service.saveText({
          sessionId: SESSION_ID,
          requestedByUserId: 'user-1',
          path: 'note.txt',
          baseDigest: opened.digest,
          text: { encoding: 'plain', text: 'first\n', rawBytes: Buffer.byteLength('first\n') },
        }),
        service.saveText({
          sessionId: SESSION_ID,
          requestedByUserId: 'user-2',
          path: 'note.txt',
          baseDigest: opened.digest,
          text: { encoding: 'plain', text: 'second\n', rawBytes: Buffer.byteLength('second\n') },
        }),
      ]);

      expect([first.status, second.status].sort()).toEqual(['conflict', 'ok']);
      const okResult = first.status === 'ok' ? first : second;
      const conflictResult = first.status === 'ok' ? second : first;
      expect(conflictResult).toMatchObject({ status: 'conflict', reason: 'digest_mismatch' });

      // Exactly one write landed on disk, and it is the one the OK response reported.
      const finalText = await readFile(filePath, 'utf8');
      expect(['first\n', 'second\n']).toContain(finalText);
      expect(okResult.status === 'ok' ? okResult.digest : null).toBe(digestText(finalText));
    });
  });

  it('denies saves when the workspace resolver rejects write access', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'hello.ts');
      await writeFile(filePath, 'old\n');
      const service = new CodeCollabV2Service({
        resolveWorkspace: async (_sessionId, options) =>
          options?.access === 'write'
            ? {
                ok: false,
                code: 'permission_denied',
                message: 'Code Collab write access is denied for this user.',
              }
            : {
                ok: true,
                ownerSessionId: SESSION_ID,
                workspaceRoot,
              },
      });
      const opened = await service.openText({ sessionId: SESSION_ID, path: 'hello.ts' });

      await expect(
        service.saveText({
          sessionId: SESSION_ID,
          requestedByUserId: 'user-2',
          path: 'hello.ts',
          baseDigest: opened.digest,
          text: {
            encoding: 'plain',
            text: 'new\n',
            rawBytes: Buffer.byteLength('new\n'),
          },
        })
      ).rejects.toMatchObject({
        code: 'permission_denied',
      });
      expect(await readFile(filePath, 'utf8')).toBe('old\n');
    });
  });

  it('returns a save conflict with current disk text when the base digest is stale', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'hello.ts');
      await writeFile(filePath, 'base\n');
      const service = new CodeCollabV2Service({ resolveWorkspace: makeResolver(workspaceRoot) });
      const opened = await service.openText({ sessionId: SESSION_ID, path: 'hello.ts' });
      await writeFile(filePath, 'disk\n');

      const conflict = await service.saveText({
        sessionId: SESSION_ID,
        requestedByUserId: 'user-1',
        path: 'hello.ts',
        baseDigest: opened.digest,
        text: {
          encoding: 'plain',
          text: 'mine\n',
          rawBytes: Buffer.byteLength('mine\n'),
        },
      });

      expect(conflict).toEqual({
        status: 'conflict',
        reason: 'digest_mismatch',
        path: 'hello.ts',
        baseDigest: opened.digest,
        diskDigest: digestText('disk\n'),
        diskText: {
          encoding: 'plain',
          text: 'disk\n',
          rawBytes: Buffer.byteLength('disk\n'),
        },
      });
      expect(await readFile(filePath, 'utf8')).toBe('disk\n');
    });
  });

  it('rejects binary-looking files and workspace escapes', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, 'binary.bin'), Buffer.from([0x61, 0, 0x62]));
      const service = new CodeCollabV2Service({ resolveWorkspace: makeResolver(workspaceRoot) });

      await expect(
        service.openText({ sessionId: SESSION_ID, path: 'binary.bin' })
      ).rejects.toBeInstanceOf(CodeCollabV2ServiceError);
      await expect(
        service.openText({ sessionId: SESSION_ID, path: 'binary.bin' })
      ).rejects.toMatchObject({
        code: 'unsupported_binary',
      });
      await expect(
        service.openText({ sessionId: SESSION_ID, path: '../outside.txt' })
      ).rejects.toMatchObject({
        code: 'invalid_path',
      });
    });
  });

  it('opens workspace-contained absolute paths and rejects absolute paths outside the workspace', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const nestedDirectory = path.join(workspaceRoot, 'src');
      const absoluteFilePath = path.join(nestedDirectory, 'inside.ts');
      const dottedFilePath = path.join(workspaceRoot, '..inside.ts');
      await mkdir(nestedDirectory);
      await writeFile(absoluteFilePath, 'export const inside = true;\n');
      await writeFile(dottedFilePath, 'export const dotted = true;\n');
      const service = new CodeCollabV2Service({ resolveWorkspace: makeResolver(workspaceRoot) });

      const opened = await service.openText({
        sessionId: SESSION_ID,
        path: absoluteFilePath,
      });
      const dotted = await service.openText({
        sessionId: SESSION_ID,
        path: dottedFilePath,
      });

      expect(opened.path).toBe('src/inside.ts');
      expect(dotted.path).toBe('..inside.ts');
      await expect(
        service.openText({
          sessionId: SESSION_ID,
          path: path.join(`${workspaceRoot}-outside`, 'inside.ts'),
        })
      ).rejects.toMatchObject({
        code: 'invalid_path',
      });
    });
  });

  it('reports path conflicts instead of choosing between case-equivalent files', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, 'Readme.md'), 'upper\n');
      await writeFile(path.join(workspaceRoot, 'README.md'), 'caps\n');
      const rootEntries = new Set(await readdir(workspaceRoot));
      if (!rootEntries.has('Readme.md') || !rootEntries.has('README.md')) {
        expect(await readFile(path.join(workspaceRoot, 'Readme.md'), 'utf8')).toBe('caps\n');
        return;
      }
      const { published, publishFileIndex } = collectPublishedSharedStates();
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        publishFileIndex,
      });

      await expect(
        service.openText({ sessionId: SESSION_ID, path: 'Readme.md' })
      ).rejects.toMatchObject({
        code: 'path_conflict',
      });

      const saveResult = await service.saveText({
        sessionId: SESSION_ID,
        requestedByUserId: 'user-1',
        path: 'Readme.md',
        baseDigest: digestText('upper\n'),
        text: {
          encoding: 'plain',
          text: 'mine\n',
          rawBytes: Buffer.byteLength('mine\n'),
        },
      });
      expect(saveResult).toEqual({
        status: 'conflict',
        reason: 'path_conflict',
        path: 'Readme.md',
        baseDigest: digestText('upper\n'),
      });

      await service.initDirectory({ sessionId: SESSION_ID, path: '.' });
      expect(published.at(-1)?.fileTree).toMatchObject({
        'Readme.md': { kind: 'skipped', reason: 'path_conflict' },
        'README.md': { kind: 'skipped', reason: 'path_conflict' },
      });
    });
  });

  it('normalizes published Unicode paths while resolving the actual filesystem spelling', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const decomposedName = 'cafe\u0301.txt';
      const normalizedName = 'café.txt';
      await writeFile(path.join(workspaceRoot, decomposedName), 'accent\n');
      const { published, publishFileIndex } = collectPublishedSharedStates();
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        publishFileIndex,
      });

      await service.initDirectory({ sessionId: SESSION_ID, path: '.' });
      expect(published.at(-1)?.fileTree).toMatchObject({
        [normalizedName]: true,
      });

      const opened = await service.openText({ sessionId: SESSION_ID, path: normalizedName });
      expect(opened).toMatchObject({
        status: 'ok',
        path: normalizedName,
        digest: digestText('accent\n'),
      });
    });
  });

  it('does not synthesize non-Git All Changes from a local snapshot baseline', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'notes.txt');
      await writeFile(filePath, 'one\n');
      const { published, publishFileIndex } = collectPublishedSharedStates();
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        publishFileIndex,
      });

      await service.initDirectory({ sessionId: SESSION_ID, path: '.' });
      expect(published.at(-1)?.allChanges).toEqual({});

      const opened = await service.openText({ sessionId: SESSION_ID, path: 'notes.txt' });
      await service.saveText({
        sessionId: SESSION_ID,
        requestedByUserId: 'user-1',
        path: 'notes.txt',
        baseDigest: opened.digest,
        text: {
          encoding: 'plain',
          text: 'one\ntwo\n',
          rawBytes: Buffer.byteLength('one\ntwo\n'),
        },
      });

      expect(published.at(-1)?.allChanges).toEqual({});
    });
  });

  it('does not report different oversized non-Git snapshots as unchanged', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'large.txt');
      const oldText = 'a'.repeat(64);
      const newText = 'b'.repeat(64);
      await writeFile(filePath, newText);
      const diffStore = new CodeCollabV2DiffStore('workspace-v2', {
        dbPath: path.join(workspaceRoot, 'diff-store.sqlite3'),
      });
      try {
        await diffStore.recordTurnDiffs({
          workspaceRoot,
          ownerSessionId: SESSION_ID,
          turnId: 'turn-large',
          capturedAtMs: Date.now(),
          events: [{ path: filePath, oldText, newText }],
        });
        const service = new CodeCollabV2Service({
          resolveWorkspace: makeResolver(workspaceRoot),
          diffStore,
          maxRawTextBytes: 16,
        });

        const diff = await service.openCurrentDiff({
          sessionId: SESSION_ID,
          path: 'large.txt',
        });

        expect(diff).toMatchObject({
          status: 'ok',
          oldSnapshot: { kind: 'too_large' },
          newSnapshot: { kind: 'too_large' },
        });
      } finally {
        await diffStore.close();
      }
    });
  });

  it('keeps multi-turn local ACP evidence aligned for turn diffs and current All Changes', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'target.txt');
      await writeFile(filePath, 'alpha turn one\nbeta turn two\ngamma turn three\n');
      const diffStore = new CodeCollabV2DiffStore('workspace-v2', {
        dbPath: path.join(workspaceRoot, 'diff-store.sqlite3'),
      });
      const { published, publishFileIndex } = collectPublishedSharedStates();
      try {
        const capturedAtMs = Date.now();
        const turnOneFileDiff = await diffStore.recordTurnDiffs({
          workspaceRoot,
          ownerSessionId: SESSION_ID,
          turnId: 'turn-1',
          capturedAtMs,
          events: [
            {
              path: filePath,
              oldText: 'alpha old line\nbeta old line\ngamma old line\n',
              newText: 'alpha turn one\nbeta old line\ngamma old line\n',
            },
          ],
        });
        const turnTwoFileDiff = await diffStore.recordTurnDiffs({
          workspaceRoot,
          ownerSessionId: SESSION_ID,
          turnId: 'turn-2',
          capturedAtMs: capturedAtMs + 1,
          events: [
            {
              path: filePath,
              oldText: 'alpha turn one\nbeta old line\ngamma old line\n',
              newText: 'alpha turn one\nbeta turn two\ngamma old line\n',
            },
          ],
        });
        const turnThreeFileDiff = await diffStore.recordTurnDiffs({
          workspaceRoot,
          ownerSessionId: SESSION_ID,
          turnId: 'turn-3',
          capturedAtMs: capturedAtMs + 2,
          events: [
            {
              path: filePath,
              oldText: 'alpha turn one\nbeta turn two\ngamma old line\n',
              newText: 'alpha turn one\nbeta turn two\ngamma turn three\n',
            },
          ],
        });

        expect(turnOneFileDiff).toEqual([{ filePath: 'target.txt', add: 1, del: 1 }]);
        expect(turnTwoFileDiff).toEqual([{ filePath: 'target.txt', add: 1, del: 1 }]);
        expect(turnThreeFileDiff).toEqual([{ filePath: 'target.txt', add: 1, del: 1 }]);

        const service = new CodeCollabV2Service({
          resolveWorkspace: makeResolver(workspaceRoot),
          diffStore,
          publishFileIndex,
        });

        await service.initDirectory({ sessionId: SESSION_ID, path: '.' });
        expect(published.at(-1)?.allChanges).toEqual({
          'target.txt': { diff: [3, 3] },
        });

        const currentDiff = await service.openCurrentDiff({
          sessionId: SESSION_ID,
          path: 'target.txt',
        });
        expect(currentDiff.status).toBe('ok');
        if (currentDiff.status === 'ok') {
          expect(currentDiff.oldSnapshot).toMatchObject({
            kind: 'text',
            text: { encoding: 'plain', text: 'alpha old line\nbeta old line\ngamma old line\n' },
          });
          expect(currentDiff.newSnapshot).toMatchObject({
            kind: 'text',
            text: { encoding: 'plain', text: 'alpha turn one\nbeta turn two\ngamma turn three\n' },
          });
          expect(currentDiff.add).toBe(3);
          expect(currentDiff.del).toBe(3);
        }

        const turnDiffExpectations = [
          {
            turnId: 'turn-1',
            oldText: 'alpha old line\nbeta old line\ngamma old line\n',
            newText: 'alpha turn one\nbeta old line\ngamma old line\n',
          },
          {
            turnId: 'turn-2',
            oldText: 'alpha turn one\nbeta old line\ngamma old line\n',
            newText: 'alpha turn one\nbeta turn two\ngamma old line\n',
          },
          {
            turnId: 'turn-3',
            oldText: 'alpha turn one\nbeta turn two\ngamma old line\n',
            newText: 'alpha turn one\nbeta turn two\ngamma turn three\n',
          },
        ] as const;

        for (const expectation of turnDiffExpectations) {
          const turnDiff = await service.openTurnDiff({
            sessionId: SESSION_ID,
            turnId: expectation.turnId,
            path: 'target.txt',
          });
          expect(turnDiff.status).toBe('ok');
          if (turnDiff.status === 'ok') {
            expect(turnDiff.oldSnapshot).toMatchObject({
              kind: 'text',
              text: { encoding: 'plain', text: expectation.oldText },
            });
            expect(turnDiff.newSnapshot).toMatchObject({
              kind: 'text',
              text: { encoding: 'plain', text: expectation.newText },
            });
            expect(turnDiff.add).toBe(1);
            expect(turnDiff.del).toBe(1);
          }
        }
      } finally {
        await diffStore.close();
      }
    });
  });

  it('refreshes a qualified owner base against the advancing remote and replaces pre-merge changes', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const git = async (...args: string[]) =>
        (
          await execFileAsync('git', ['-c', 'commit.gpgsign=false', ...args], {
            cwd: workspaceRoot,
          })
        ).stdout.trim();
      await git('-c', 'init.defaultBranch=main', 'init');
      await git('config', 'user.email', 'test@example.com');
      await git('config', 'user.name', 'Test User');
      await writeFile(path.join(workspaceRoot, 'sdk.txt'), 'old SDK\n');
      await git('add', '.');
      await git('commit', '-m', 'stale local main');
      await git('checkout', '-b', 'feature');
      await writeFile(path.join(workspaceRoot, 'sdk.txt'), 'new SDK\n');
      await git('add', '.');
      await git('commit', '-m', 'upstream SDK update');
      const upstream = await git('rev-parse', 'HEAD');
      await git('update-ref', 'refs/remotes/origin/main', upstream);
      await writeFile(path.join(workspaceRoot, 'avatar.txt'), 'avatar fix\n');
      await git('add', '.');
      await git('commit', '-m', 'avatar fix');
      const head = await git('rev-parse', 'HEAD');
      const { published, publishFileIndex } = collectPublishedSharedStates();
      const service = new CodeCollabV2Service({
        resolveWorkspace: async () => ({
          ok: true,
          ownerSessionId: SESSION_ID,
          workspaceRoot,
          allChangesBaseBranch: 'refs/heads/main',
        }),
        publishFileIndex,
      });
      try {
        for (const preferredBaseBranch of ['main', 'refs/heads/main', 'refs/remotes/origin/main']) {
          const stats = await getGitDiffStats((args) => git(...args), { preferredBaseBranch });
          expect(stats).toMatchObject({
            mergeBase: upstream,
            baseDiffStats: { allChange: { add: 1, del: 0 } },
          });
        }
        await service.refreshSharedState({ sessionId: SESSION_ID });
        expect(published.at(-1)?.allChanges).toEqual({ 'avatar.txt': { diff: [1, 0] } });
        const preMergeProjection = published.at(-1)!;
        const diff = await service.openAllChangesDiff({ sessionId: SESSION_ID });
        expect(diff).toMatchObject({ status: 'ok', base: upstream });
        if (diff.status !== 'ok') throw new Error('Expected current diff');
        expect(diff.entries.map((entry) => entry.path)).toEqual(['avatar.txt']);
        expect(
          await service.openCurrentDiff({ sessionId: SESSION_ID, path: 'sdk.txt' })
        ).toMatchObject({ status: 'unavailable', reason: 'not_changed' });

        // A squash-merged PR has matching upstream content but a different head:
        // merge-base still excludes SDK changes without erasing the PR's history.
        const squash = await git(
          'commit-tree',
          await git('rev-parse', 'HEAD^{tree}'),
          '-p',
          upstream,
          '-m',
          'squashed avatar'
        );
        await git('update-ref', 'refs/remotes/origin/main', squash);
        await service.refreshSharedState({ sessionId: SESSION_ID });
        expect(published.at(-1)?.allChanges).toEqual({ 'avatar.txt': { diff: [1, 0] } });
        expect(await service.openAllChangesDiff({ sessionId: SESSION_ID })).toMatchObject({
          status: 'ok',
          base: upstream,
        });

        // A merged head advances the compare base without changing any disk file.
        await git('update-ref', 'refs/remotes/origin/main', head);
        await service.refreshSharedState({ sessionId: SESSION_ID });
        expect(published.at(-1)?.allChanges).toEqual({});
        expect(published.at(-1)?.allChangesDiffStats).toEqual({ allChange: { add: 0, del: 0 } });
        expect(
          await getGitDiffStats((args) => git(...args), { preferredBaseBranch: 'refs/heads/main' })
        ).toMatchObject({ mergeBase: head, baseDiffStats: { allChange: { add: 0, del: 0 } } });
        expect(await service.openAllChangesDiff({ sessionId: SESSION_ID })).toMatchObject({
          status: 'ok',
          base: head,
          entries: [],
        });
        // A new service/page activation repairs the old pre-merge projection too.
        published.push(preMergeProjection);
        const restarted = new CodeCollabV2Service({
          resolveWorkspace: async () => ({
            ok: true,
            ownerSessionId: SESSION_ID,
            workspaceRoot,
            allChangesBaseBranch: 'refs/heads/main',
          }),
          publishFileIndex,
        });
        try {
          await restarted.initDirectory({ sessionId: SESSION_ID, path: '.' });
          expect(published.at(-1)?.allChanges).toEqual({});
        } finally {
          restarted.dispose();
        }
      } finally {
        service.dispose();
      }
    });
  });

  it('compares an unrecorded base against the remote default branch, not an abandoned main', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const git = async (...args: string[]) =>
        (
          await execFileAsync('git', ['-c', 'commit.gpgsign=false', ...args], {
            cwd: workspaceRoot,
          })
        ).stdout.trim();
      await git('-c', 'init.defaultBranch=main', 'init');
      await git('config', 'user.email', 'test@example.com');
      await git('config', 'user.name', 'Test User');
      await writeFile(path.join(workspaceRoot, 'history.txt'), 'abandoned main\n');
      await git('add', '.');
      await git('commit', '-m', 'abandoned main');
      const abandonedMain = await git('rev-parse', 'HEAD');
      await git('update-ref', 'refs/remotes/origin/main', abandonedMain);
      await git('checkout', '-b', 'develop');
      await writeFile(path.join(workspaceRoot, 'history.txt'), 'years of develop\n');
      await git('add', '.');
      await git('commit', '-m', 'develop history');
      const develop = await git('rev-parse', 'HEAD');
      await git('update-ref', 'refs/remotes/origin/develop', develop);
      await git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
      await writeFile(path.join(workspaceRoot, 'session.txt'), 'session work\n');
      const { published, publishFileIndex } = collectPublishedSharedStates();
      // A direct local checkout records no base branch for its Session.
      const service = new CodeCollabV2Service({
        resolveWorkspace: async () => ({ ok: true, ownerSessionId: SESSION_ID, workspaceRoot }),
        publishFileIndex,
      });
      try {
        await service.refreshSharedState({ sessionId: SESSION_ID });
        expect(published.at(-1)?.allChanges).toEqual({ 'session.txt': { diff: [1, 0] } });
        expect(published.at(-1)?.allChangesDiffStats).toEqual({ allChange: { add: 1, del: 0 } });
        expect(await service.openAllChangesDiff({ sessionId: SESSION_ID })).toMatchObject({
          status: 'ok',
          base: develop,
        });
        expect(await getGitDiffStats((args) => git(...args))).toMatchObject({
          baseRef: 'origin/HEAD',
          mergeBase: develop,
          baseDiffStats: { allChange: { add: 0, del: 0 } },
        });

        // A recorded base stays authoritative, even when it names the abandoned branch.
        expect(
          await getGitDiffStats((args) => git(...args), { preferredBaseBranch: 'main' })
        ).toMatchObject({
          mergeBase: abandonedMain,
          baseDiffStats: { allChange: { add: 1, del: 1 } },
        });

        // Without a remote default, the conventional names remain the fallback.
        await git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
        await service.refreshSharedState({ sessionId: SESSION_ID });
        expect(published.at(-1)?.allChanges).toEqual({
          'history.txt': { diff: [1, 1] },
          'session.txt': { diff: [1, 0] },
        });
      } finally {
        service.dispose();
      }
    });
  });

  it('returns a local snapshot before asynchronously reconciling Flock state', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await mkdir(path.join(workspaceRoot, 'src'));
      await writeFile(path.join(workspaceRoot, 'src', 'index.ts'), 'export const value = 1;\n');
      const { published, publishFileIndex: collectPublication } = collectPublishedSharedStates();
      let startPublication: (() => void) | undefined;
      const publicationStarted = new Promise<void>((resolve) => {
        startPublication = resolve;
      });
      let releasePublication: (() => void) | undefined;
      const publicationReleased = new Promise<void>((resolve) => {
        releasePublication = resolve;
      });
      const publishFileIndex = vi.fn(async (state: CodeCollabV2FileIndexPublication) => {
        startPublication?.();
        await publicationReleased;
        await collectPublication(state);
      });
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        publishFileIndex,
      });

      const snapshot = await service.getFileIndex({ sessionId: SESSION_ID });

      expect(snapshot).toMatchObject({
        status: 'ok',
        ownerSessionId: SESSION_ID,
      });
      expect(snapshot.fileIndex).toMatchObject({
        'src/index.ts': true,
      });
      // The response resolves while Flock publication is still deliberately blocked.
      expect(published).toEqual([]);
      await publicationStarted;
      expect(published).toEqual([]);

      releasePublication?.();
      await vi.waitFor(() => {
        expect(published.at(-1)?.fileIndex).toEqual(snapshot.fileIndex);
      });
    });
  });

  it('only initializes directories that are currently published as lazy', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await mkdir(path.join(workspaceRoot, 'node_modules', 'pkg'), { recursive: true });
      await writeFile(
        path.join(workspaceRoot, 'node_modules', 'pkg', 'index.js'),
        'module.exports = 1;\n'
      );

      const { published, publishFileIndex } = collectPublishedSharedStates();
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        publishFileIndex,
      });

      await service.initDirectory({ sessionId: SESSION_ID, path: '.' });
      expect(published.at(-1)?.fileTree).not.toHaveProperty('node_modules');

      await expect(
        service.initDirectory({ sessionId: SESSION_ID, path: 'node_modules' })
      ).rejects.toMatchObject({
        code: 'unsupported_skipped',
        options: { path: 'node_modules' },
      });
      expect(published.at(-1)?.fileTree).not.toHaveProperty('node_modules/pkg');
    });
  });

  it('refreshes Git-backed file index state after a turn', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await execFileAsync('git', ['-c', 'init.defaultBranch=main', 'init'], { cwd: workspaceRoot });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
        cwd: workspaceRoot,
      });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: workspaceRoot });
      await mkdir(path.join(workspaceRoot, 'src'));
      await mkdir(path.join(workspaceRoot, 'untouched'));
      await writeFile(path.join(workspaceRoot, 'tracked.txt'), 'tracked\n');
      await execFileAsync('git', ['add', 'tracked.txt'], { cwd: workspaceRoot });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: workspaceRoot });
      await writeFile(path.join(workspaceRoot, 'untouched', 'stale.txt'), 'stale\n');

      const { published, publishFileIndex } = collectPublishedSharedStates();
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        publishFileIndex,
      });

      await service.initDirectory({ sessionId: SESSION_ID, path: '.' });
      expect(published.at(-1)?.fileTree).toMatchObject({
        'untouched/stale.txt': true,
      });

      await rm(path.join(workspaceRoot, 'untouched', 'stale.txt'));
      await writeFile(path.join(workspaceRoot, 'src', 'new.ts'), 'new\n');
      await service.refreshSharedStateAfterTurn({ sessionId: SESSION_ID });

      expect(published.at(-1)?.fileTree).toMatchObject({
        'src/new.ts': true,
      });
      expect(published.at(-1)?.fileTree).not.toHaveProperty('untouched/stale.txt');
      expect(published.at(-1)?.allChanges).toMatchObject({
        'src/new.ts': { diff: [1, 0] },
      });
      expect(published.at(-1)).toMatchObject({
        allChangesDiffStats: { allChange: { add: 1, del: 0 } },
        persistAllChangesDiffStats: true,
      });
    });
  });

  it('publishes deleted tracked files in All Changes with a deletion marker', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await execFileAsync('git', ['-c', 'init.defaultBranch=main', 'init'], { cwd: workspaceRoot });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
        cwd: workspaceRoot,
      });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: workspaceRoot });
      const deletedPath = path.join(workspaceRoot, 'delete-me.txt');
      await writeFile(deletedPath, 'one\ntwo\n');
      await execFileAsync('git', ['add', 'delete-me.txt'], { cwd: workspaceRoot });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: workspaceRoot });
      await rm(deletedPath);

      const { published, publishFileIndex } = collectPublishedSharedStates();
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        publishFileIndex,
      });

      await service.refreshSharedState({ sessionId: SESSION_ID });

      expect(published.at(-1)?.fileTree).not.toHaveProperty('delete-me.txt');
      expect(published.at(-1)?.allChanges).toMatchObject({
        'delete-me.txt': { diff: [0, 2], del: true },
      });
      expect(published.at(-1)?.fileIndex).toMatchObject({
        'delete-me.txt': { kind: 'deleted', change: { diff: [0, 2], del: true } },
      });
    });
  });

  it('returns a save conflict (not an error) when the disk content became binary', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'hello.ts');
      await writeFile(filePath, 'base\n');
      const service = new CodeCollabV2Service({ resolveWorkspace: makeResolver(workspaceRoot) });
      const opened = await service.openText({ sessionId: SESSION_ID, path: 'hello.ts' });

      const binaryDisk = Buffer.from([0x61, 0x00, 0x62, 0x00]);
      await writeFile(filePath, binaryDisk);

      const conflict = await service.saveText({
        sessionId: SESSION_ID,
        requestedByUserId: 'user-1',
        path: 'hello.ts',
        baseDigest: opened.digest,
        text: {
          encoding: 'plain',
          text: 'mine\n',
          rawBytes: Buffer.byteLength('mine\n'),
        },
      });

      expect(conflict).toEqual({
        status: 'conflict',
        reason: 'digest_mismatch',
        path: 'hello.ts',
        baseDigest: opened.digest,
        diskDigest: digestRaw(binaryDisk),
        diskText: undefined,
      });
      // The user's unsaved text must not overwrite the changed disk content.
      expect(new Uint8Array(await readFile(filePath))).toEqual(new Uint8Array(binaryDisk));
    });
  });

  it('returns a save conflict with a streamed disk digest when disk grew beyond the text limit', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'hello.ts');
      await writeFile(filePath, 'base\n');
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        maxRawTextBytes: 16,
      });
      const opened = await service.openText({ sessionId: SESSION_ID, path: 'hello.ts' });

      const grownDisk = `${'y'.repeat(64)}\n`;
      await writeFile(filePath, grownDisk);

      const conflict = await service.saveText({
        sessionId: SESSION_ID,
        requestedByUserId: 'user-1',
        path: 'hello.ts',
        baseDigest: opened.digest,
        text: {
          encoding: 'plain',
          text: 'mine\n',
          rawBytes: Buffer.byteLength('mine\n'),
        },
      });

      expect(conflict).toEqual({
        status: 'conflict',
        reason: 'digest_mismatch',
        path: 'hello.ts',
        baseDigest: opened.digest,
        diskDigest: digestText(grownDisk),
      });
      expect(await readFile(filePath, 'utf8')).toBe(grownDisk);
    });
  });
});

async function initGitRepoWithCommit(workspaceRoot: string): Promise<void> {
  await execFileAsync('git', ['-c', 'init.defaultBranch=main', 'init'], { cwd: workspaceRoot });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspaceRoot });
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: workspaceRoot });
}

async function gitCommitAll(workspaceRoot: string, message: string): Promise<void> {
  await execFileAsync('git', ['add', '-A'], { cwd: workspaceRoot });
  await execFileAsync('git', ['commit', '-m', message], { cwd: workspaceRoot });
}

const plainSnapshotText = (snapshot: { kind: string }): string | undefined => {
  if (snapshot.kind !== 'text') return undefined;
  const payload = (snapshot as { text: { encoding: string; text?: string } }).text;
  return payload.encoding === 'plain' ? payload.text : undefined;
};

describe('CodeCollabV2Service openAllChangesDiff', () => {
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
  const gitText = async (workspaceRoot: string, ...args: string[]): Promise<string> =>
    (await execFileAsync('git', args, { cwd: workspaceRoot })).stdout.trim();

  const entryPaths = (
    result: Awaited<ReturnType<CodeCollabV2Service['openAllChangesDiff']>>
  ): string[] => {
    if (result.status !== 'ok') throw new Error(`Expected ok, received ${result.status}`);
    return result.entries.map((entry) => entry.path).sort();
  };

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
