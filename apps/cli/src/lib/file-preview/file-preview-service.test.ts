import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import {
  FILE_PREVIEW_LOCAL_PAYLOAD_BUDGET_BYTES,
  FILE_PREVIEW_V3_LIMITS,
  type SessionId,
} from '@lody/shared';
import { FilePreviewService, type FilePreviewWorkspaceResolver } from './file-preview-service';

const SESSION_ID = 'session-preview' as SessionId;

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/**
 * Does this volume treat `writtenName` and `requestedName` as the same file?
 * Probed rather than assumed: it is a property of the mount, not the OS —
 * macOS ships case-insensitive APFS by default but case-sensitive is a
 * supported format, and Linux volumes go both ways too.
 */
async function foldsSpelling(
  directory: string,
  writtenName: string,
  requestedName: string
): Promise<boolean> {
  const probeDirectory = path.join(directory, '.spelling-probe');
  await mkdir(probeDirectory, { recursive: true });
  try {
    await writeFile(path.join(probeDirectory, writtenName), 'probe');
    await readFile(path.join(probeDirectory, requestedName));
    return true;
  } catch {
    return false;
  } finally {
    await rm(probeDirectory, { recursive: true, force: true });
  }
}

const digestOf = (bytes: Uint8Array | string): string =>
  `sha256:${createHash('sha256')
    .update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
    .digest('hex')}`;

function createService(args: {
  readonly workspaceRoot: string;
  readonly extraRoots?: readonly string[];
  readonly limits?: Partial<typeof FILE_PREVIEW_V3_LIMITS>;
}): FilePreviewService {
  const resolveWorkspace: FilePreviewWorkspaceResolver = async () => ({
    ok: true,
    ownerSessionId: SESSION_ID,
    workspaceRoot: args.workspaceRoot,
  });
  return new FilePreviewService({
    resolveWorkspace,
    extraRoots: args.extraRoots ?? [],
    ...(args.limits === undefined ? {} : { limits: args.limits }),
  });
}

describe('FilePreviewService', () => {
  it('reads a workspace text file as plain UTF-8 with its digest and EOL', async () => {
    const workspaceRoot = await makeDir('preview-ws-');
    await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'src/app.ts'), 'const a = 1;\nconst b = 2;\n');
    const service = createService({ workspaceRoot });

    const response = await service.previewFile({
      v: 3,
      sessionId: SESSION_ID,
      path: 'src/app.ts',
    });

    expect(response).toMatchObject({
      status: 'ok',
      path: 'src/app.ts',
      kind: 'text',
      digest: digestOf('const a = 1;\nconst b = 2;\n'),
      format: { eol: 'lf', bom: false },
      sizeBytes: 26,
    });
    expect(response.status === 'ok' ? response.content : null).toEqual({
      encoding: 'utf8-plain',
      text: 'const a = 1;\nconst b = 2;\n',
      rawBytes: 26,
    });
  });

  it('gzips text past the plain-text threshold and the payload round-trips', async () => {
    const workspaceRoot = await makeDir('preview-ws-');
    const text = 'x'.repeat(4096);
    await writeFile(path.join(workspaceRoot, 'big.txt'), text);
    const service = createService({ workspaceRoot, limits: { plainTextBytes: 16 } });

    const response = await service.previewFile({ v: 3, sessionId: SESSION_ID, path: 'big.txt' });

    expect(response.status).toBe('ok');
    if (response.status !== 'ok' || response.content.encoding !== 'utf8-gzip-base64') {
      throw new Error('expected a gzip-encoded text preview');
    }
    expect(response.content.rawBytes).toBe(4096);
    expect(gunzipSync(Buffer.from(response.content.data, 'base64')).toString('utf8')).toBe(text);
  });

  it('returns a PNG as base64 bytes with its image MIME type', async () => {
    const workspaceRoot = await makeDir('preview-ws-');
    // A real PNG signature, including the NUL bytes that made this a hard
    // rejection before File Preview v3.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00]);
    await writeFile(path.join(workspaceRoot, 'logo.png'), bytes);
    const service = createService({ workspaceRoot });

    const response = await service.previewFile({ v: 3, sessionId: SESSION_ID, path: 'logo.png' });

    expect(response).toMatchObject({
      status: 'ok',
      kind: 'binary',
      mimeType: 'image/png',
      sizeBytes: bytes.byteLength,
      readonly: true,
    });
    if (response.status !== 'ok' || response.content.encoding !== 'base64') {
      throw new Error('expected a base64 binary preview');
    }
    expect(Buffer.from(response.content.data, 'base64')).toEqual(bytes);
  });

  it('keeps SVG on the text path so it retains its source view', async () => {
    // SVG matches `getImageMimeTypeForPath` but is XML text. Sending it as base64
    // would cost it the source view and the editing it has today.
    const workspaceRoot = await makeDir('preview-ws-');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
    await writeFile(path.join(workspaceRoot, 'icon.svg'), svg);
    const service = createService({ workspaceRoot });

    const response = await service.previewFile({ v: 3, sessionId: SESSION_ID, path: 'icon.svg' });

    expect(response).toMatchObject({ status: 'ok', kind: 'text' });
    expect(response.status === 'ok' ? response.content : null).toMatchObject({
      encoding: 'utf8-plain',
      text: svg,
    });
  });

  it('gives SVG the text budget, not the smaller binary one', async () => {
    const workspaceRoot = await makeDir('preview-ws-');
    await writeFile(path.join(workspaceRoot, 'big.svg'), `<svg>${'a'.repeat(200)}</svg>`);
    const service = createService({
      workspaceRoot,
      limits: { maxBinaryBytes: 20, maxTextBytes: 10_000, plainTextBytes: 10_000 },
    });

    const response = await service.previewFile({ v: 3, sessionId: SESSION_ID, path: 'big.svg' });

    expect(response).toMatchObject({ status: 'ok', kind: 'text' });
  });

  it('reports a missing file as not found when its root is reached through a symlink', async () => {
    // Reproduces macOS, where `os.tmpdir()` is `/var/folders/…` but really lives
    // at `/private/var/folders/…`: comparing an unresolved lexical path against
    // resolved roots alone never matches, so every missing temp file came back as
    // "outside the workspace" instead of "not found".
    const realRoot = await makeDir('preview-real-');
    const linkParent = await makeDir('preview-link-');
    const linkedRoot = path.join(linkParent, 'ws-link');
    await symlink(realRoot, linkedRoot);
    const service = createService({ workspaceRoot: linkedRoot });

    const response = await service.previewFile({ v: 3, sessionId: SESSION_ID, path: 'gone.ts' });

    expect(response).toMatchObject({ status: 'error', code: 'file_not_found' });
  });

  it('still reads an existing file whose workspace root is a symlink', async () => {
    const realRoot = await makeDir('preview-real-');
    const linkParent = await makeDir('preview-link-');
    const linkedRoot = path.join(linkParent, 'ws-link');
    await symlink(realRoot, linkedRoot);
    await writeFile(path.join(realRoot, 'a.ts'), 'const a = 1;\n');
    const service = createService({ workspaceRoot: linkedRoot });

    const response = await service.previewFile({ v: 3, sessionId: SESSION_ID, path: 'a.ts' });

    // Reported workspace-relative and NOT flagged external: the symlinked root is
    // the same directory, so it must not read as an out-of-workspace file.
    expect(response).toMatchObject({ status: 'ok', kind: 'text', path: 'a.ts' });
    expect(response.status === 'ok' ? response.external : undefined).toBeUndefined();
  });

  it('returns binary bytes for a NUL-containing file whose name looks like text', async () => {
    const workspaceRoot = await makeDir('preview-ws-');
    const bytes = Buffer.from([0x41, 0x00, 0x42]);
    await writeFile(path.join(workspaceRoot, 'data.bin'), bytes);
    const service = createService({ workspaceRoot });

    const response = await service.previewFile({ v: 3, sessionId: SESSION_ID, path: 'data.bin' });

    expect(response).toMatchObject({
      status: 'ok',
      kind: 'binary',
      mimeType: 'application/octet-stream',
    });
  });

  it('answers `unchanged` without bytes when the caller already has the digest', async () => {
    const workspaceRoot = await makeDir('preview-ws-');
    await writeFile(path.join(workspaceRoot, 'notes.md'), '# Title\n');
    const service = createService({ workspaceRoot });

    const response = await service.previewFile({
      v: 3,
      sessionId: SESSION_ID,
      path: 'notes.md',
      knownDigest: digestOf('# Title\n') as `sha256:${string}`,
    });

    expect(response).toEqual({
      status: 'unchanged',
      v: 3,
      path: 'notes.md',
      digest: digestOf('# Title\n'),
      sizeBytes: 8,
    });
  });

  it('rejects a file over the text limit instead of truncating it', async () => {
    const workspaceRoot = await makeDir('preview-ws-');
    await writeFile(path.join(workspaceRoot, 'huge.txt'), 'y'.repeat(200));
    const service = createService({ workspaceRoot, limits: { maxTextBytes: 50 } });

    const response = await service.previewFile({ v: 3, sessionId: SESSION_ID, path: 'huge.txt' });

    expect(response).toMatchObject({
      status: 'error',
      code: 'too_large',
      sizeBytes: 200,
      limitBytes: 50,
    });
  });

  it('does not hold a same-machine preview to the remote transport budget', async () => {
    // The default text ceiling is the REMOTE wire's budget. A same-machine read
    // does not cross it, so the viewer's "too large" card would be advice about
    // a limit that is not in play.
    const workspaceRoot = await makeDir('preview-ws-');
    const text = 'y'.repeat(FILE_PREVIEW_V3_LIMITS.maxTextBytes + 1024);
    await writeFile(path.join(workspaceRoot, 'huge.txt'), text);
    const service = createService({ workspaceRoot });

    const remote = await service.previewFile({ v: 3, sessionId: SESSION_ID, path: 'huge.txt' });
    expect(remote).toMatchObject({ status: 'error', code: 'too_large' });

    const local = await service.previewFile(
      { v: 3, sessionId: SESSION_ID, path: 'huge.txt' },
      { sameMachine: true }
    );
    expect(local).toMatchObject({
      status: 'ok',
      kind: 'text',
      sizeBytes: text.length,
      // Nothing to compress for: the reply never leaves the machine.
      content: { encoding: 'utf8-plain' },
    });
  });

  it('refuses a same-machine preview that would overrun the local IPC response', async () => {
    // The local IPC client DESTROYS a body past its cap, which the facade
    // reports as a retryable I/O error — "try again" about a file that will
    // never load. This must stay the honest verdict instead.
    const workspaceRoot = await makeDir('preview-ws-');
    const text = 'y'.repeat(FILE_PREVIEW_LOCAL_PAYLOAD_BUDGET_BYTES + 1024);
    await writeFile(path.join(workspaceRoot, 'over-budget.txt'), text);
    const service = createService({ workspaceRoot });

    const response = await service.previewFile(
      { v: 3, sessionId: SESSION_ID, path: 'over-budget.txt' },
      { sameMachine: true }
    );

    expect(response).toMatchObject({
      status: 'error',
      code: 'too_large',
      limitBytes: FILE_PREVIEW_LOCAL_PAYLOAD_BUDGET_BYTES,
    });
  });

  it('measures the ESCAPED payload, not the file size, for same-machine text', async () => {
    // A file of newlines doubles under JSON escaping and one of control bytes
    // sextuples, so a raw-size cap cannot predict whether the reply fits. This
    // file is comfortably under every byte limit and still does not fit.
    const workspaceRoot = await makeDir('preview-ws-');
    const text = '\u0001'.repeat(Math.ceil(FILE_PREVIEW_LOCAL_PAYLOAD_BUDGET_BYTES / 5));
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(FILE_PREVIEW_LOCAL_PAYLOAD_BUDGET_BYTES);
    await writeFile(path.join(workspaceRoot, 'control.txt'), text);
    const service = createService({ workspaceRoot });

    const response = await service.previewFile(
      { v: 3, sessionId: SESSION_ID, path: 'control.txt' },
      { sameMachine: true }
    );

    expect(response).toMatchObject({ status: 'error', code: 'too_large' });
  });

  it('applies the caller-supplied maxBytes when it is stricter than the machine limit', async () => {
    const workspaceRoot = await makeDir('preview-ws-');
    await writeFile(path.join(workspaceRoot, 'medium.txt'), 'z'.repeat(100));
    const service = createService({ workspaceRoot });

    const response = await service.previewFile({
      v: 3,
      sessionId: SESSION_ID,
      path: 'medium.txt',
      maxBytes: 10,
    });

    expect(response).toMatchObject({ status: 'error', code: 'too_large', limitBytes: 10 });
  });

  it('rejects an absolute path outside every allowed root', async () => {
    const workspaceRoot = await makeDir('preview-ws-');
    const outside = await makeDir('preview-outside-');
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    const service = createService({ workspaceRoot });

    const response = await service.previewFile({
      v: 3,
      sessionId: SESSION_ID,
      path: path.join(outside, 'secret.txt'),
    });

    expect(response).toMatchObject({ status: 'error', code: 'path_not_allowed' });
  });

  it('lets the same-machine Electron preview read an arbitrary external file as readonly', async () => {
    const workspaceRoot = await makeDir('preview-ws-');
    const outside = await makeDir('preview-outside-');
    const filePath = path.join(outside, 'notes.md');
    await writeFile(filePath, '# Local note\n');
    const service = createService({ workspaceRoot });

    const response = await service.previewFile(
      {
        v: 3,
        sessionId: SESSION_ID,
        path: filePath,
      },
      { allowArbitraryPaths: true }
    );

    expect(response).toMatchObject({
      status: 'ok',
      path: await realpath(filePath),
      external: true,
      readonly: true,
      kind: 'text',
    });
  });

  it('reads an absolute path inside an allowed extra root and marks it external', async () => {
    const workspaceRoot = await makeDir('preview-ws-');
    const scratch = await makeDir('preview-scratch-');
    const filePath = path.join(scratch, 'plot.png');
    await writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
    const service = createService({ workspaceRoot, extraRoots: [scratch] });

    const response = await service.previewFile({
      v: 3,
      sessionId: SESSION_ID,
      path: filePath,
    });

    expect(response).toMatchObject({ status: 'ok', kind: 'binary', external: true });
  });

  it('rejects a symlink inside the workspace that escapes every allowed root', async () => {
    const workspaceRoot = await makeDir('preview-ws-');
    const outside = await makeDir('preview-outside-');
    await writeFile(path.join(outside, 'id_rsa'), 'PRIVATE KEY');
    await symlink(path.join(outside, 'id_rsa'), path.join(workspaceRoot, 'link'));
    const service = createService({ workspaceRoot });

    const response = await service.previewFile({ v: 3, sessionId: SESSION_ID, path: 'link' });

    expect(response).toMatchObject({ status: 'error', code: 'path_not_allowed' });
  });

  it('rejects a `..` traversal out of the workspace', async () => {
    const workspaceRoot = await makeDir('preview-ws-');
    await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
    const service = createService({ workspaceRoot });

    const response = await service.previewFile({
      v: 3,
      sessionId: SESSION_ID,
      path: '../../etc/passwd',
    });

    expect(response).toMatchObject({ status: 'error', code: 'path_not_allowed' });
  });

  it('reports a missing in-workspace file as not found', async () => {
    const workspaceRoot = await makeDir('preview-ws-');
    const service = createService({ workspaceRoot });

    const response = await service.previewFile({ v: 3, sessionId: SESSION_ID, path: 'gone.ts' });

    expect(response).toMatchObject({ status: 'error', code: 'file_not_found' });
  });

  it('does not leak existence of a missing file outside the allowed roots', async () => {
    const workspaceRoot = await makeDir('preview-ws-');
    const outside = await makeDir('preview-outside-');
    const service = createService({ workspaceRoot });

    const response = await service.previewFile({
      v: 3,
      sessionId: SESSION_ID,
      path: path.join(outside, 'never-existed.txt'),
    });

    expect(response).toMatchObject({ status: 'error', code: 'path_not_allowed' });
  });

  // The requested spelling and the on-disk spelling of one name disagree
  // routinely: an agent writes `Readme.md`, the file index stores NFC while the
  // disk holds NFD, a path picks up whitespace in transit. `code-collab/
  // open-text` resolved through all of that; File Preview v3 replaced it with a
  // raw `path.resolve`, which turned "the file is right there" into
  // `file_not_found`. These pin the resolution back — the four below them pin
  // that it stayed resolution and did not become authorization.
  it('opens a file whose on-disk name differs from the request only by letter case', async (ctx) => {
    const workspaceRoot = await makeDir('preview-ws-');
    await writeFile(path.join(workspaceRoot, 'README.md'), '# hi\n');
    // A volume that folds case resolves this in `open` itself, so the fallback
    // this test exists for never runs. Skipping says so out loud instead of
    // reporting a pass that proved nothing — the bug is real on case-sensitive
    // volumes (most Linux hosts, case-sensitive APFS), and that is where this
    // has to be run to mean anything.
    if (await foldsSpelling(workspaceRoot, 'README.md', 'readme.md')) {
      ctx.skip();
    }
    const service = createService({ workspaceRoot });

    const response = await service.previewFile({ v: 3, sessionId: SESSION_ID, path: 'readme.md' });

    // Reported back with the REAL spelling: the client uses this as the viewer
    // tab identity and to look the entry up in the file index.
    expect(response).toMatchObject({ status: 'ok', path: 'README.md', kind: 'text' });
  });

  it('reports the on-disk spelling of a name back, not the requested one', async () => {
    // Passes on both volume kinds by a different route, which is the point: a
    // case-insensitive volume corrects the spelling in `realpathSync.native`, a
    // case-sensitive one corrects it in the tolerant walk. Either way the
    // client must receive the real name, because it becomes the viewer tab
    // identity and the argument a later save is made with.
    const workspaceRoot = await makeDir('preview-ws-');
    await writeFile(path.join(workspaceRoot, 'README.md'), '# hi\n');
    const service = createService({ workspaceRoot });

    const response = await service.previewFile({ v: 3, sessionId: SESSION_ID, path: 'readme.md' });

    expect(response).toMatchObject({ status: 'ok', path: 'README.md' });
  });

  it('opens a file whose on-disk name differs from the request by Unicode normalization', async (ctx) => {
    const workspaceRoot = await makeDir('preview-ws-');
    const composed = 'café.md'.normalize('NFC');
    const decomposed = 'café.md'.normalize('NFD');
    await mkdir(path.join(workspaceRoot, 'docs'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'docs', decomposed), 'bonjour\n');
    if (await foldsSpelling(workspaceRoot, decomposed, composed)) {
      ctx.skip();
    }
    const service = createService({ workspaceRoot });

    const response = await service.previewFile({
      v: 3,
      sessionId: SESSION_ID,
      path: `docs/${composed}`,
    });

    expect(response).toMatchObject({ status: 'ok', kind: 'text' });
  });

  it('opens a file whose real name starts with a space instead of trimming it away', async () => {
    const workspaceRoot = await makeDir('preview-ws-');
    await writeFile(path.join(workspaceRoot, ' notes.md'), 'kept\n');
    const service = createService({ workspaceRoot });

    const response = await service.previewFile({ v: 3, sessionId: SESSION_ID, path: ' notes.md' });

    expect(response).toMatchObject({ status: 'ok', path: ' notes.md', kind: 'text' });
  });

  it('still tolerates whitespace a caller picked up around a normal path', async () => {
    const workspaceRoot = await makeDir('preview-ws-');
    await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'src/app.ts'), 'const a = 1;\n');
    const service = createService({ workspaceRoot });

    const response = await service.previewFile({
      v: 3,
      sessionId: SESSION_ID,
      path: '  src/app.ts  ',
    });

    expect(response).toMatchObject({ status: 'ok', path: 'src/app.ts' });
  });

  it('does not let a differently-cased request follow a symlink out of the workspace', async () => {
    const workspaceRoot = await makeDir('preview-ws-');
    const outside = await makeDir('preview-outside-');
    await writeFile(path.join(outside, 'id_rsa'), 'PRIVATE KEY');
    await symlink(outside, path.join(workspaceRoot, 'link'));
    const service = createService({ workspaceRoot });

    const response = await service.previewFile({
      v: 3,
      sessionId: SESSION_ID,
      path: 'LINK/id_rsa',
    });

    expect(response).toMatchObject({ status: 'error', code: 'path_not_allowed' });
  });

  it('does not let a differently-cased request escape through `..`', async () => {
    const workspaceRoot = await makeDir('preview-ws-');
    const outside = await makeDir('preview-outside-');
    await writeFile(path.join(outside, 'secret.txt'), 'PRIVATE');
    const service = createService({ workspaceRoot });

    const response = await service.previewFile({
      v: 3,
      sessionId: SESSION_ID,
      path: `../${path.basename(outside).toUpperCase()}/SECRET.TXT`,
    });

    expect(response).toMatchObject({ status: 'error', code: 'path_not_allowed' });
  });

  it('does not turn not-found vs not-allowed into an existence probe past the boundary', async () => {
    // A leading space keeps the verbatim candidate relative, so it resolves
    // INSIDE the workspace while the trimmed candidate is the absolute path
    // that actually escaped. If the classification step accepts any candidate
    // rather than requiring all of them, the two error codes then split on
    // whether the out-of-workspace file exists — an oracle over the whole
    // filesystem, which is exactly what this boundary exists to prevent.
    const workspaceRoot = await makeDir('preview-ws-');
    const outside = await makeDir('preview-outside-');
    await writeFile(path.join(outside, 'exists.txt'), 'SECRET');
    const service = createService({ workspaceRoot });

    const probe = async (name: string) =>
      await service.previewFile({
        v: 3,
        sessionId: SESSION_ID,
        path: ` ${path.join(outside, name)}`,
      });

    expect(await probe('exists.txt')).toMatchObject({ code: 'path_not_allowed' });
    expect(await probe('never-existed.txt')).toMatchObject({ code: 'path_not_allowed' });
  });

  it('rejects a directory', async () => {
    const workspaceRoot = await makeDir('preview-ws-');
    await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
    const service = createService({ workspaceRoot });

    const response = await service.previewFile({ v: 3, sessionId: SESSION_ID, path: 'src' });

    expect(response).toMatchObject({ status: 'error', code: 'not_a_file' });
  });

  it('propagates a workspace resolution failure as a typed error', async () => {
    const service = new FilePreviewService({
      resolveWorkspace: async () => ({
        ok: false,
        code: 'session_not_found',
        message: 'Session not found.',
      }),
      extraRoots: [],
    });

    const response = await service.previewFile({ v: 3, sessionId: SESSION_ID, path: 'a.ts' });

    expect(response).toMatchObject({ status: 'error', code: 'session_not_found' });
  });
});
