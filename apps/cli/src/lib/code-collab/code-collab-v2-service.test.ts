import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import {
  codeCollabFileIndexToSharedState,
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

describe('CodeCollabV2Service text RPC boundary', () => {
  it('opens text files with a sha256 digest and plain payload', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, 'hello.ts'), 'const value = 1;\n');
      const service = new CodeCollabV2Service({ resolveWorkspace: makeResolver(workspaceRoot) });

      const result = await service.openText({
        sessionId: SESSION_ID,
        path: 'hello.ts',
      });

      expect(result).toMatchObject({
        status: 'ok',
        path: 'hello.ts',
        digest: digestText('const value = 1;\n'),
        text: {
          encoding: 'plain',
          text: 'const value = 1;\n',
          rawBytes: Buffer.byteLength('const value = 1;\n'),
        },
        format: {
          encoding: 'utf8',
          eol: 'lf',
        },
      });
    });
  });

  it('refreshes by digest without returning text when already current', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, 'hello.ts'), 'old\n');
      const service = new CodeCollabV2Service({ resolveWorkspace: makeResolver(workspaceRoot) });
      const opened = await service.openText({ sessionId: SESSION_ID, path: 'hello.ts' });

      const same = await service.refreshText({
        sessionId: SESSION_ID,
        path: 'hello.ts',
        digest: opened.digest,
      });
      expect(same).toEqual({
        status: 'up_to_date',
        path: 'hello.ts',
        digest: opened.digest,
      });

      await writeFile(path.join(workspaceRoot, 'hello.ts'), 'new\n');
      const updated = await service.refreshText({
        sessionId: SESSION_ID,
        path: 'hello.ts',
        digest: opened.digest,
      });

      expect(updated.status).toBe('updated');
      if (updated.status === 'updated') {
        expect(updated.digest).toBe(digestText('new\n'));
        expect(updated.text).toEqual({
          encoding: 'plain',
          text: 'new\n',
          rawBytes: Buffer.byteLength('new\n'),
        });
      }
    });
  });

  it('saves only when the base digest still matches disk', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'hello.ts');
      await writeFile(filePath, 'old\n');
      const service = new CodeCollabV2Service({ resolveWorkspace: makeResolver(workspaceRoot) });
      const opened = await service.openText({ sessionId: SESSION_ID, path: 'hello.ts' });

      const saved = await service.saveText({
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

      expect(saved).toEqual({
        status: 'ok',
        path: 'hello.ts',
        digest: digestText('new\n'),
        rawBytes: Buffer.byteLength('new\n'),
      });
      expect(await readFile(filePath, 'utf8')).toBe('new\n');
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
      const publishReleased = new Promise<void>((resolve) => {
        releasePublish = resolve;
      });
      let resolvePublishFinished: (() => void) | undefined;
      const publishFinished = new Promise<void>((resolve) => {
        resolvePublishFinished = resolve;
      });
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        publishFileIndex: async () => {
          resolvePublishStarted?.();
          await publishReleased;
        },
        publishFileIndexSignal: async () => resolvePublishFinished?.(),
      });
      try {
        // Use the known fixture digest so openText does not start an independent
        // reconciliation that could still hold the workspace during cleanup.
        const saved = await service.saveText({
          sessionId: SESSION_ID,
          requestedByUserId: 'user-1',
          path: 'hello.ts',
          baseDigest: digestText('old\n'),
          text: {
            encoding: 'plain',
            text: 'new\n',
            rawBytes: Buffer.byteLength('new\n'),
          },
        });
        await publishStarted;
        expect(saved).toEqual({
          status: 'ok',
          path: 'hello.ts',
          digest: digestText('new\n'),
          rawBytes: Buffer.byteLength('new\n'),
        });
        expect(await readFile(filePath, 'utf8')).toBe('new\n');
      } finally {
        releasePublish?.();
        await publishFinished;
        service.dispose();
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

  it('uses gzip-base64 for payloads above the plain text threshold', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const text = 'a'.repeat(128);
      await writeFile(path.join(workspaceRoot, 'large.txt'), text);
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        plainTextBytes: 16,
      });

      const opened = await service.openText({ sessionId: SESSION_ID, path: 'large.txt' });

      expect(opened.text.encoding).toBe('gzip-base64');
      if (opened.text.encoding === 'gzip-base64') {
        expect(opened.text.rawBytes).toBe(Buffer.byteLength(text));
        expect(opened.text.compressedBytes).toBeGreaterThan(0);
        expect(opened.text.data.length).toBeGreaterThan(0);
      }
    });
  });

  it('rejects compressed text payloads over the configured compressed limit', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, 'large.txt'), 'a'.repeat(128));
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        plainTextBytes: 16,
        maxCompressedBytes: 8,
      });

      await expect(
        service.openText({ sessionId: SESSION_ID, path: 'large.txt' })
      ).rejects.toMatchObject({
        code: 'too_large',
      });
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

  it('publishes path-keyed file tree and current All Changes state on directory init', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await execFileAsync('git', ['-c', 'init.defaultBranch=main', 'init'], { cwd: workspaceRoot });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
        cwd: workspaceRoot,
      });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: workspaceRoot });
      await writeFile(path.join(workspaceRoot, 'tracked.txt'), 'one\n');
      await execFileAsync('git', ['add', 'tracked.txt'], { cwd: workspaceRoot });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: workspaceRoot });

      await writeFile(path.join(workspaceRoot, 'tracked.txt'), 'one\ntwo\n');
      await writeFile(path.join(workspaceRoot, 'untracked.txt'), 'new\n');
      await writeFile(path.join(workspaceRoot, 'binary.bin'), Buffer.from([0x61, 0, 0x62]));
      await mkdir(path.join(workspaceRoot, 'src'));

      const { published, publishFileIndex } = collectPublishedSharedStates();
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        publishFileIndex,
      });

      const initialized = await service.initDirectory({ sessionId: SESSION_ID, path: '.' });

      expect(initialized).toMatchObject({
        status: 'ok',
        path: '.',
      });
      const latest = published.at(-1);
      expect(latest?.fileTree).toMatchObject({
        'tracked.txt': true,
        'untracked.txt': true,
        'binary.bin': true,
      });
      expect(latest?.fileTree).not.toHaveProperty('src');
      expect(latest?.allChanges).toMatchObject({
        'tracked.txt': { diff: [1, 0] },
        'untracked.txt': { diff: [1, 0] },
      });
    });
  });

  it('recursively publishes a bounded file tree during explicit directory init', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await mkdir(path.join(workspaceRoot, 'src', 'components'), { recursive: true });
      await writeFile(path.join(workspaceRoot, 'src', 'index.ts'), 'export {};\n');
      await writeFile(path.join(workspaceRoot, 'src', 'components', 'button.tsx'), 'button\n');

      const { published, publishFileIndex } = collectPublishedSharedStates();
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        publishFileIndex,
      });

      await service.initDirectory({ sessionId: SESSION_ID, path: '.' });

      expect(published.at(-1)?.fileTree).toMatchObject({
        src: { kind: 'lazy' },
        'src/components': { kind: 'lazy' },
        'src/components/button.tsx': true,
        'src/index.ts': true,
      });
    });
  });

  it('leaves deeper directories lazy when the file tree init budget is exhausted', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await mkdir(path.join(workspaceRoot, 'a', 'b', 'c'), { recursive: true });
      await writeFile(path.join(workspaceRoot, 'a', 'b', 'c', 'deep.ts'), 'deep\n');

      const { published, publishFileIndex } = collectPublishedSharedStates();
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        maxFileTreeEntries: 2,
        publishFileIndex,
      });

      await service.initDirectory({ sessionId: SESSION_ID, path: '.' });

      expect(published.at(-1)?.fileTree).toMatchObject({
        a: { kind: 'lazy' },
        'a/b': { kind: 'lazy' },
      });
      expect(published.at(-1)?.fileTree).not.toHaveProperty('a/b/c');
      expect(published.at(-1)?.fileTree).not.toHaveProperty('a/b/c/deep.ts');
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

  it('publishes non-Git All Changes from local ACP diff evidence and opens current diffs', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'notes.txt');
      await writeFile(filePath, 'one\ntwo\n');
      const diffStore = new CodeCollabV2DiffStore('workspace-v2', {
        dbPath: path.join(workspaceRoot, 'diff-store.sqlite3'),
      });
      const { published, publishFileIndex } = collectPublishedSharedStates();
      try {
        const nowMs = Date.now();
        await diffStore.recordTurnDiffs({
          workspaceRoot,
          ownerSessionId: SESSION_ID,
          turnId: 'turn-1',
          capturedAtMs: nowMs,
          events: [
            {
              path: filePath,
              oldText: 'one\n',
              newText: 'one\ntwo\n',
            },
          ],
        });
        const service = new CodeCollabV2Service({
          resolveWorkspace: makeResolver(workspaceRoot),
          diffStore,
          publishFileIndex,
        });

        await service.initDirectory({ sessionId: SESSION_ID, path: '.' });
        expect(published.at(-1)?.allChanges).toEqual({
          'notes.txt': { diff: [1, 0] },
        });

        const diff = await service.openCurrentDiff({ sessionId: SESSION_ID, path: 'notes.txt' });
        expect(diff.status).toBe('ok');
        if (diff.status === 'ok') {
          expect(diff.oldSnapshot).toMatchObject({
            kind: 'text',
            text: { encoding: 'plain', text: 'one\n' },
          });
          expect(diff.newSnapshot).toMatchObject({
            kind: 'text',
            text: { encoding: 'plain', text: 'one\ntwo\n' },
          });
          expect(diff.add).toBe(1);
          expect(diff.del).toBe(0);
        }

        const turnDiff = await service.openTurnDiff({
          sessionId: SESSION_ID,
          turnId: 'turn-1',
          path: 'notes.txt',
        });
        expect(turnDiff.status).toBe('ok');
        if (turnDiff.status === 'ok') {
          expect(turnDiff.oldSnapshot).toMatchObject({
            kind: 'text',
            text: { encoding: 'plain', text: 'one\n' },
          });
          expect(turnDiff.newSnapshot).toMatchObject({
            kind: 'text',
            text: { encoding: 'plain', text: 'one\ntwo\n' },
          });
          expect(turnDiff.add).toBe(1);
          expect(turnDiff.del).toBe(0);
        }
      } finally {
        await diffStore.close();
      }
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

  it('uses the owner session base branch for committed All Changes state', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await execFileAsync('git', ['-c', 'init.defaultBranch=main', 'init'], { cwd: workspaceRoot });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
        cwd: workspaceRoot,
      });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: workspaceRoot });
      await writeFile(path.join(workspaceRoot, 'tracked.txt'), 'one\n');
      await execFileAsync('git', ['add', 'tracked.txt'], { cwd: workspaceRoot });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: workspaceRoot });
      await execFileAsync('git', ['checkout', '-b', 'feature/code-collab'], {
        cwd: workspaceRoot,
      });
      await writeFile(path.join(workspaceRoot, 'tracked.txt'), 'one\ntwo\n');
      await execFileAsync('git', ['add', 'tracked.txt'], { cwd: workspaceRoot });
      await execFileAsync('git', ['commit', '-m', 'feature'], { cwd: workspaceRoot });

      const { published, publishFileIndex } = collectPublishedSharedStates();
      const service = new CodeCollabV2Service({
        resolveWorkspace: async () => ({
          ok: true,
          ownerSessionId: SESSION_ID,
          workspaceRoot,
          allChangesBaseBranch: 'main',
        }),
        publishFileIndex,
      });

      await service.refreshSharedState({ sessionId: SESSION_ID });

      expect(published.at(-1)?.allChanges).toMatchObject({
        'tracked.txt': { diff: [1, 0] },
      });
      expect(published.at(-1)?.allChangesDiffStats).toEqual({
        allChange: { add: 1, del: 0 },
      });
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

  it('opens current diffs against the Git All Changes base', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await execFileAsync('git', ['-c', 'init.defaultBranch=main', 'init'], { cwd: workspaceRoot });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
        cwd: workspaceRoot,
      });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: workspaceRoot });
      await writeFile(path.join(workspaceRoot, 'tracked.txt'), 'one\n');
      await execFileAsync('git', ['add', 'tracked.txt'], { cwd: workspaceRoot });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: workspaceRoot });
      await writeFile(path.join(workspaceRoot, 'tracked.txt'), 'one\ntwo\n');

      const service = new CodeCollabV2Service({ resolveWorkspace: makeResolver(workspaceRoot) });
      const diff = await service.openCurrentDiff({ sessionId: SESSION_ID, path: 'tracked.txt' });

      expect(diff.status).toBe('ok');
      if (diff.status === 'ok') {
        expect(diff.oldSnapshot).toMatchObject({
          kind: 'text',
          text: { encoding: 'plain', text: 'one\n' },
        });
        expect(diff.newSnapshot).toMatchObject({
          kind: 'text',
          text: { encoding: 'plain', text: 'one\ntwo\n' },
        });
      }
    });
  });

  it('removes stale file tree keys when refreshing shared state', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, 'keep.txt'), 'keep\n');
      await writeFile(path.join(workspaceRoot, 'remove.txt'), 'remove\n');

      const { published, publishFileIndex } = collectPublishedSharedStates();
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        publishFileIndex,
      });

      await service.initDirectory({ sessionId: SESSION_ID, path: '.' });
      await rm(path.join(workspaceRoot, 'remove.txt'));
      await service.refreshSharedState({ sessionId: SESSION_ID });

      expect(published.at(-1)?.fileTree).toMatchObject({
        'keep.txt': true,
      });
      expect(published.at(-1)?.fileTree).not.toHaveProperty('remove.txt');
    });
  });

  it('publishes the full file index after refreshes', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, 'one.txt'), 'one\n');

      const { published, publishFileIndex } = collectPublishedSharedStates();
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        publishFileIndex,
      });

      await service.initDirectory({ sessionId: SESSION_ID, path: '.' });
      expect(published.at(-1)?.fileIndex).toMatchObject({
        'one.txt': true,
      });

      await writeFile(path.join(workspaceRoot, 'two.txt'), 'two\n');
      await service.refreshSharedState({ sessionId: SESSION_ID });

      expect(published.at(-1)?.fileIndex).toMatchObject({
        'one.txt': true,
        'two.txt': true,
      });
      expect(published.at(-1)?.fileTree).toMatchObject({
        'one.txt': true,
        'two.txt': true,
      });
    });
  });

  it('keeps the latest file index visible across queued refresh publishes', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, 'one.txt'), 'one\n');

      const published: PublishedSharedState[] = [];
      let releaseFirstRefreshPublish: (() => void) | undefined;
      const firstRefreshPublishReleased = new Promise<void>((resolve) => {
        releaseFirstRefreshPublish = resolve;
      });
      let resolveFirstRefreshPublishStarted: (() => void) | undefined;
      const firstRefreshPublishStarted = new Promise<void>((resolve) => {
        resolveFirstRefreshPublishStarted = resolve;
      });
      let blockedFirstRefreshPublish = false;
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        publishFileIndex: async (state) => {
          const { fileTree, allChanges } = codeCollabFileIndexToSharedState(state.fileIndex);
          published.push({
            fileTree,
            allChanges,
            fileIndex: state.fileIndex,
            updatedAtMs: state.updatedAtMs,
          });
          if (published.length === 2 && !blockedFirstRefreshPublish) {
            blockedFirstRefreshPublish = true;
            resolveFirstRefreshPublishStarted?.();
            await firstRefreshPublishReleased;
          }
        },
      });

      await service.initDirectory({ sessionId: SESSION_ID, path: '.' });
      await writeFile(path.join(workspaceRoot, 'two.txt'), 'two\n');
      const firstRefresh = service.refreshSharedState({ sessionId: SESSION_ID });
      await firstRefreshPublishStarted;

      await writeFile(path.join(workspaceRoot, 'three.txt'), 'three\n');
      const secondRefresh = service.refreshSharedState({ sessionId: SESSION_ID });
      releaseFirstRefreshPublish?.();
      await Promise.all([firstRefresh, secondRefresh]);

      expect(published.at(-1)?.fileTree).toMatchObject({
        'one.txt': true,
        'two.txt': true,
        'three.txt': true,
      });
    });
  });

  it('skips publishing unchanged file index state', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, 'one.txt'), 'one\n');

      const { published, publishFileIndex } = collectPublishedSharedStates();
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        publishFileIndex,
      });

      await service.initDirectory({ sessionId: SESSION_ID, path: '.' });
      const publishedAfterInit = published.length;
      await service.refreshSharedState({ sessionId: SESSION_ID });
      expect(published.length).toBe(publishedAfterInit);
    });
  });

  it('releases workspace file watchers after the idle timeout', async () => {
    vi.useFakeTimers();
    try {
      await withWorkspace(async (workspaceRoot) => {
        await writeFile(path.join(workspaceRoot, 'one.txt'), 'one\n');

        const { publishFileIndex } = collectPublishedSharedStates();
        const watch = makeWorkspaceWatchCoordinator();
        const service = new CodeCollabV2Service({
          resolveWorkspace: makeResolver(workspaceRoot),
          publishFileIndex,
          workspaceWatchCoordinator: watch.coordinator,
          watchIdleTimeoutMs: 1_000,
        });

        await service.initDirectory({ sessionId: SESSION_ID, path: '.' });
        expect(activeWorkspaceWatchCount(service)).toBe(1);

        await vi.advanceTimersByTimeAsync(999);
        expect(activeWorkspaceWatchCount(service)).toBe(1);

        watch.dirty();
        await vi.advanceTimersByTimeAsync(0);
        expect(activeWorkspaceWatchCount(service)).toBe(1);

        await vi.advanceTimersByTimeAsync(1);
        expect(activeWorkspaceWatchCount(service)).toBe(0);
        expect(watch.releaseCount()).toBe(1);
        service.dispose();
      });
    } finally {
      vi.useRealTimers();
    }
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

  it('refreshes expanded directories and removes stale renamed children', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await mkdir(path.join(workspaceRoot, 'src'));
      await writeFile(path.join(workspaceRoot, 'src', 'old.ts'), 'old\n');

      const { published, publishFileIndex } = collectPublishedSharedStates();
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        publishFileIndex,
      });

      await service.initDirectory({ sessionId: SESSION_ID, path: '.' });
      await service.initDirectory({ sessionId: SESSION_ID, path: 'src' });
      expect(published.at(-1)?.fileTree).toMatchObject({
        src: { kind: 'lazy' },
        'src/old.ts': true,
      });

      await rename(
        path.join(workspaceRoot, 'src', 'old.ts'),
        path.join(workspaceRoot, 'src', 'new.ts')
      );
      await service.refreshSharedState({ sessionId: SESSION_ID });

      expect(published.at(-1)?.fileTree).toMatchObject({
        src: { kind: 'lazy' },
        'src/new.ts': true,
      });
      expect(published.at(-1)?.fileTree).not.toHaveProperty('src/old.ts');
    });
  });

  it('skips shared-state publishing when refresh content is unchanged', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, 'stable.txt'), 'stable\n');

      const { published, publishFileIndex } = collectPublishedSharedStates();
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        publishFileIndex,
      });

      await service.refreshSharedState({ sessionId: SESSION_ID });
      expect(published).toHaveLength(1);

      await service.refreshSharedState({ sessionId: SESSION_ID });
      expect(published).toHaveLength(1);

      await writeFile(path.join(workspaceRoot, 'added.txt'), 'added\n');
      await service.refreshSharedState({ sessionId: SESSION_ID });
      expect(published).toHaveLength(2);
      expect(published.at(-1)?.fileTree).toMatchObject({
        'added.txt': true,
        'stable.txt': true,
      });
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

  it('publishes a turn-end meta summary after a watcher already published the same state', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await execFileAsync('git', ['-c', 'init.defaultBranch=main', 'init'], { cwd: workspaceRoot });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
        cwd: workspaceRoot,
      });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: workspaceRoot });
      await writeFile(path.join(workspaceRoot, 'tracked.txt'), 'one\n');
      await execFileAsync('git', ['add', 'tracked.txt'], { cwd: workspaceRoot });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: workspaceRoot });

      const { published, publishFileIndex } = collectPublishedSharedStates();
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        publishFileIndex,
      });

      await service.initDirectory({ sessionId: SESSION_ID, path: '.' });
      await writeFile(path.join(workspaceRoot, 'tracked.txt'), 'one\ntwo\n');
      await service.refreshSharedState({ sessionId: SESSION_ID });
      expect(published.at(-1)).toMatchObject({
        allChangesDiffStats: { allChange: { add: 1, del: 0 } },
        persistAllChangesDiffStats: false,
      });

      const publicationCount = published.length;
      await service.refreshSharedStateAfterTurn({ sessionId: SESSION_ID });

      expect(published).toHaveLength(publicationCount + 1);
      expect(published.at(-1)).toMatchObject({
        allChangesDiffStats: { allChange: { add: 1, del: 0 } },
        persistAllChangesDiffStats: true,
      });
    });
  });

  it('publishes a file-index signal only when shared state changes', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, 'initial.txt'), 'initial\n');
      const { published, signals, publishFileIndex, publishFileIndexSignal } =
        collectPublishedSharedStates();
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        publishFileIndex,
        publishFileIndexSignal,
      });

      await service.initDirectory({ sessionId: SESSION_ID, path: '.' });
      await service.initDirectory({ sessionId: SESSION_ID, path: '.' });

      expect(published).toHaveLength(1);
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({ ownerSessionId: SESSION_ID });

      await writeFile(path.join(workspaceRoot, 'after.txt'), 'after\n');
      await service.refreshSharedState({ sessionId: SESSION_ID });

      expect(published).toHaveLength(2);
      expect(signals).toHaveLength(2);
      expect(published.at(-1)?.fileTree).toMatchObject({
        'after.txt': true,
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

  it('returns too_large on refresh when the current disk text no longer fits payload limits', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'grows.txt');
      await writeFile(filePath, 'small\n');
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        maxRawTextBytes: 16,
      });
      const opened = await service.openText({ sessionId: SESSION_ID, path: 'grows.txt' });

      await writeFile(filePath, `${'x'.repeat(64)}\n`);

      await expect(
        service.refreshText({ sessionId: SESSION_ID, path: 'grows.txt', digest: opened.digest })
      ).rejects.toMatchObject({ code: 'too_large' });
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

  it('keeps non-Git All Changes empty when no trustworthy base is available', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, 'existing.txt'), 'one\n');
      const { published, publishFileIndex } = collectPublishedSharedStates();
      const service = new CodeCollabV2Service({
        resolveWorkspace: makeResolver(workspaceRoot),
        publishFileIndex,
      });

      await writeFile(path.join(workspaceRoot, 'added-by-agent.txt'), 'a\nb\n');
      await service.refreshSharedState({ sessionId: SESSION_ID });

      expect(published.at(-1)?.allChanges).toEqual({});
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
  it('reuses non-Git snapshots computed for the changed-file list', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'notes.txt');
      await writeFile(filePath, 'one\ntwo\n');
      const diffStore = new CodeCollabV2DiffStore('workspace-v2', {
        dbPath: path.join(workspaceRoot, 'diff-store.sqlite3'),
      });
      try {
        await diffStore.recordTurnDiffs({
          workspaceRoot,
          ownerSessionId: SESSION_ID,
          turnId: 'turn-1',
          capturedAtMs: Date.now(),
          events: [{ path: filePath, oldText: 'one\n', newText: 'one\ntwo\n' }],
        });
        const earliestOld = vi.spyOn(diffStore, 'getEarliestOldSnapshot');
        const service = new CodeCollabV2Service({
          resolveWorkspace: makeResolver(workspaceRoot),
          diffStore,
        });

        const result = await service.openAllChangesDiff({ sessionId: SESSION_ID });

        expect(result.status).toBe('ok');
        if (result.status !== 'ok') return;
        expect(result.base).toBe('diff-store');
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]?.status).toBe('ok');
        expect(earliestOld).toHaveBeenCalledTimes(1);
      } finally {
        await diffStore.close();
      }
    });
  });

  it('bounds non-Git snapshot caching and defers uncached paths without rebuilding them', async () => {
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
        const earliestOld = vi.spyOn(diffStore, 'getEarliestOldSnapshot');
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
        expect(earliestOld).toHaveBeenCalledTimes(paths.length);
      } finally {
        await diffStore.close();
      }
    });
  });

  it('defers an oversized stored base before the worker reconstructs it', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const workspacePath = 'large.txt';
      const filePath = path.join(workspaceRoot, workspacePath);
      const oldText = 'a'.repeat(2 * 1024);
      const newText = `${oldText}b`;
      await writeFile(filePath, newText);
      const diffStore = new CodeCollabV2DiffStore('workspace-v2', {
        dbPath: path.join(workspaceRoot, 'diff-store.sqlite3'),
      });
      try {
        const nowMs = Date.now();
        await diffStore.recordTurnDiffs({
          workspaceRoot,
          ownerSessionId: SESSION_ID,
          turnId: 'turn-large-base',
          capturedAtMs: nowMs,
          recordedAtMs: nowMs,
          events: [{ path: filePath, oldText, newText }],
        });
        const earliestOld = vi.spyOn(diffStore, 'getEarliestOldSnapshot');
        const service = new CodeCollabV2Service({
          resolveWorkspace: makeResolver(workspaceRoot),
          diffStore,
          allChangesDiffLimits: {
            perFileMaxRawBytes: 1024,
            perFileMaxCompressedBytes: 1024,
            responseBudgetCompressedBytes: 1024,
          },
        });

        const result = await service.openAllChangesDiff({ sessionId: SESSION_ID });

        expect(result.status).toBe('ok');
        if (result.status !== 'ok') return;
        expect(result.entries).toEqual([
          expect.objectContaining({ status: 'deferred', path: workspacePath }),
        ]);
        expect(earliestOld).toHaveBeenCalledWith(
          expect.objectContaining({ path: workspacePath, maxRawBytes: 1024 })
        );
        expect(await earliestOld.mock.results[0]?.value).toEqual({
          status: 'too_large',
          rawBytes: Buffer.byteLength(oldText),
        });
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

  it('orders the focused file first', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await initGitRepoWithCommit(workspaceRoot);
      await writeFile(path.join(workspaceRoot, 'placeholder.txt'), 'x\n');
      await gitCommitAll(workspaceRoot, 'init');
      await writeFile(path.join(workspaceRoot, 'a.txt'), 'a\n');
      await writeFile(path.join(workspaceRoot, 'zzz.txt'), 'z\n');

      const service = new CodeCollabV2Service({ resolveWorkspace: makeResolver(workspaceRoot) });
      const result = await service.openAllChangesDiff({
        sessionId: SESSION_ID,
        focusPath: 'zzz.txt',
      });

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.entries[0]?.path).toBe('zzz.txt');
    });
  });
});
