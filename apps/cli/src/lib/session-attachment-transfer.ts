import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { resolveContainedUploadPath } from './session-file-attachments';
import { formatErrorMessage } from '@/utils/format-error';
import {
  SessionInputBlockSchema,
  buildSessionImageApiUrl,
  getSessionImageUploadApiPath,
  getSessionImageDownloadApiPath,
  buildSessionFileApiUrl,
  buildSessionFileUploadMetadataHeaders,
  getSessionFileDownloadApiPath,
  getSessionFileUploadApiPath,
  getSessionFileMultipartCreateApiPath,
  getSessionFileMultipartPartApiPath,
  getSessionFileMultipartCompleteApiPath,
  getSessionFilePartCount,
  shouldUseSingleShotUpload,
  isTextPreviewable,
  SESSION_FILE_MAX_SIZE_BYTES,
  SESSION_FILE_PART_SIZE_BYTES,
  SESSION_FILE_PREVIEW_SNIFF_BYTES,
  SESSION_IMAGE_ALLOWED_MIME_TYPES,
  SESSION_IMAGE_MAX_SIZE_BYTES,
  type WorkspaceId,
  type SessionId,
  type SessionImageUploadResponse,
  type SessionFilePayload,
} from '@lody/shared';
export type UploadableImageFile = {
  absolutePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  // Bytes are read inside the validation function while the file is open with
  // O_NOFOLLOW. Carrying them to upload avoids a second `readFile` that would
  // re-open the path and follow a symlink swapped in after validation (TOCTOU).
  bytes: Buffer;
};

export type UploadedSessionImage = NonNullable<SessionImageUploadResponse['images']>[number];
export type ValidatedUploadFile = {
  absolutePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  textPreview: boolean;
};

export type UploadedSessionFile = SessionFilePayload & { downloadUrl: string };

const SESSION_FILE_MAX_PART_RETRIES = 3;

// Best-effort MIME type from a file extension for the agent-send path. The
// server treats this as advisory only; preview gating re-sniffs content.
const SESSION_FILE_MIME_TYPE_BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/plain',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

const DEFAULT_SESSION_FILE_MIME_TYPE = 'application/octet-stream';

// Backend multipart contract (backend/server/src/session-file-server.ts). Validated
// at the trust boundary since these are HTTP responses (cli-type-safety rule).
const MultipartCreateResponseSchema = z.object({
  success: z.literal(true),
  uploadId: z.string().min(1),
  fileId: z.string().min(1),
});
const MultipartPartResponseSchema = z.object({
  success: z.literal(true),
  partNumber: z.number().int(),
  etag: z.string().min(1),
});

const SESSION_IMAGE_MIME_TYPE_BY_EXTENSION: Record<
  string,
  (typeof SESSION_IMAGE_ALLOWED_MIME_TYPES)[number]
> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** Byte transport only. Never appends history or dispatches a turn. */
export class SessionAttachmentTransfer {
  constructor(
    private readonly token: string,
    private readonly serverBaseUrl?: string
  ) {}
  private resolveServerBaseUrl(): string {
    const url = this.serverBaseUrl?.trim();
    if (!url) throw new Error('cloud_attachment_upload_unavailable');
    return url.replace(/\/$/, '');
  }
  async validateSessionImageUploadPath(filePath: string): Promise<UploadableImageFile> {
    const trimmed = filePath.trim();
    if (!trimmed) {
      throw new Error('Image path is empty');
    }

    const absolutePath = path.resolve(trimmed);
    // O_NOFOLLOW makes the open() fail with ELOOP if the final path component is a
    // symlink. We then fstat / read through the same fd, so an attacker who swaps
    // the file after validation cannot redirect us at a different inode.
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(
        absolutePath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ELOOP') {
        throw new Error(`Image path must not be a symlink: ${filePath}`, { cause: error });
      }
      throw new Error(`Image file not found: ${filePath}`, { cause: error });
    }

    try {
      const stat = await handle.stat();

      if (!stat.isFile()) {
        throw new Error(`Image path is not a file: ${filePath}`);
      }

      if (stat.size <= 0) {
        throw new Error(`Image is empty: ${filePath}`);
      }

      if (stat.size > SESSION_IMAGE_MAX_SIZE_BYTES) {
        throw new Error(
          `Image must be <= ${Math.floor(SESSION_IMAGE_MAX_SIZE_BYTES / (1024 * 1024))}MB: ${filePath}`
        );
      }

      const fileName = path.basename(absolutePath);
      const extension = path.extname(fileName).slice(1).trim().toLowerCase();
      const mimeType = SESSION_IMAGE_MIME_TYPE_BY_EXTENSION[extension];
      if (!mimeType) {
        throw new Error(`Unsupported image file extension: ${fileName}`);
      }

      const bytes = await handle.readFile();

      return {
        absolutePath,
        fileName,
        mimeType,
        sizeBytes: stat.size,
        bytes,
      };
    } finally {
      await handle.close();
    }
  }

  async uploadSessionImageFile(args: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    file: UploadableImageFile;
  }): Promise<UploadedSessionImage> {
    const serverBaseUrl = this.resolveServerBaseUrl();
    const uploadUrl = buildSessionImageApiUrl(
      serverBaseUrl,
      getSessionImageUploadApiPath(args.workspaceId)
    );

    const formData = new FormData();
    formData.set('sessionId', args.sessionId);
    const fileBytes = new Uint8Array(args.file.bytes.byteLength);
    fileBytes.set(args.file.bytes);
    formData.set('file', new Blob([fileBytes], { type: args.file.mimeType }), args.file.fileName);

    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      const detail = errorBody ? `: ${errorBody.slice(0, 200)}` : '';
      throw new Error(`Failed to upload image (${response.status})${detail}`);
    }

    const responseBody = await response.json().catch(() => null);
    const parsed = SessionInputBlockSchema.safeParse(
      responseBody && typeof responseBody === 'object' && 'image' in responseBody
        ? (responseBody as Record<string, unknown>).image
        : undefined
    );
    if (!parsed.success || parsed.data.type !== 'image') {
      throw new Error('Invalid image upload payload');
    }

    const downloadUrl = buildSessionImageApiUrl(
      serverBaseUrl,
      getSessionImageDownloadApiPath(args.workspaceId, args.sessionId, parsed.data.imageId)
    );

    return {
      imageId: parsed.data.imageId,
      mimeType: parsed.data.mimeType,
      fileName: parsed.data.fileName,
      sizeBytes: parsed.data.sizeBytes,
      width: parsed.data.width,
      height: parsed.data.height,
      downloadUrl,
    };
  }

  async validateSessionFileUploadPath(
    filePath: string,
    options?: {
      /**
       * Reject paths outside this root (realpath-canonicalized, parent-symlink
       * safe). REQUIRED for the agent-facing MCP channel so the upload tool
       * cannot bypass the agent's own out-of-workspace read approval gate.
       * Omitted for the desktop local handoff, whose user-picked files are
       * staged in tmpdir by the user's own Electron process.
       */
      containWithin?: string;
    }
  ): Promise<ValidatedUploadFile> {
    const trimmed = filePath.trim();
    if (!trimmed) {
      throw new Error('File path is empty');
    }
    const absolutePath = options?.containWithin
      ? await resolveContainedUploadPath(trimmed, options.containWithin)
      : path.resolve(trimmed);

    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(
        absolutePath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ELOOP') {
        throw new Error(`File path must not be a symlink: ${filePath}`, { cause: error });
      }
      throw new Error(`File not found: ${filePath}`, { cause: error });
    }

    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new Error(`Path is not a file: ${filePath}`);
      }
      if (stat.size <= 0) {
        throw new Error(`File is empty: ${filePath}`);
      }
      if (stat.size > SESSION_FILE_MAX_SIZE_BYTES) {
        throw new Error(
          `File must be <= ${Math.floor(SESSION_FILE_MAX_SIZE_BYTES / (1024 * 1024))}MB: ${filePath}`
        );
      }

      const fileName = path.basename(absolutePath);
      const extension = path.extname(fileName).slice(1).trim().toLowerCase();
      const mimeType =
        SESSION_FILE_MIME_TYPE_BY_EXTENSION[extension] ?? DEFAULT_SESSION_FILE_MIME_TYPE;

      // Stream the file once: hash incrementally, capture the first 8 KB for the
      // text-preview sniff. Avoids reading the whole (up to 100 MB) file into RAM.
      const hash = crypto.createHash('sha256');
      const sniffPrefix = Buffer.alloc(SESSION_FILE_PREVIEW_SNIFF_BYTES);
      let sniffLength = 0;
      const stream = handle.createReadStream({ autoClose: false });
      for await (const chunk of stream) {
        const buf = chunk as Buffer;
        hash.update(buf);
        if (sniffLength < SESSION_FILE_PREVIEW_SNIFF_BYTES) {
          const take = Math.min(SESSION_FILE_PREVIEW_SNIFF_BYTES - sniffLength, buf.length);
          buf.copy(sniffPrefix, sniffLength, 0, take);
          sniffLength += take;
        }
      }

      const sha256 = hash.digest('hex');
      const textPreview = isTextPreviewable(
        fileName,
        mimeType,
        sniffPrefix.subarray(0, sniffLength)
      );

      return {
        absolutePath,
        fileName,
        mimeType,
        sizeBytes: stat.size,
        sha256,
        textPreview,
      };
    } finally {
      await handle.close();
    }
  }

  private buildSessionFileUploadHeaders(file: ValidatedUploadFile, sessionId: SessionId): Headers {
    const headers = new Headers(
      buildSessionFileUploadMetadataHeaders({
        sessionId,
        fileName: file.fileName,
        mimeType: file.mimeType,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        textPreview: file.textPreview,
      })
    );
    headers.set('Authorization', `Bearer ${this.token}`);
    return headers;
  }

  /** Parse the server's `{ success, file: SessionFilePayload }` upload response. */
  private parseUploadedFileResponse(
    body: unknown,
    serverBaseUrl: string,
    sessionId: SessionId,
    workspaceId: WorkspaceId
  ): UploadedSessionFile {
    const parsed = SessionInputBlockSchema.safeParse(
      body && typeof body === 'object' && 'file' in body
        ? (body as Record<string, unknown>).file
        : undefined
    );
    if (!parsed.success || parsed.data.type !== 'file') {
      throw new Error('Invalid file upload payload');
    }
    const downloadUrl = buildSessionFileApiUrl(
      serverBaseUrl,
      getSessionFileDownloadApiPath(workspaceId, sessionId, parsed.data.fileId)
    );
    return { ...parsed.data, downloadUrl };
  }

  private async uploadSessionFileSingleShot(args: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    file: ValidatedUploadFile;
    signal?: AbortSignal;
  }): Promise<UploadedSessionFile> {
    const serverBaseUrl = this.resolveServerBaseUrl();
    const uploadUrl = buildSessionFileApiUrl(
      serverBaseUrl,
      getSessionFileUploadApiPath(args.workspaceId)
    );

    const bytes = await fs.promises.readFile(args.file.absolutePath);
    const headers = this.buildSessionFileUploadHeaders(args.file, args.sessionId);
    headers.set('Content-Type', 'application/octet-stream');

    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers,
      body: bytes,
      signal: args.signal,
    });
    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      const detail = errorBody ? `: ${errorBody.slice(0, 200)}` : '';
      throw new Error(`Failed to upload file (${response.status})${detail}`);
    }
    const body = await response.json().catch(() => null);
    return this.parseUploadedFileResponse(body, serverBaseUrl, args.sessionId, args.workspaceId);
  }

  private async uploadSessionFileMultipart(args: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    file: ValidatedUploadFile;
    signal?: AbortSignal;
  }): Promise<UploadedSessionFile> {
    const serverBaseUrl = this.resolveServerBaseUrl();

    // 1. create
    const createUrl = buildSessionFileApiUrl(
      serverBaseUrl,
      getSessionFileMultipartCreateApiPath(args.workspaceId)
    );
    const createResponse = await fetch(createUrl, {
      method: 'POST',
      headers: this.buildSessionFileUploadHeaders(args.file, args.sessionId),
      signal: args.signal,
    });
    if (!createResponse.ok) {
      const errorBody = await createResponse.text().catch(() => '');
      const detail = errorBody ? `: ${errorBody.slice(0, 200)}` : '';
      throw new Error(`Failed to create multipart upload (${createResponse.status})${detail}`);
    }
    const createBody = MultipartCreateResponseSchema.safeParse(
      await createResponse.json().catch(() => null)
    );
    if (!createBody.success) {
      throw new Error('Invalid multipart create response');
    }
    const { uploadId, fileId } = createBody.data;

    // 2. upload parts (1-based), retrying each part up to N times.
    const partCount = getSessionFilePartCount(args.file.sizeBytes);
    const completedParts: Array<{ partNumber: number; etag: string }> = [];
    const handle = await fs.promises.open(args.file.absolutePath, 'r');
    try {
      for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
        const offset = (partNumber - 1) * SESSION_FILE_PART_SIZE_BYTES;
        const length = Math.min(SESSION_FILE_PART_SIZE_BYTES, args.file.sizeBytes - offset);
        const partBuffer = Buffer.alloc(length);
        // POSIX read may return fewer bytes than requested; loop until the
        // part buffer is full (a zero-filled tail would only fail later at the
        // server's sha256 verification, with a far less actionable error).
        let filled = 0;
        while (filled < length) {
          const { bytesRead } = await handle.read(
            partBuffer,
            filled,
            length - filled,
            offset + filled
          );
          if (bytesRead <= 0) {
            throw new Error(
              `Short read for part ${partNumber}: got ${filled} of ${length} bytes (file changed during upload?)`
            );
          }
          filled += bytesRead;
        }

        const partUrl = buildSessionFileApiUrl(
          serverBaseUrl,
          getSessionFileMultipartPartApiPath(args.workspaceId, uploadId, partNumber)
        );
        const partHeaders = new Headers();
        partHeaders.set('Authorization', `Bearer ${this.token}`);
        partHeaders.set('x-session-id', args.sessionId);
        partHeaders.set('x-file-id', fileId);
        partHeaders.set('x-file-part-size-bytes', String(length));
        partHeaders.set('Content-Type', 'application/octet-stream');

        let lastError: unknown = null;
        let uploaded = false;
        for (let attempt = 1; attempt <= SESSION_FILE_MAX_PART_RETRIES; attempt += 1) {
          try {
            const partResponse = await fetch(partUrl, {
              method: 'PUT',
              headers: partHeaders,
              body: partBuffer,
              signal: args.signal,
            });
            if (!partResponse.ok) {
              const errorBody = await partResponse.text().catch(() => '');
              throw new Error(
                `part ${partNumber} failed (${partResponse.status})${errorBody ? `: ${errorBody.slice(0, 120)}` : ''}`
              );
            }
            const partBody = MultipartPartResponseSchema.safeParse(
              await partResponse.json().catch(() => null)
            );
            if (!partBody.success) {
              throw new Error(`part ${partNumber} returned an invalid response`);
            }
            completedParts.push({ partNumber, etag: partBody.data.etag });
            uploaded = true;
            break;
          } catch (error) {
            lastError = error;
            // An aborted upload (backfill revoke) can never succeed on retry.
            if (args.signal?.aborted) {
              break;
            }
          }
        }
        if (!uploaded) {
          throw new Error(
            `Failed to upload part ${partNumber} after ${SESSION_FILE_MAX_PART_RETRIES} attempts: ${formatErrorMessage(lastError)}`
          );
        }
      }
    } finally {
      await handle.close();
    }

    // 3. complete
    const completeUrl = buildSessionFileApiUrl(
      serverBaseUrl,
      getSessionFileMultipartCompleteApiPath(args.workspaceId, uploadId)
    );
    const completeHeaders = new Headers();
    completeHeaders.set('Authorization', `Bearer ${this.token}`);
    completeHeaders.set('x-session-id', args.sessionId);
    completeHeaders.set('x-file-id', fileId);
    completeHeaders.set('Content-Type', 'application/json');
    const completeResponse = await fetch(completeUrl, {
      method: 'POST',
      headers: completeHeaders,
      body: JSON.stringify({ parts: completedParts }),
      signal: args.signal,
    });
    if (!completeResponse.ok) {
      const errorBody = await completeResponse.text().catch(() => '');
      const detail = errorBody ? `: ${errorBody.slice(0, 200)}` : '';
      throw new Error(`Failed to complete multipart upload (${completeResponse.status})${detail}`);
    }
    const completeBody = await completeResponse.json().catch(() => null);
    return this.parseUploadedFileResponse(
      completeBody,
      serverBaseUrl,
      args.sessionId,
      args.workspaceId
    );
  }

  async uploadValidatedSessionFile(args: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    file: ValidatedUploadFile;
    /** Cancels the relay upload mid-flight (backfill revoke, S5/D10). */
    signal?: AbortSignal;
  }): Promise<UploadedSessionFile> {
    if (shouldUseSingleShotUpload(args.file.sizeBytes)) {
      return await this.uploadSessionFileSingleShot(args);
    }
    return await this.uploadSessionFileMultipart(args);
  }
}
