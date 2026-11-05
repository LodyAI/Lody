import { createHash, webcrypto } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { gzipSync } from 'node:zlib';
import { IDBFactory } from 'fake-indexeddb';
import { DiffBlobCache, DIFF_BLOB_CACHE_DB } from '../src/lib/diff-blob-cache';
import { readDiffBlob } from '../src/lib/diff-blob-client';
import { hydratePartialDiff } from '@pierre/diffs';
import type { CodeCollabDiffManifestEntry, CodeCollabDiffBlobKey } from '@lody/shared';
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type {
  CodeCollabV2FileDigest,
  CodeCollabV2OpenTextOk,
  CodeCollabV2RefreshTextResponse,
  CodeCollabV2SaveTextResponse,
  FilePreviewV3Ok,
  FilePreviewV3Response,
  SessionId,
} from '@lody/shared';
import {
  CodeCollabSessionFileProvider,
  createCodeCollabSessionFileProviderTextState,
  type CodeCollabSessionFileProviderRuntime,
} from '../src/lib/code-collab-session-file-provider';
import { SaveTextConflictError } from '../src/lib/code-collab-save-errors';

const SESSION_ID = 'session-v2' as SessionId;
const DIGEST_1 = `sha256:${'1'.repeat(64)}` as CodeCollabV2FileDigest;
const DIGEST_2 = `sha256:${'2'.repeat(64)}` as CodeCollabV2FileDigest;

function textResult(
  status: 'ok' | 'updated',
  text: string,
  digest: CodeCollabV2FileDigest,
  path = 'src/app.ts'
): CodeCollabV2OpenTextOk | Extract<CodeCollabV2RefreshTextResponse, { status: 'updated' }> {
  return {
    status,
    path,
    digest,
    text: {
      encoding: 'plain',
      text,
      rawBytes: new TextEncoder().encode(text).byteLength,
    },
    format: {
      encoding: 'utf8',
      eol: 'lf',
    },
  };
}

function previewOk(
  text: string,
  digest: CodeCollabV2FileDigest,
  path = 'src/app.ts'
): FilePreviewV3Ok {
  return {
    status: 'ok',
    v: 3,
    path,
    digest,
    kind: 'text',
    content: {
      encoding: 'utf8-plain',
      text,
      rawBytes: new TextEncoder().encode(text).byteLength,
    },
    format: { eol: 'lf' },
    sizeBytes: new TextEncoder().encode(text).byteLength,
    readonly: true,
  };
}

function previewBinary(path: string, bytes: Uint8Array, mimeType: string): FilePreviewV3Ok {
  return {
    status: 'ok',
    v: 3,
    path,
    digest: DIGEST_1,
    kind: 'binary',
    content: {
      encoding: 'base64',
      data: btoa(String.fromCharCode(...bytes)),
      rawBytes: bytes.byteLength,
    },
    mimeType,
    sizeBytes: bytes.byteLength,
    readonly: true,
  };
}

function createRuntime(
  overrides: Partial<CodeCollabSessionFileProviderRuntime> = {}
): CodeCollabSessionFileProviderRuntime {
  return {
    sessionId: SESSION_ID,
    previewFile: vi.fn(async (path: string, knownDigest?: string) =>
      knownDigest === DIGEST_1
        ? ({
            status: 'unchanged',
            v: 3,
            path,
            digest: DIGEST_1,
            sizeBytes: 4,
          } satisfies FilePreviewV3Response)
        : previewOk('one\n', DIGEST_1, path)
    ),
    openText: vi.fn(async () => textResult('ok', 'one\n', DIGEST_1) as CodeCollabV2OpenTextOk),
    refreshText: vi.fn(async () => ({
      status: 'up_to_date',
      path: 'src/app.ts',
      digest: DIGEST_1,
    })),
    saveText: vi.fn(async () => ({
      status: 'ok',
      path: 'src/app.ts',
      digest: DIGEST_2,
      rawBytes: 0,
    })),
    openCurrentDiff: vi.fn(async () => ({
      status: 'ok',
      path: 'src/app.ts',
      oldSnapshot: {
        kind: 'text',
        text: {
          encoding: 'plain',
          text: 'one\n',
          rawBytes: 4,
        },
      },
      newSnapshot: {
        kind: 'text',
        text: {
          encoding: 'plain',
          text: 'one\ntwo\n',
          rawBytes: 8,
        },
      },
      add: 1,
      del: 0,
    })),
    openTurnDiff: vi.fn(async () => ({
      status: 'ok',
      path: 'src/app.ts',
      turnId: 'turn-1',
      oldSnapshot: {
        kind: 'text',
        text: {
          encoding: 'plain',
          text: 'turn old\n',
          rawBytes: 9,
        },
      },
      newSnapshot: {
        kind: 'text',
        text: {
          encoding: 'plain',
          text: 'turn new\n',
          rawBytes: 9,
        },
      },
      add: 1,
      del: 1,
    })),
    lspDefinition: vi.fn(async () => ({ status: 'unsupported', code: 'lsp_not_wired' })),
    lspReferences: vi.fn(async () => ({ status: 'unsupported', code: 'lsp_not_wired' })),
    ...overrides,
  };
}

describe('Content-addressed diff transport', () => {
  it.each(['expired', 'edited', 'reverted', 'base-changed'])(
    'renews hydration handles with consistent context after %s',
    async (mode) => {
      const changed = mode === 'edited';
      vi.stubGlobal('crypto', webcrypto);
      vi.stubGlobal('Blob', NodeBlob);
      try {
        const blobs = new Map<CodeCollabDiffBlobKey, Buffer>();
        const blob = (text: string) => {
          const bytes = Buffer.from(text);
          const key =
            `sha256:${createHash('sha256').update(bytes).digest('hex')}` as CodeCollabDiffBlobKey;
          blobs.set(key, bytes);
          return { key, rawBytes: bytes.length, format: { encoding: 'utf8' as const } };
        };
        const before = Array.from({ length: 100 }, (_, i) => `line ${i}\n`).join('');
        let after = before.replace('line 50', 'first50');
        let base = blob(before);
        let head = blob(after);
        const authorized = new Set<CodeCollabDiffBlobKey>();
        const provider = new CodeCollabSessionFileProvider({
          runtime: createRuntime({
            diffBlobTransportOptions: async () => ({
              supported: true,
              scope: 'synthetic',
              persist: false,
            }),
            openDiffManifest: async () => {
              authorized.add(base.key);
              authorized.add(head.key);
              return {
                status: 'ok',
                entries: [
                  {
                    path: 'a.ts',
                    status: after === before ? 'not_changed' : 'ok',
                    base,
                    head,
                    hunks: after.includes('later80')
                      ? '--- a.ts\n+++ a.ts\n@@ -80,3 +80,3 @@\n line 79\n-line 80\n+later80\n line 81\n'
                      : '--- a.ts\n+++ a.ts\n@@ -50,3 +50,3 @@\n line 49\n-line 50\n+first50\n line 51\n',
                  },
                ],
                nextCursor: null,
              };
            },
            readDiffBlob: async (key, offset) => {
              if (!authorized.has(key)) return { status: 'error', code: 'stale' };
              const bytes = blobs.get(key)!;
              return {
                offset,
                length: bytes.length - offset,
                totalBytes: bytes.length,
                encoding: 'gzip-base64',
                data: gzipSync(bytes.subarray(offset)).toString('base64'),
              };
            },
          }),
        });
        const partial = await provider.getDiff(
          'a.ts',
          mode === 'expired' ? 'immutable-turn' : undefined
        );
        if (partial.status !== 'ready-parsed' || !partial.loadDiffFiles)
          throw new Error('Expected partial.');
        authorized.clear(); // Same effect as handle TTL expiry or a daemon restart.
        if (changed) {
          after = before.replace('line 80', 'later80');
          head = blob(after);
        }
        if (mode === 'base-changed') base = blob(before.replace('line 80', 'baseline80'));
        if (mode === 'reverted') {
          after = before;
          head = base;
        }
        if (mode !== 'expired') {
          await expect(partial.loadDiffFiles(partial.fileDiff)).rejects.toMatchObject({
            code: 'diff_changed',
          });
          // The originally displayed patch must keep its original coordinates.
          expect(partial.fileDiff.hunks[0]?.additionStart).toBe(50);
        } else {
          const files = await partial.loadDiffFiles(partial.fileDiff);
          hydratePartialDiff('merge', partial.fileDiff, files);
          expect(files.newFile.contents).toBe(after);
          expect(partial.fileDiff.additionLines.join('')).toBe(after);
          expect(
            partial.fileDiff.hunks.some(
              (hunk) => hunk.additionStart <= 51 && hunk.additionStart + hunk.additionCount > 51
            )
          ).toBe(true);
        }
        expect(await provider.getDiff('a.ts')).toMatchObject({
          status: mode === 'reverted' ? 'unavailable' : 'ready-parsed',
        });
      } finally {
        vi.unstubAllGlobals();
      }
    }
  );
  it('revalidates live metadata despite unchanged index generations and transfers only changed bodies', async () => {
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    try {
      const textState = createCodeCollabSessionFileProviderTextState();
      const contents = new Map<CodeCollabDiffBlobKey, Buffer>();
      const blob = (text: string) => {
        const bytes = Buffer.from(text);
        const key =
          `sha256:${createHash('sha256').update(bytes).digest('hex')}` as CodeCollabDiffBlobKey;
        contents.set(key, bytes);
        return { key, rawBytes: bytes.length, format: { encoding: 'utf8' as const } };
      };
      const old = blob('原始🙂\r\n');
      let current = blob('第一🙂\r\n');
      const other = blob('other\n');
      const entries = (): CodeCollabDiffManifestEntry[] => [
        { path: 'a.ts', status: 'ok', base: old, head: current, add: 1, del: 1 },
        { path: 'b.ts', status: 'ok', base: null, head: other, add: 1, del: 0 },
        {
          path: 'blocked.ts',
          status: 'unavailable',
          base: null,
          head: null,
          error: { status: 'error', code: 'permission_denied', message: 'Synthetic file refusal.' },
        },
        { path: 'link', status: 'binary', base: null, head: null },
      ];
      let sentBytes = 0;
      const manifestRequests: (string | undefined)[] = [];
      const runtime = createRuntime({
        diffBlobTransportOptions: async () => ({
          supported: true,
          scope: 'workspace',
          persist: false,
        }),
        openDiffManifest: async (request) => {
          manifestRequests.push(request.path);
          return {
            status: 'ok',
            base: 'base',
            entries: entries().filter(
              (entry) => request.path === undefined || entry.path === request.path
            ),
            nextCursor: null,
          };
        },
        readDiffBlob: async (key, offset) => {
          const bytes = contents.get(key);
          if (!bytes) throw new Error('Unknown blob.');
          const page = bytes.subarray(offset, offset + 3);
          sentBytes += page.length;
          return {
            offset,
            length: page.length,
            totalBytes: bytes.length,
            encoding: 'gzip-base64',
            data: gzipSync(page).toString('base64'),
          };
        },
      });
      const options = {
        runtime,
        textState,
        allChanges: {
          'a.ts': { diff: [1, 1] as [number, number] },
          'b.ts': { diff: [1, 0] as [number, number] },
        },
        generations: { 'a.ts': '1', 'b.ts': '1' },
      };
      const first = new CodeCollabSessionFileProvider(options);
      const manifest = await first.getAllChangesDiff();
      expect(manifest).toMatchObject({
        status: 'ready',
        entries: [
          { path: 'a.ts', diff: { status: 'deferred' } },
          { path: 'b.ts', diff: { status: 'deferred' } },
          {
            path: 'blocked.ts',
            diff: {
              status: 'unavailable',
              reason: 'permission-denied',
              message: 'Synthetic file refusal.',
            },
          },
          {
            path: 'link',
            diff: {
              status: 'ready',
              oldSnapshot: { kind: 'binary' },
              newSnapshot: { kind: 'binary' },
            },
          },
        ],
      });
      expect(sentBytes).toBe(0);
      expect(await first.getDiff('a.ts')).toMatchObject({
        status: 'ready',
        oldSnapshot: { text: '原始🙂\r\n' },
        newSnapshot: { text: '第一🙂\r\n' },
      });
      const firstBytes = old.rawBytes + current.rawBytes;
      expect(sentBytes).toBe(firstBytes);
      await first.getDiff('a.ts');
      expect(sentBytes).toBe(firstBytes);
      current = blob('第二🙂\r\n');
      // The publisher can be offline or its watch expired; unchanged hints are not proof.
      const next = new CodeCollabSessionFileProvider(options);
      const refreshed = await next.getAllChangesDiff();
      expect(refreshed).toMatchObject({
        status: 'ready',
        entries: [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'blocked.ts' }, { path: 'link' }],
      });
      expect(manifestRequests).toEqual([undefined, 'a.ts', undefined]);
      const changed = await next.getDiff('a.ts');
      expect(changed).toMatchObject({ status: 'ready', newSnapshot: { text: '第二🙂\r\n' } });
      expect(sentBytes).toBe(firstBytes + current.rawBytes);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('persists ordinary remote blobs within a byte bound, while protected reads stay in memory', async () => {
    const factory = new IDBFactory();
    vi.stubGlobal('indexedDB', factory);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const first = new DiffBlobCache();
      const bytes = new Uint8Array(10 * 1024 * 1024).fill(17);
      for (let i = 0; i < 7; i++) {
        vi.setSystemTime(i + 1);
        await first.put('ordinary', `blob-${i}`, bytes, true);
      }
      const reopened = new DiffBlobCache();
      expect(await reopened.get('ordinary', 'blob-0', true)).toBeUndefined();
      const retained = await reopened.get('ordinary', 'blob-1', true);
      expect(retained?.byteLength).toBe(bytes.byteLength);
      expect(retained?.[retained.length - 1]).toBe(17);
      const secret = new Uint8Array([21, 22, 23]);
      await first.put('protected', 'secret', secret, false);
      expect(await first.get('protected', 'secret', false)).toEqual(secret);
      first.clear();
      expect(await first.get('protected', 'secret', false)).toBeUndefined();
      expect(await reopened.get('protected', 'secret', true)).toBeUndefined();
      expect(await reopened.get('another-workspace', 'blob-1', true)).toBeUndefined();
      expect((await factory.databases()).map((row) => row.name)).toEqual([DIFF_BLOB_CACHE_DB]);
      vi.stubGlobal('indexedDB', undefined);
      await first.put('ordinary', 'memory-after-disk-failure', secret, true);
      expect(await first.get('ordinary', 'memory-after-disk-failure', true)).toEqual(secret);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('rejects corrupt cached content, verifies its replacement, and stops paging after cancellation', async () => {
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    try {
      const bytes = Buffer.from('合成🙂content');
      const key =
        `sha256:${createHash('sha256').update(bytes).digest('hex')}` as CodeCollabDiffBlobKey;
      const blob = { key, rawBytes: bytes.length, format: { encoding: 'utf8' as const } };
      const cache = new DiffBlobCache();
      await cache.put('workspace', key, new Uint8Array(bytes.length).fill(1), false);
      let transferred = 0;
      const read = async (_key: string, offset: number) => {
        const chunk = bytes.subarray(offset, offset + 3);
        transferred += chunk.length;
        return {
          offset,
          length: chunk.length,
          totalBytes: bytes.length,
          encoding: 'gzip-base64' as const,
          data: gzipSync(chunk).toString('base64'),
        };
      };
      const request = { blob, scope: 'workspace', persist: false, cache, read };
      expect(await readDiffBlob(request)).toEqual(new Uint8Array(bytes));
      expect(transferred).toBe(bytes.length);
      await readDiffBlob(request);
      expect(transferred).toBe(bytes.length);
      cache.clear();
      transferred = 0;
      const controller = new AbortController();
      await expect(
        readDiffBlob({
          ...request,
          signal: controller.signal,
          read: async (...args) => {
            const page = await read(...args);
            controller.abort();
            return page;
          },
        })
      ).rejects.toThrow();
      expect(transferred).toBe(3);
      expect(await cache.get('workspace', key, false)).toBeUndefined();
      expect(await readDiffBlob(request)).toEqual(new Uint8Array(bytes));
      cache.clear();
      expect(
        await readDiffBlob({
          ...request,
          read: async (...args) => {
            const page = await read(...args);
            cache.clear();
            return page;
          },
        })
      ).toEqual(new Uint8Array(bytes));
      expect(await cache.get('workspace', key, false)).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens a partial remote patch without blob traffic and hydrates verified complete files on expansion', async () => {
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    try {
      const before =
        Array.from({ length: 100 }, (_, i) => (i === 50 ? 'before' : `line ${i}`)).join('\n') +
        '\n';
      const after = before.replace('before', 'after');
      const data = new Map<CodeCollabDiffBlobKey, Buffer>();
      const blob = (text: string) => {
        const bytes = Buffer.from(text);
        const key =
          `sha256:${createHash('sha256').update(bytes).digest('hex')}` as CodeCollabDiffBlobKey;
        data.set(key, bytes);
        return { key, rawBytes: bytes.length, format: { encoding: 'utf8' as const } };
      };
      const entry: CodeCollabDiffManifestEntry = {
        path: 'a.ts',
        status: 'ok',
        base: blob(before),
        head: blob(after),
        hunks: '--- a.ts\n+++ a.ts\n@@ -50,3 +50,3 @@\n line 49\n-before\n+after\n line 51\n',
      };
      let sentBytes = 0;
      const provider = new CodeCollabSessionFileProvider({
        runtime: createRuntime({
          diffBlobTransportOptions: async () => ({
            supported: true,
            scope: 'workspace',
            persist: false,
          }),
          openDiffManifest: async () => ({ status: 'ok', entries: [entry], nextCursor: null }),
          readDiffBlob: async (key, offset) => {
            const bytes = data.get(key);
            if (!bytes) throw new Error('Unknown blob.');
            const chunk = bytes.subarray(offset);
            sentBytes += chunk.length;
            return {
              offset,
              length: chunk.length,
              totalBytes: bytes.length,
              encoding: 'gzip-base64',
              data: gzipSync(chunk).toString('base64'),
            };
          },
        }),
      });
      const partial = await provider.getDiff('a.ts');
      expect(partial.status).toBe('ready-parsed');
      if (partial.status !== 'ready-parsed' || !partial.loadDiffFiles)
        throw new Error('Expected a partial diff.');
      expect(partial.fileDiff.isPartial).toBe(true);
      expect(sentBytes).toBe(0);
      const loaded = await partial.loadDiffFiles(partial.fileDiff);
      expect(loaded.oldFile?.contents).toBe(before);
      expect(loaded.newFile.contents).toBe(after);
      expect(sentBytes).toBe(Buffer.byteLength(before) + Buffer.byteLength(after));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('CodeCollabSessionFileProvider v2', () => {
  it('marks an external preview readonly so the editor cannot offer an impossible save', async () => {
    // Preview serves temp/scratch roots; `save-text` refuses everything outside the
    // workspace. Without this, an unindexed /tmp file resolves to a writable entry
    // and the user loses the edit at save time.
    const runtime = createRuntime({
      previewFile: vi.fn(async () => ({
        ...previewOk('scratch\n', DIGEST_1, '/tmp/scratch/plan.md'),
        external: true,
      })),
    });
    const provider = new CodeCollabSessionFileProvider({
      runtime,
      role: 'write',
      fileTree: {},
    });

    const opened = await provider.openFile('/tmp/scratch/plan.md');
    expect(opened).toMatchObject({
      status: 'ready',
      entry: { kind: 'text', readonly: true },
    });

    // An in-workspace text file keeps its index-derived editability.
    const inWorkspace = new CodeCollabSessionFileProvider({
      runtime: createRuntime(),
      role: 'write',
      fileTree: { 'src/app.ts': true },
    });
    await expect(inWorkspace.openFile('src/app.ts')).resolves.toMatchObject({
      entry: { readonly: false },
    });
  });

  it('preserves opened text base digest across provider rebuilds with shared text state', async () => {
    const textState = createCodeCollabSessionFileProviderTextState();
    const saveText = vi
      .fn<CodeCollabSessionFileProviderRuntime['saveText']>()
      .mockResolvedValueOnce({
        status: 'ok',
        path: 'src/app.ts',
        digest: DIGEST_2,
        rawBytes: 5,
      } satisfies CodeCollabV2SaveTextResponse);
    const firstRuntime = createRuntime();
    const secondRuntime = createRuntime({ saveText });
    const firstProvider = new CodeCollabSessionFileProvider({
      runtime: firstRuntime,
      role: 'write',
      fileTree: { 'src/app.ts': true },
      textState,
    });
    const secondProvider = new CodeCollabSessionFileProvider({
      runtime: secondRuntime,
      role: 'write',
      fileTree: { 'src/app.ts': true },
      textState,
    });

    await firstProvider.openFile('src/app.ts');
    await secondProvider.saveText('src/app.ts', 'mine\n');

    expect(secondRuntime.previewFile).not.toHaveBeenCalled();
    expect(saveText).toHaveBeenCalledWith(
      'src/app.ts',
      DIGEST_1,
      { encoding: 'plain', text: 'mine\n', rawBytes: 5 },
      { encoding: 'utf8', eol: 'lf' }
    );
  });

  it('checks remote text changes without replacing the cached save base digest', async () => {
    const textState = createCodeCollabSessionFileProviderTextState();
    const saveText = vi
      .fn<CodeCollabSessionFileProviderRuntime['saveText']>()
      .mockResolvedValueOnce({
        status: 'ok',
        path: 'src/app.ts',
        digest: `sha256:${'3'.repeat(64)}` as CodeCollabV2FileDigest,
        rawBytes: 5,
      } satisfies CodeCollabV2SaveTextResponse);
    const runtime = createRuntime({
      refreshText: vi.fn(async () => textResult('updated', 'disk\n', DIGEST_2)),
      saveText,
    });
    const provider = new CodeCollabSessionFileProvider({
      runtime,
      role: 'write',
      fileTree: { 'src/app.ts': true },
      textState,
    });

    await provider.openFile('src/app.ts');
    await expect(provider.checkTextChanged('src/app.ts')).resolves.toMatchObject({
      status: 'changed',
      path: 'src/app.ts',
      digest: DIGEST_2,
    });
    await provider.saveText('src/app.ts', 'mine\n');

    expect(saveText).toHaveBeenCalledWith(
      'src/app.ts',
      DIGEST_1,
      { encoding: 'plain', text: 'mine\n', rawBytes: 5 },
      { encoding: 'utf8', eol: 'lf' }
    );
  });

  it('keeps user text on save conflict and can discard to disk text', async () => {
    const runtime = createRuntime({
      saveText: vi.fn(async () => ({
        status: 'conflict',
        reason: 'digest_mismatch',
        path: 'src/app.ts',
        baseDigest: DIGEST_1,
        diskDigest: DIGEST_2,
        diskText: {
          encoding: 'plain',
          text: 'disk\n',
          rawBytes: 5,
        },
      })),
    });
    const provider = new CodeCollabSessionFileProvider({
      runtime,
      role: 'write',
      fileTree: { 'src/app.ts': true },
    });
    const emitted: string[] = [];
    provider.subscribeText('src/app.ts', (text) => emitted.push(text));

    await provider.openFile('src/app.ts');
    let conflictId: string | undefined;
    try {
      await provider.saveText('src/app.ts', 'mine\n');
    } catch (error) {
      expect(error).toBeInstanceOf(SaveTextConflictError);
      conflictId = (error as SaveTextConflictError).conflictId;
    }

    expect(conflictId).toBeTruthy();
    expect(emitted).toEqual([]);
    await provider.resolveSaveConflict('src/app.ts', {
      conflictId: conflictId!,
      resolution: 'discard',
    });
    expect(emitted).toEqual(['disk\n']);
  });

  it('loads conflict markers without writing until the user saves the resolved text', async () => {
    const saveText = vi
      .fn<CodeCollabSessionFileProviderRuntime['saveText']>()
      .mockResolvedValueOnce({
        status: 'conflict',
        reason: 'digest_mismatch',
        path: 'src/app.ts',
        baseDigest: DIGEST_1,
        diskDigest: DIGEST_2,
        diskText: {
          encoding: 'plain',
          text: 'disk\n',
          rawBytes: 5,
        },
      } satisfies CodeCollabV2SaveTextResponse)
      .mockResolvedValueOnce({
        status: 'ok',
        path: 'src/app.ts',
        digest: `sha256:${'3'.repeat(64)}` as CodeCollabV2FileDigest,
        rawBytes: 9,
      } satisfies CodeCollabV2SaveTextResponse);
    const runtime = createRuntime({ saveText });
    const provider = new CodeCollabSessionFileProvider({
      runtime,
      role: 'write',
      fileTree: { 'src/app.ts': true },
    });
    const emitted: string[] = [];
    provider.subscribeText('src/app.ts', (text) => emitted.push(text));

    await provider.openFile('src/app.ts');
    let conflictId: string | undefined;
    try {
      await provider.saveText('src/app.ts', 'mine\n');
    } catch (error) {
      expect(error).toBeInstanceOf(SaveTextConflictError);
      conflictId = (error as SaveTextConflictError).conflictId;
    }

    await provider.resolveSaveConflict('src/app.ts', {
      conflictId: conflictId!,
      resolution: 'load_with_conflicts',
    });

    expect(saveText).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual([
      ['<<<<<<< disk', 'disk', '=======', 'mine', '>>>>>>> local edits', ''].join('\n'),
    ]);

    await provider.saveText('src/app.ts', 'resolved\n');
    expect(saveText).toHaveBeenLastCalledWith(
      'src/app.ts',
      DIGEST_2,
      { encoding: 'plain', text: 'resolved\n', rawBytes: 9 },
      { encoding: 'utf8', eol: 'lf' }
    );
  });

  it('keeps both spellings of a resolved open current across a save', async () => {
    // The machine resolves `Readme.md` to `README.md`. The viewer tab keeps the
    // requested spelling while `entry.fileId` carries the machine's, so the
    // save arrives under one key and the next change-check under the other.
    // Both must see the post-save digest, or the pre-check reports our own
    // save as an external change.
    const savedDigest = `sha256:${'3'.repeat(64)}` as CodeCollabV2FileDigest;
    const refreshText = vi.fn<CodeCollabSessionFileProviderRuntime['refreshText']>(
      async (_path: string, digest: string) =>
        digest === savedDigest
          ? { status: 'up_to_date', path: 'README.md', digest: savedDigest }
          : (textResult('updated', 'stale\n', DIGEST_2, 'README.md') as Extract<
              CodeCollabV2RefreshTextResponse,
              { status: 'updated' }
            >)
    );
    const runtime = createRuntime({
      previewFile: vi.fn(async () => previewOk('one\n', DIGEST_1, 'README.md')),
      refreshText,
      saveText: vi.fn(async () => ({
        status: 'ok',
        path: 'README.md',
        digest: savedDigest,
        rawBytes: 5,
      })),
    });
    const provider = new CodeCollabSessionFileProvider({ runtime, role: 'write', fileTree: {} });

    const opened = await provider.openFile('Readme.md');
    expect(opened).toMatchObject({ status: 'ready', entry: { fileId: 'README.md' } });

    await expect(provider.saveText('README.md', 'mine\n')).resolves.toMatchObject({
      status: 'ready',
    });

    // The requested spelling still answers the change-check with the NEW digest.
    await expect(provider.checkTextChanged('Readme.md')).resolves.toMatchObject({
      status: 'up_to_date',
      digest: savedDigest,
    });
    expect(refreshText).toHaveBeenLastCalledWith('Readme.md', savedDigest);
  });
});

describe('local resource snapshots', () => {
  it('makes paged files readonly and removes any previously editable snapshot', async () => {
    let large = false;
    const runtime = createRuntime({
      previewFile: async () =>
        large
          ? {
              status: 'resource',
              kind: 'text',
              path: 'src/app.ts',
              external: false,
              sizeBytes: 3 * 1024 ** 3,
              url: 'lody-resource://file/synthetic',
            }
          : previewOk('small', DIGEST_1),
    });
    const provider = new CodeCollabSessionFileProvider({
      runtime,
      role: 'write',
      fileTree: { 'src/app.ts': true },
    });
    expect((await provider.openFile('src/app.ts')).status).toBe('ready');
    large = true;
    const opened = await provider.openFile('src/app.ts');
    expect(opened).toMatchObject({
      status: 'ready',
      entry: { readonly: true },
      snapshot: { kind: 'paged-text' },
    });
    expect(await provider.saveText('src/app.ts', 'partial page')).toMatchObject({
      status: 'unavailable',
    });
  });
});
