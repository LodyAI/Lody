import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import {
  FILE_PREVIEW_LOCAL_PAYLOAD_BUDGET_BYTES,
  FILE_PREVIEW_PROTOCOL_VERSION,
  FILE_PREVIEW_V3_LIMITS,
  FILE_PREVIEW_V3_LOCAL_LIMITS,
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
} from '@lody/shared';
import { formatErrorMessage } from '@/utils/format-error';
import {
  resolveFilePreviewPath,
  type FilePreviewPathPolicyOptions,
  type ResolvedPreviewPath,
} from './file-preview-path-policy';

const gzipAsync = promisify(gzip);

/**
 * Resolves the session's workspace root. Same contract as the Code Collab
 * resolver so `MessageHandler` can hand over the one it already owns — preview
 * needs the root and the ownership check, and nothing else from Code Collab.
 */
export type FilePreviewWorkspaceResolver = (sessionId: SessionId) => Promise<
  | {
      readonly ok: true;
      readonly ownerSessionId: SessionId;
      readonly workspaceRoot: string;
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

export type FilePreviewServiceOptions = {
  readonly resolveWorkspace: FilePreviewWorkspaceResolver;
  readonly limits?: Partial<typeof FILE_PREVIEW_V3_LIMITS>;
  readonly pathPolicy?: FilePreviewPathPolicyOptions;
  /** Test seam: overrides the fixed extra roots entirely. */
  readonly extraRoots?: readonly string[];
};

export type FilePreviewRequestOptions = {
  /**
   * Available exclusively to the Electron same-machine IPC handler. This is
   * intentionally transport context, not part of File Preview v3's request
   * schema, so a Loro Streams request can never widen its readable roots.
   */
  readonly allowArbitraryPaths?: boolean;
  /**
   * Same-machine IPC: the reply never crosses a network, so the transport-shaped
   * budgets (gzip ceiling, 10 MiB text) are replaced by `FILE_PREVIEW_V3_LOCAL_LIMITS`
   * and the text ships uncompressed. Same transport-only context as above — a
   * Streams request must never be able to ask for it.
   */
  readonly sameMachine?: boolean;
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

  async previewFile(
    request: FilePreviewV3Request,
    options: FilePreviewRequestOptions = {}
  ): Promise<FilePreviewV3Response> {
    // Explicit per-request limits rather than a second service instance: the
    // same session can be previewed over both transports.
    const limits = options.sameMachine
      ? { ...FILE_PREVIEW_V3_LOCAL_LIMITS, ...this.deps.limits }
      : this.limits;
    const workspace = await this.deps.resolveWorkspace(request.sessionId as SessionId);
    if (!workspace.ok) {
      return filePreviewV3Error(workspace.code, {
        message: workspace.message,
        path: request.path,
        retryable: workspace.code === 'transient_io' || workspace.code === 'machine_offline',
      });
    }

    const resolution = resolveFilePreviewPath({
      workspaceRoot: workspace.workspaceRoot,
      requestedPath: request.path,
      ...(this.deps.extraRoots === undefined ? {} : { extraRoots: this.deps.extraRoots }),
      options: {
        ...this.deps.pathPolicy,
        ...(options.allowArbitraryPaths ? { allowArbitraryPaths: true } : {}),
      },
    });
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
      return this.binaryOk(resolved, bytes, digest, limits, options.sameMachine === true);
    }

    let text: string;
    try {
      text = decodeUtf8(bytes);
    } catch {
      // Not valid UTF-8 and no NUL in the sniff window: still not previewable as
      // text, so hand it back as binary bytes and let the viewer decide.
      return this.binaryOk(resolved, bytes, digest, limits, options.sameMachine === true);
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

    // The same-machine reply still crosses one transport, and its client
    // DESTROYS a body past `FILE_PREVIEW_LOCAL_IPC_RESPONSE_LIMIT_BYTES` — which
    // surfaces as a retryable I/O error, not as this honest verdict. Size caps
    // cannot predict that for text (JSON escaping is data-dependent), so the
    // encoded payload is measured.
    const payloadOverflow = options.sameMachine
      ? measurePayloadOverflow(content, FILE_PREVIEW_LOCAL_PAYLOAD_BUDGET_BYTES)
      : null;
    if (payloadOverflow !== null) {
      return filePreviewV3Error('too_large', {
        message: 'File is too large to preview.',
        path: resolved.reportedPath,
        sizeBytes: bytes.byteLength,
        limitBytes: FILE_PREVIEW_LOCAL_PAYLOAD_BUDGET_BYTES,
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
    limits: FilePreviewV3Limits,
    sameMachine: boolean
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
    if (sameMachine && data.length > FILE_PREVIEW_LOCAL_PAYLOAD_BUDGET_BYTES) {
      return filePreviewV3Error('too_large', {
        message: 'Binary file is too large to preview.',
        path: resolved.reportedPath,
        sizeBytes: bytes.byteLength,
        limitBytes: FILE_PREVIEW_LOCAL_PAYLOAD_BUDGET_BYTES,
      });
    }
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
 * How much the encoded content overruns `budgetBytes`, or `null` when it fits.
 *
 * Text is measured through `JSON.stringify` because that is exactly what the
 * transport will do to it, and escaping is data-dependent — a file of newlines
 * doubles, one of control bytes sextuples, so no raw-size cap can stand in for
 * this. Base64 payloads are already the encoded string, so their length is the
 * answer. Only the same-machine path pays for this measurement.
 */
function measurePayloadOverflow(content: FilePreviewV3Content, budgetBytes: number): number | null {
  const encodedBytes =
    content.encoding === 'utf8-plain'
      ? Buffer.byteLength(JSON.stringify(content.text), 'utf8')
      : content.data.length;
  return encodedBytes > budgetBytes ? encodedBytes - budgetBytes : null;
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
