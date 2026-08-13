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

describe('CodeCollabSessionFileProvider v2', () => {
  it('uses workspace path as file id and revalidates opened text by digest', async () => {
    const runtime = createRuntime({
      previewFile: vi
        .fn()
        .mockResolvedValueOnce(previewOk('one\n', DIGEST_1))
        .mockResolvedValueOnce({
          status: 'unchanged',
          v: 3,
          path: 'src/app.ts',
          digest: DIGEST_1,
          sizeBytes: 4,
        } satisfies FilePreviewV3Response)
        .mockResolvedValueOnce(previewOk('two\n', DIGEST_2)),
    });
    const provider = new CodeCollabSessionFileProvider({
      runtime,
      role: 'write',
      fileTree: {
        'src/app.ts': true,
        src: { kind: 'lazy' },
      },
    });

    expect(await provider.listFiles()).toEqual([
      expect.objectContaining({
        entryType: 'lazy-directory',
        directoryId: 'src',
        path: 'src',
      }),
      expect.objectContaining({
        entryType: 'file',
        fileId: 'src/app.ts',
        path: 'src/app.ts',
        kind: 'text',
      }),
    ]);

    const opened = await provider.openFile('src/app.ts');
    expect(opened).toMatchObject({
      status: 'ready',
      snapshot: { kind: 'text', text: 'one\n', eol: 'lf' },
    });
    expect(runtime.previewFile).toHaveBeenCalledWith('src/app.ts', undefined);

    const same = await provider.openFile('src/app.ts');
    expect(same).toMatchObject({
      status: 'ready',
      snapshot: { kind: 'text', text: 'one\n', eol: 'lf' },
    });
    expect(runtime.previewFile).toHaveBeenLastCalledWith('src/app.ts', DIGEST_1);

    const updated = await provider.openFile('src/app.ts');
    expect(updated).toMatchObject({
      status: 'ready',
      snapshot: { kind: 'text', text: 'two\n', eol: 'lf' },
    });
    // Preview must never touch the Code Collab read path: activating it is what
    // this change removed.
    expect(runtime.openText).not.toHaveBeenCalled();
    expect(runtime.refreshText).not.toHaveBeenCalled();
  });

  it('previews a binary image file the file index marked as binary', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    const runtime = createRuntime({
      previewFile: vi.fn(async () => previewBinary('assets/logo.png', bytes, 'image/png')),
    });
    const provider = new CodeCollabSessionFileProvider({
      runtime,
      role: 'write',
      fileTree: { 'assets/logo.png': { kind: 'binary' } },
    });

    // The index entry must stay openable — a preview-blocking reason here is what
    // made images unclickable in the tree.
    expect(await provider.listFiles()).toEqual([
      expect.objectContaining({ path: 'assets/logo.png', kind: 'binary' }),
    ]);
    expect((await provider.listFiles())[0]?.unavailableReason).toBeUndefined();

    const opened = await provider.openFile('assets/logo.png');
    expect(opened).toMatchObject({
      status: 'ready',
      entry: { kind: 'binary', readonly: true },
      snapshot: { kind: 'binary', mimeType: 'image/png' },
    });
    expect(
      opened.status === 'ready' && opened.snapshot.kind === 'binary'
        ? Array.from(opened.snapshot.bytes ?? [])
        : null
    ).toEqual(Array.from(bytes));
  });

  it('reports an oversize preview as unavailable rather than a partial file', async () => {
    const runtime = createRuntime({
      previewFile: vi.fn(async () => ({
        status: 'error',
        v: 3,
        code: 'too_large',
        message: 'File is too large to preview.',
        path: 'big.bin',
        sizeBytes: 100,
        limitBytes: 10,
      } satisfies FilePreviewV3Response)),
    });
    const provider = new CodeCollabSessionFileProvider({
      runtime,
      role: 'write',
      fileTree: { 'big.bin': true },
    });

    await expect(provider.openFile('big.bin')).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'text-too-large',
      message: 'File is too large to preview.',
    });
  });

  it('surfaces a rejected out-of-workspace path as permission denied', async () => {
    const runtime = createRuntime({
      previewFile: vi.fn(async () => ({
        status: 'error',
        v: 3,
        code: 'path_not_allowed',
        message: 'File is outside the workspace.',
      } satisfies FilePreviewV3Response)),
    });
    const provider = new CodeCollabSessionFileProvider({ runtime, role: 'write', fileTree: {} });

    await expect(provider.openFile('/etc/passwd')).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'permission-denied',
    });
  });

  it('evicts least-recently-used opened text by byte size', async () => {
    const textState = createCodeCollabSessionFileProviderTextState({
      maxOpenTextCacheBytes: 8,
    });
    const previewFile = vi.fn<CodeCollabSessionFileProviderRuntime['previewFile']>(
      async (path, knownDigest) =>
        knownDigest === DIGEST_1
          ? { status: 'unchanged', v: 3, path, digest: DIGEST_1, sizeBytes: 4 }
          : previewOk(`${path[0] ?? 'x'}123`, DIGEST_1, path)
    );
    const provider = new CodeCollabSessionFileProvider({
      runtime: createRuntime({ previewFile }),
      role: 'write',
      fileTree: {
        'a.ts': true,
        'b.ts': true,
        'c.ts': true,
      },
      textState,
    });

    await provider.openFile('a.ts');
    await provider.openFile('b.ts');
    await provider.openFile('a.ts');
    await provider.openFile('c.ts');
    await provider.openFile('b.ts');

    // Only the second `a.ts` open still had a cached digest to revalidate against;
    // the evicted entries had to be read in full again.
    expect(previewFile.mock.calls.map(([path, digest]) => [path, digest])).toEqual([
      ['a.ts', undefined],
      ['b.ts', undefined],
      ['a.ts', DIGEST_1],
      ['c.ts', undefined],
      ['b.ts', undefined],
    ]);
    expect(textState.openCache.byteSize).toBeLessThanOrEqual(8);
  });

  it('saves with the cached base digest and updates the local base digest', async () => {
    const saveText = vi
      .fn<CodeCollabSessionFileProviderRuntime['saveText']>()
      .mockResolvedValueOnce({
        status: 'ok',
        path: 'src/app.ts',
        digest: DIGEST_2,
        rawBytes: 5,
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
    const saved = await provider.saveText('src/app.ts', 'mine\n');

    expect(saveText).toHaveBeenCalledWith(
      'src/app.ts',
      DIGEST_1,
      { encoding: 'plain', text: 'mine\n', rawBytes: 5 },
      { encoding: 'utf8', eol: 'lf' }
    );
    expect(saved).toMatchObject({
      status: 'ready',
      snapshot: { kind: 'text', text: 'mine\n', eol: 'lf' },
    });
    expect(emitted).toEqual(['mine\n']);
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

  it('opens current All Changes and historical turn diffs through CLI RPC', async () => {
    const runtime = createRuntime();
    const provider = new CodeCollabSessionFileProvider({
      runtime,
      fileTree: { 'src/app.ts': true, 'old.ts': true },
      allChanges: {
        'src/app.ts': { diff: [3, 1] },
        'old.ts': { diff: [0, 9], del: true },
      },
    });

    expect(provider.supportsHistoricalDiffs).toBe(true);
    await expect(provider.getDiff('src/app.ts')).resolves.toMatchObject({
      status: 'ready',
      oldSnapshot: { kind: 'text', text: 'one\n' },
      newSnapshot: { kind: 'text', text: 'one\ntwo\n' },
    });
    expect(runtime.openCurrentDiff).toHaveBeenCalledWith('src/app.ts');

    await expect(provider.getDiff('src/app.ts', 'turn-1')).resolves.toMatchObject({
      status: 'ready',
      oldSnapshot: { kind: 'text', text: 'turn old\n' },
      newSnapshot: { kind: 'text', text: 'turn new\n' },
    });
    expect(runtime.openTurnDiff).toHaveBeenCalledWith('src/app.ts', 'turn-1');
    await expect(provider.listChangedFiles()).resolves.toEqual({
      status: 'ready',
      files: [
        expect.objectContaining({ path: 'old.ts', kind: 'deleted', add: 0, del: 9 }),
        expect.objectContaining({ path: 'src/app.ts', kind: 'text', add: 3, del: 1 }),
      ],
    });
  });
});
