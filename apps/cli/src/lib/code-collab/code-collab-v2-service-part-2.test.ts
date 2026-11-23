import { type ProjectId } from '@lody/shared';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  collectPublishedSharedStates,
  digestRaw,
  digestText,
  execFileAsync,
  gitCommitAll,
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
  CodeCollabV2ServiceError,
  type CodeCollabV2FileIndexPublication,
} from './code-collab-v2-service';

registerCodeCollabSeedCleanup();
describe('CodeCollabV2Service text RPC boundary', () => {
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
        expect(published.at(-1)?.allChangesDiffStats).toEqual({
          files: 0,
          allChange: { add: 0, del: 0 },
        });

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
        expect(published.at(-1)?.allChangesDiffStats).toEqual({
          files: 1,
          allChange: { add: 1, del: 0 },
        });
        expect(await service.openAllChangesDiff({ sessionId: SESSION_ID })).toMatchObject({
          status: 'ok',
          base: develop,
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

describe('CodeCollabV2Service openAllChangesDiff', () => {
  it('compares metadata and binary changes in the owning Project Member repository', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const memberRoot = path.join(workspaceRoot, 'repo');
      await mkdir(memberRoot);
      const git = (...args: string[]) => execFileAsync('git', args, { cwd: memberRoot });
      await initGitRepoWithCommit(memberRoot);
      await git('config', 'core.filemode', 'true');
      await writeFile(path.join(memberRoot, 'image.bin'), Buffer.from([0, 1, 2]));
      const modePath = path.join(memberRoot, 'mode.txt');
      await writeFile(modePath, 'same\n');
      await chmod(modePath, 0o644);
      await gitCommitAll(memberRoot, 'base');
      await git('checkout', '-b', 'feature');
      await chmod(modePath, 0o755);
      await writeFile(path.join(memberRoot, 'image.bin'), Buffer.from([0, 1, 3]));
      await gitCommitAll(memberRoot, 'member changes');
      const service = new CodeCollabV2Service({
        readOnly: true,
        resolveWorkspace: async () => ({
          ok: true,
          ownerSessionId: SESSION_ID,
          workspaceRoot,
          projectRun: {
            id: 'synthetic-project' as ProjectId,
            name: 'Synthetic project',
            root: workspaceRoot,
            members: {
              repo: {
                o: 0,
                src: { kind: 'github', repoFullName: 'example/synthetic' },
                placement: { kind: 'root', dir: 'repo' },
                path: 'repo',
                base: 'main',
              },
            },
          },
        }),
      });
      try {
        const batch = await service.openAllChangesDiff({ sessionId: SESSION_ID });
        if (batch.status !== 'ok') throw new Error('Expected a Project diff batch.');
        expect(batch.entries.map((entry) => [entry.path, entry.status]).sort()).toEqual([
          ['repo/image.bin', 'ok'],
          ['repo/mode.txt', 'ok'],
        ]);
        for (const filePath of ['repo/image.bin', 'repo/mode.txt']) {
          expect(
            await service.openCurrentDiff({ sessionId: SESSION_ID, path: filePath })
          ).toMatchObject({ status: 'ok' });
        }
        const manifest = await service.openDiffManifest({ sessionId: SESSION_ID });
        if (manifest.status !== 'ok') throw new Error('Expected a Project manifest.');
        expect(manifest.entries.map((entry) => [entry.path, entry.status]).sort()).toEqual([
          ['repo/image.bin', 'binary'],
          ['repo/mode.txt', 'ok'],
        ]);
      } finally {
        await service.dispose();
      }
    });
  });

  it('retains binary replacements and mode-only changes against the selected Git base', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const git = (...args: string[]) => execFileAsync('git', args, { cwd: workspaceRoot });
      await initGitRepoWithCommit(workspaceRoot);
      await git('config', 'core.filemode', 'true');
      await writeFile(path.join(workspaceRoot, 'image.bin'), Buffer.from([0, 1, 2]));
      const modePath = path.join(workspaceRoot, 'mode[1].txt');
      await writeFile(modePath, 'same\n');
      await chmod(modePath, 0o644);
      await gitCommitAll(workspaceRoot, 'base');
      await git('checkout', '-b', 'feature');
      await writeFile(path.join(workspaceRoot, 'image.bin'), Buffer.from([0, 1, 3]));
      await chmod(modePath, 0o755);
      await git('add', '--', 'mode[1].txt');

      const service = new CodeCollabV2Service({
        readOnly: true,
        resolveWorkspace: makeResolver(workspaceRoot),
      });
      const expectChanges = async (scope: 'branch' | 'uncommitted') => {
        const batch = await service.openAllChangesDiff({ sessionId: SESSION_ID, scope });
        expect(batch).toMatchObject({ status: 'ok', truncated: false });
        if (batch.status !== 'ok') throw new Error('Expected a Git diff batch.');
        expect(batch.entries.map((entry) => entry.path).sort()).toEqual([
          'image.bin',
          'mode[1].txt',
        ]);
        expect(batch.entries.find((entry) => entry.path === 'image.bin')).toMatchObject({
          status: 'ok',
          oldSnapshot: { kind: 'binary' },
          newSnapshot: { kind: 'binary' },
        });
        expect(batch.entries.find((entry) => entry.path === 'mode[1].txt')).toMatchObject({
          status: 'ok',
          add: 0,
          del: 0,
        });
        expect(
          await service.openCurrentDiff({ sessionId: SESSION_ID, path: 'image.bin', scope })
        ).toMatchObject({ status: 'ok', oldSnapshot: { kind: 'binary' } });
        const mode = await service.openCurrentDiff({
          sessionId: SESSION_ID,
          path: 'mode[1].txt',
          scope,
        });
        expect(mode).toMatchObject({ status: 'ok', add: 0, del: 0 });
        if (mode.status !== 'ok') throw new Error('Expected a mode-only diff.');
        expect(plainSnapshotText(mode.oldSnapshot)).toBe('same\n');
        expect(plainSnapshotText(mode.newSnapshot)).toBe('same\n');
        const manifest = await service.openDiffManifest({ sessionId: SESSION_ID, scope });
        if (manifest.status !== 'ok') throw new Error('Expected a Git manifest.');
        expect(manifest.entries.find((entry) => entry.path === 'image.bin')?.status).toBe('binary');
        expect(manifest.entries.find((entry) => entry.path === 'mode[1].txt')).toMatchObject({
          status: 'ok',
          add: 0,
          del: 0,
        });
      };
      try {
        await expectChanges('branch');
        await expectChanges('uncommitted');
        await gitCommitAll(workspaceRoot, 'commit binary and mode changes');
        await expectChanges('branch');
        expect(
          await service.openAllChangesDiff({ sessionId: SESSION_ID, scope: 'uncommitted' })
        ).toMatchObject({ status: 'ok', entries: [] });
        for (const filePath of ['image.bin', 'mode[1].txt']) {
          expect(
            await service.openCurrentDiff({
              sessionId: SESSION_ID,
              path: filePath,
              scope: 'uncommitted',
            })
          ).toMatchObject({ status: 'unavailable', reason: 'not_changed' });
        }

        await git('restore', '--source=main', '--worktree', '--', 'image.bin', 'mode[1].txt');
        expect(await service.openAllChangesDiff({ sessionId: SESSION_ID })).toMatchObject({
          status: 'ok',
          entries: [],
        });
        expect(await service.openDiffManifest({ sessionId: SESSION_ID })).toMatchObject({
          status: 'ok',
          entries: [],
        });
        expect(
          await service.openCurrentDiff({ sessionId: SESSION_ID, path: 'image.bin' })
        ).toMatchObject({ status: 'unavailable', reason: 'not_changed' });
        await expectChanges('uncommitted');
      } finally {
        await service.dispose();
      }
    });
  });
});
