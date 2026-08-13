import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import { FILE_PREVIEW_V3_LIMITS, type SessionId } from '@lody/shared';
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
