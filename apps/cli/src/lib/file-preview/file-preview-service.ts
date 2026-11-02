import { resolveMarkdownFileLink } from '@lody/shared/node/file-link-resolution';
import type { LocalFileResolution } from '@lody/shared/local-file-preview';
import { createHash } from 'node:crypto';
import {
  FILE_DOWNLOAD_MAX_BYTES,
  FILE_DOWNLOAD_CHUNK_BYTES,
  FileDownloadRequestSchema,
  type FileDownloadRequest,
  type FileDownloadResponse,
} from '@lody/shared';
import { open, stat, realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import {
  FILE_PREVIEW_PROTOCOL_VERSION,
  FILE_PREVIEW_V3_LIMITS,
  filePreviewV3Error,
  getImageMimeTypeForPath,
  isBinaryImagePath,
  type FilePreviewV3Content,
  type FilePreviewV3Digest,
  type FilePreviewV3Limits,
  type FilePreviewV3Request,
  type FilePreviewV3Response,
  type FilePreviewV3TextFormat,
  type SessionId,
  type SessionFileRoot,
} from '@lody/shared';
import { formatErrorMessage } from '@/utils/format-error';
import {
  resolveFilePreviewPath,
  getDefaultFilePreviewExtraRoots,
  type FilePreviewPathPolicyOptions,
  type ResolvedPreviewPath,
  type FilePreviewIoFailure,
} from './file-preview-path-policy';

const gzipAsync = promisify(gzip);

/**
 * Resolves the session's workspace root. Same contract as the Code Collab
 * resolver so `MessageHandler` can hand over the one it already owns — preview
 * needs the root and the ownership check, and nothing else from Code Collab.
 */
export type FilePreviewWorkspaceResolver = (
  sessionId: SessionId,
  rootId?: string
) => Promise<
  | {
      readonly ok: true;
      readonly ownerSessionId: SessionId;
      readonly workspaceRoot: string;
      readonly fileRoots?: readonly SessionFileRoot[];
    }
  | {
      readonly ok: false;
      readonly code:
        | 'session_not_found'
        | 'workspace_root_unavailable'
        | 'permission_denied'
        | 'machine_offline'
        | 'transient_io';
      readonly message: string;
    }
>;

/** Local ownership is required even when the session's workspace is unavailable. */
export type FilePreviewLocalWorkspaceResolver = (
  sessionId: SessionId,
  rootId?: string
) => Promise<
  | {
      readonly ok: true;
      readonly ownerSessionId: SessionId;
      readonly workspaceRoot: string | null;
      readonly fileRoots?: readonly SessionFileRoot[];
    }
  | Extract<Awaited<ReturnType<FilePreviewWorkspaceResolver>>, { ok: false }>
>;

export type FilePreviewServiceOptions = {
  /** Encrypted readers cannot authorize Git subprocess discovery. */
  readonly allowGitDiscovery?: boolean;
  readonly onDiagnostic?: (event: Readonly<Record<string, unknown>>) => void;
  readonly resolveWorkspace: FilePreviewWorkspaceResolver;
  /** Explicit paid entitlement; unavailable billing never grants the larger transfer. */
  readonly canDownloadLargeFiles?: () => Promise<boolean>;
  readonly resolveLocalWorkspace: FilePreviewLocalWorkspaceResolver;
  readonly limits?: Partial<typeof FILE_PREVIEW_V3_LIMITS>;
  readonly pathPolicy?: FilePreviewPathPolicyOptions;
  /** Test seam: overrides the fixed extra roots entirely. */
  readonly extraRoots?: readonly string[];
};

/**
 * File Preview v3: read one file and return it.
 *
 * The whole point of this service is what it does NOT do. It never starts a
 * workspace watcher, never reconciles the file index, never recomputes All
 * Changes, and never publishes a Flock — previewing a file is a read, and
 * activating Code Collab for it turned one click into an O(workspace) job.
 * Keep it that way: if a future change needs shared state here, it belongs in
 * `CodeCollabV2Service`, not in this file.
 */
export class FilePreviewService {
  private readonly limits: typeof FILE_PREVIEW_V3_LIMITS;

  constructor(private readonly deps: FilePreviewServiceOptions) {
    this.limits = { ...FILE_PREVIEW_V3_LIMITS, ...deps.limits };
  }

  private resolvePath(
    request: FilePreviewV3Request,
    workspace: {
      readonly ownerSessionId: SessionId;
      readonly workspaceRoot: string | null;
      readonly fileRoots?: readonly SessionFileRoot[];
    },
    local: boolean
  ) {
    const failures: FilePreviewIoFailure[] = [];
    const result = resolveFilePreviewPath({
      workspaceRoot: workspace.workspaceRoot,
      requestedPath: request.path,
      extraRoots: this.deps.extraRoots,
      sessionRoots: workspace.fileRoots,
      options: {
        ...this.deps.pathPolicy,
        allowArbitraryPaths: local,
        onIoError: (failure) => {
          if (failures.length < 8) failures.push(failure);
        },
      },
    });
    this.deps.onDiagnostic?.({
      stage: 'resolve-path',
      transport: local ? 'local' : 'remote',
      sessionId: request.sessionId,
      ownerSessionId: workspace.ownerSessionId,
      requestedPath: request.path,
      workspaceRoot: workspace.workspaceRoot,
      ...(result.ok
        ? {
            status: 'ok',
            absolutePath: result.resolved.absolutePath,
            reportedPath: result.resolved.reportedPath,
            external: result.resolved.external,
          }
        : { status: 'error', code: result.rejection.code }),
      ...(failures.length ? { failures } : {}),
    });
    return result;
  }

  /** Local IPC resolves identity; Electron owns content IO and resource lifetime. */
  async resolveLocalFile(
    request: FilePreviewV3Request,
    expectedOwnerSessionId?: string
  ): Promise<LocalFileResolution | import('@lody/shared').FilePreviewV3Error> {
    const workspace = await this.deps.resolveLocalWorkspace(
      request.sessionId as SessionId,
      request.rootId
    );
    if (!workspace.ok) {
      this.deps.onDiagnostic?.({
        stage: 'resolve-workspace',
        transport: 'local',
        sessionId: request.sessionId,
        requestedPath: request.path,
        status: 'error',
        code: workspace.code,
      });
      return filePreviewV3Error(workspace.code, { message: workspace.message });
    }
    if (expectedOwnerSessionId && workspace.ownerSessionId !== expectedOwnerSessionId) {
      this.deps.onDiagnostic?.({
        stage: 'resolve-owner',
        transport: 'local',
        sessionId: request.sessionId,
        requestedPath: request.path,
        expectedOwnerSessionId,
        ownerSessionId: workspace.ownerSessionId,
        status: 'error',
        code: 'permission_denied',
      });
      return filePreviewV3Error('permission_denied', {
        message: 'Local file preview owner session mismatch.',
        path: request.path,
      });
    }
    const resolution = this.resolvePath(request, workspace, true);
    if (!resolution.ok)
      return filePreviewV3Error(resolution.rejection.code, {
        message: resolution.rejection.message,
        path: request.path,
        retryable: resolution.rejection.code === 'transient_io',
      });
    return {
      status: 'local-file',
      path: resolution.resolved.reportedPath,
      absolutePath: resolution.resolved.absolutePath,
      external: resolution.resolved.external,
    };
  }

  async downloadFileChunk(input: FileDownloadRequest): Promise<FileDownloadResponse> {
    const parsed = FileDownloadRequestSchema.safeParse(input);
    if (!parsed.success) return { status: 'error', code: 'invalid_path' };
    const request = parsed.data;
    try {
      const workspace = await this.deps.resolveWorkspace(
        request.sessionId as SessionId,
        request.rootId
      );
      if (!workspace.ok) return { status: 'error', code: workspace.code };
      if (!(await this.deps.canDownloadLargeFiles?.()))
        return { status: 'error', code: 'paid_plan_required' };
      const resolution = this.resolvePath(
        { ...request, v: FILE_PREVIEW_PROTOCOL_VERSION },
        workspace,
        false
      );
      if (!resolution.ok) return { status: 'error', code: resolution.rejection.code };
      const resolved = resolution.resolved;
      const file = await open(resolved.absolutePath, 'r');
      try {
        const before = await file.stat({ bigint: true });
        // Recheck the canonical path after open so a replaced symlink cannot
        // turn a formerly allowed name into a read of a different file.
        const current = this.resolvePath(
          { ...request, v: FILE_PREVIEW_PROTOCOL_VERSION },
          workspace,
          false
        );
        if (
          !current.ok ||
          current.resolved.absolutePath !== resolved.absolutePath ||
          (await realpath(resolved.absolutePath)) !== resolved.absolutePath
        )
          return { status: 'error', code: 'path_not_allowed' };
        const currentStat = await stat(current.resolved.absolutePath, { bigint: true });
        if (currentStat.dev !== before.dev || currentStat.ino !== before.ino)
          return { status: 'error', code: 'file_changed' };
        if (!before.isFile()) return { status: 'error', code: 'not_a_file' };
        if (before.size > BigInt(FILE_DOWNLOAD_MAX_BYTES))
          return { status: 'error', code: 'too_large' };
        const revisionOf = (metadata: typeof before) =>
          createHash('sha256')
            .update(
              [
                resolved.absolutePath,
                metadata.dev,
                metadata.ino,
                metadata.size,
                metadata.mtimeNs,
                metadata.ctimeNs,
              ].join(':')
            )
            .digest('hex');
        const revision = revisionOf(before);
        if (request.revision && request.revision !== revision)
          return { status: 'error', code: 'file_changed' };
        const sizeBytes = Number(before.size);
        if (request.offset > sizeBytes) return { status: 'error', code: 'file_changed' };
        const bytes = Buffer.alloc(Math.min(FILE_DOWNLOAD_CHUNK_BYTES, sizeBytes - request.offset));
        let read = 0;
        while (read < bytes.length) {
          const result = await file.read(bytes, read, bytes.length - read, request.offset + read);
          if (result.bytesRead === 0) return { status: 'error', code: 'file_changed' };
          read += result.bytesRead;
        }
        if (revisionOf(await file.stat({ bigint: true })) !== revision)
          return { status: 'error', code: 'file_changed' };
        return {
          status: 'ok',
          path: resolved.reportedPath,
          revision,
          sizeBytes,
          offset: request.offset,
          data: bytes.toString('base64'),
        };
      } finally {
        await file.close();
      }
    } catch {
      return { status: 'error', code: 'transient_io' };
    }
  }

  async previewFile(request: FilePreviewV3Request): Promise<FilePreviewV3Response> {
    if (request.resolveMarkdownLink && this.deps.allowGitDiscovery === false)
      return filePreviewV3Error('unsupported_protocol', {
        message:
          'Markdown worktree discovery is unavailable for encrypted read queries. Open an explicit file path.',
        path: request.path,
      });
    const limits = this.limits;
    const workspace = await this.deps.resolveWorkspace(
      request.sessionId as SessionId,
      request.rootId
    );
    if (!workspace.ok) {
      this.deps.onDiagnostic?.({
        stage: 'resolve-workspace',
        transport: 'remote',
        sessionId: request.sessionId,
        requestedPath: request.path,
        status: 'error',
        code: workspace.code,
      });
      return filePreviewV3Error(workspace.code, {
        message: workspace.message,
        path: request.path,
        retryable: workspace.code === 'transient_io' || workspace.code === 'machine_offline',
      });
    }

    if (request.resolveMarkdownLink)
      return resolveMarkdownFileLink({
        workspaceRoot: workspace.workspaceRoot,
        requestedPath: request.path,
        extraRoots: this.deps.extraRoots ?? getDefaultFilePreviewExtraRoots(this.deps.pathPolicy),
        options: this.deps.pathPolicy,
      });
    const resolution = this.resolvePath(request, workspace, false);
    if (!resolution.ok) {
      return filePreviewV3Error(resolution.rejection.code, {
        message: resolution.rejection.message,
        path: request.path,
        retryable: resolution.rejection.code === 'transient_io',
      });
    }

    const resolved = resolution.resolved;
    // Decide the budget from the file NAME before reading: a known RASTER image
    // extension gets the binary budget, everything else the text budget. A file
    // that turns out to be binary content under a text-looking name is still
    // handled below — it just has to fit the (larger) text budget.
    //
    // `isBinaryImagePath`, not `getImageMimeTypeForPath`: the latter also matches
    // SVG, which is XML text. Sending an `.svg` as base64 bytes would cost it the
    // source view and the editing it has today, so SVG must stay on the text path.
    const isImageByName = isBinaryImagePath(resolved.reportedPath);
    const limitBytes = Math.min(
      isImageByName ? limits.maxBinaryBytes : limits.maxTextBytes,
      request.maxBytes ?? Number.MAX_SAFE_INTEGER
    );
    if (resolved.sizeBytes > limitBytes) {
      return filePreviewV3Error('too_large', {
        message: 'File is too large to preview.',
        path: resolved.reportedPath,
        sizeBytes: resolved.sizeBytes,
        limitBytes,
      });
    }

    let bytes: Uint8Array;
    try {
      bytes = await readFileWithinLimit(resolved.absolutePath, limitBytes);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      this.deps.onDiagnostic?.({
        stage: 'read',
        transport: 'remote',
        sessionId: request.sessionId,
        ownerSessionId: workspace.ownerSessionId,
        requestedPath: request.path,
        absolutePath: resolved.absolutePath,
        status: 'error',
        code: code ?? 'UNKNOWN',
      });
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return filePreviewV3Error('file_not_found', {
          message: 'File was not found.',
          path: resolved.reportedPath,
        });
      }
      if (code === 'EACCES' || code === 'EPERM') {
        return filePreviewV3Error('permission_denied', {
          message: 'Permission denied.',
          path: resolved.reportedPath,
        });
      }
      if (code === 'EFBIG') {
        return filePreviewV3Error('too_large', {
          message: 'File grew past the preview limit while it was being read.',
          path: resolved.reportedPath,
          limitBytes,
        });
      }
      return filePreviewV3Error('transient_io', {
        message: formatErrorMessage(error),
        path: resolved.reportedPath,
        retryable: true,
      });
    }

    const digest = digestBytes(bytes);
    if (request.knownDigest === digest) {
      return {
        status: 'unchanged',
        v: FILE_PREVIEW_PROTOCOL_VERSION,
        path: resolved.reportedPath,
        ...(resolved.external ? { external: true } : {}),
        digest,
        sizeBytes: bytes.byteLength,
      };
    }

    // Binary detection is content-first: a NUL byte in the first 8 KiB means the
    // bytes are not text no matter what the extension claims. A known image
    // extension also forces the binary path so an image whose header happens to
    // avoid NULs still ships as bytes rather than as mojibake text.
    if (isImageByName || hasBinaryNul(bytes)) {
      return this.binaryOk(resolved, bytes, digest, limits);
    }

    let text: string;
    try {
      text = decodeUtf8(bytes);
    } catch {
      // Not valid UTF-8 and no NUL in the sniff window: still not previewable as
      // text, so hand it back as binary bytes and let the viewer decide.
      return this.binaryOk(resolved, bytes, digest, limits);
    }

    let content: FilePreviewV3Content;
    try {
      content = await this.encodeTextContent(bytes, text, limits);
    } catch (error) {
      return filePreviewV3Error('too_large', {
        message: formatErrorMessage(error),
        path: resolved.reportedPath,
        sizeBytes: bytes.byteLength,
        limitBytes: limits.maxCompressedBytes,
      });
    }

    return {
      status: 'ok',
      v: FILE_PREVIEW_PROTOCOL_VERSION,
      path: resolved.reportedPath,
      ...(resolved.external ? { external: true } : {}),
      digest,
      kind: 'text',
      content,
      format: detectTextFormat(bytes, text),
      sizeBytes: bytes.byteLength,
      // Preview never grants write access; saving stays on the Code Collab
      // save-text path, which runs its own owner/write authorization.
      readonly: true,
    };
  }

  private binaryOk(
    resolved: ResolvedPreviewPath,
    bytes: Uint8Array,
    digest: FilePreviewV3Digest,
    limits: FilePreviewV3Limits
  ): FilePreviewV3Response {
    if (bytes.byteLength > limits.maxBinaryBytes) {
      return filePreviewV3Error('too_large', {
        message: 'Binary file is too large to preview.',
        path: resolved.reportedPath,
        sizeBytes: bytes.byteLength,
        limitBytes: limits.maxBinaryBytes,
      });
    }
    const data = Buffer.from(bytes).toString('base64');
    const mimeType = getImageMimeTypeForPath(resolved.reportedPath);
    return {
      status: 'ok',
      v: FILE_PREVIEW_PROTOCOL_VERSION,
      path: resolved.reportedPath,
      ...(resolved.external ? { external: true } : {}),
      digest,
      kind: 'binary',
      content: { encoding: 'base64', data, rawBytes: bytes.byteLength },
      mimeType: mimeType ?? 'application/octet-stream',
      sizeBytes: bytes.byteLength,
      readonly: true,
    };
  }

  private async encodeTextContent(
    bytes: Uint8Array,
    text: string,
    limits: FilePreviewV3Limits
  ): Promise<FilePreviewV3Content> {
    if (bytes.byteLength <= limits.plainTextBytes) {
      return { encoding: 'utf8-plain', text, rawBytes: bytes.byteLength };
    }
    const compressed = await gzipAsync(bytes);
    if (compressed.byteLength > limits.maxCompressedBytes) {
      throw new Error(`Compressed preview payload exceeds ${limits.maxCompressedBytes} bytes.`);
    }
    return {
      encoding: 'utf8-gzip-base64',
      data: compressed.toString('base64'),
      rawBytes: bytes.byteLength,
      compressedBytes: compressed.byteLength,
    };
  }
}

/**
 * Read at most `limitBytes`. Reads one byte past the limit so a file that grew
 * between `stat` and `read` is reported as too large instead of silently
 * truncated — a truncated preview is a wrong preview, not a partial one.
 */
async function readFileWithinLimit(absolutePath: string, limitBytes: number): Promise<Uint8Array> {
  const handle = await open(absolutePath, 'r');
  try {
    const buffer = Buffer.alloc(limitBytes + 1);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset >= buffer.byteLength) break;
    }
    if (offset > limitBytes) {
      const error = new Error('File exceeds the preview limit.') as NodeJS.ErrnoException;
      error.code = 'EFBIG';
      throw error;
    }
    return new Uint8Array(buffer.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

function digestBytes(bytes: Uint8Array): FilePreviewV3Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

function detectTextFormat(bytes: Uint8Array, text: string): FilePreviewV3TextFormat {
  return {
    bom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
    eol: detectEol(text),
  };
}

function detectEol(text: string): FilePreviewV3TextFormat['eol'] {
  const crlfCount = text.match(/\r\n/gu)?.length ?? 0;
  const withoutCrlf = text.replace(/\r\n/gu, '');
  const lfCount = withoutCrlf.match(/\n/gu)?.length ?? 0;
  const crCount = withoutCrlf.match(/\r/gu)?.length ?? 0;
  if (crCount > 0 || (crlfCount > 0 && lfCount > 0)) return 'mixed';
  if (crlfCount > 0) return 'crlf';
  if (lfCount > 0) return 'lf';
  return 'unknown';
}

function hasBinaryNul(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.byteLength, 8 * 1024);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) return true;
  }
  return false;
}
