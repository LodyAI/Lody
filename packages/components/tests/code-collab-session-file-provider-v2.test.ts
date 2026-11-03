// @vitest-environment jsdom

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
