import {
  buildSessionFileApiUrl,
  buildSessionFileUploadMetadataHeaders,
  getSessionFileDownloadApiPath,
  getSessionFileMultipartAbortApiPath,
  getSessionFileMultipartCompleteApiPath,
  getSessionFileMultipartCreateApiPath,
  getSessionFileMultipartPartApiPath,
  getSessionFilePreviewApiPath,
  getSessionFileUploadApiPath,
  getSessionFilePartCount,
  isTextPreviewable,
  shouldUseSingleShotUpload,
  SESSION_FILE_MAX_SIZE_BYTES,
  SESSION_FILE_PART_SIZE_BYTES,
  SESSION_FILE_PREVIEW_SNIFF_BYTES,
  SessionInputBlockSchema,
  type SessionFilePayload,
  type SessionId,
  type WorkspaceId,
  IncrementalSha256,
} from '@lody/shared';
import { API_BASE_URL } from '@/lib';
import SessionFileSha256Worker from './session-file-sha256.worker?worker';

// Files use a single "add attachment" entry point with no extension/MIME
// allowlist (spec: "No file types are rejected or warned about"). Validation
// is limited to size + emptiness; safety is enforced at serving time.
// Returns a code (not display text) so the UI layer can translate it.
export type SessionFileValidationError = 'empty' | 'too-large';

export const SESSION_FILE_MAX_SIZE_MB = Math.floor(SESSION_FILE_MAX_SIZE_BYTES / (1024 * 1024));

export const validateSessionFile = (file: File): SessionFileValidationError | null => {
  if (file.size <= 0) {
    return 'empty';
  }
  if (file.size > SESSION_FILE_MAX_SIZE_BYTES) {
    return 'too-large';
  }
  return null;
};

export const buildSessionFileUploadUrl = (workspaceId: WorkspaceId): string =>
  buildSessionFileApiUrl(API_BASE_URL, getSessionFileUploadApiPath(workspaceId));

export const buildSessionFileDownloadUrl = (
  workspaceId: WorkspaceId,
  sessionId: SessionId,
  fileId: string
): string =>
  buildSessionFileApiUrl(
    API_BASE_URL,
    getSessionFileDownloadApiPath(workspaceId, sessionId, fileId)
  );

export const buildSessionFilePreviewUrl = (
  workspaceId: WorkspaceId,
  sessionId: SessionId,
  fileId: string
): string =>
  buildSessionFileApiUrl(
    API_BASE_URL,
    getSessionFilePreviewApiPath(workspaceId, sessionId, fileId)
  );

// --- Text-previewability (computed before upload) ---------------------------

/**
 * Run the shared text-previewability rule against a file by reading its first
 * `SESSION_FILE_PREVIEW_SNIFF_BYTES`. Pure with respect to the shared rule set;
 * the only side effect is the bounded prefix read.
 */
export const computeTextPreviewable = async (file: File): Promise<boolean> => {
  const prefix = file.slice(0, SESSION_FILE_PREVIEW_SNIFF_BYTES);
  const buffer = await prefix.arrayBuffer();
  return isTextPreviewable(file.name, file.type || undefined, new Uint8Array(buffer));
};

// --- sha256 -----------------------------------------------------------------

export const SESSION_FILE_HASH_CHUNK_SIZE_BYTES = 4 * 1024 * 1024;

export type SessionFileTransferPhase = 'preparing' | 'uploading' | 'verifying';

export const isSessionFileTransferPhase = (status: string): status is SessionFileTransferPhase =>
  status === 'preparing' || status === 'uploading' || status === 'verifying';

export type SessionFileTransferProgress = {
  phase: SessionFileTransferPhase;
  percent: number;
  loadedBytes: number;
  totalBytes: number;
};

type ComputeSha256Options = {
  signal?: AbortSignal;
  onProgress?: (progress: SessionFileTransferProgress) => void;
};

type HashWorkerResponse =
  | { type: 'progress'; loadedBytes: number; totalBytes: number }
  | { type: 'complete'; sha256: string }
  | { type: 'error'; message: string };

const toPercent = (loadedBytes: number, totalBytes: number): number => {
  const ratio = totalBytes > 0 ? loadedBytes / totalBytes : 0;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
};

const reportPreparingProgress = (
  options: ComputeSha256Options,
  loadedBytes: number,
  totalBytes: number
): void => {
  options.onProgress?.({
    phase: 'preparing',
    percent: toPercent(loadedBytes, totalBytes),
    loadedBytes,
    totalBytes,
  });
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw new UploadAbortedError();
  }
};

export const computeSha256HexInChunks = async (
  file: Blob,
  options: ComputeSha256Options = {}
): Promise<string> => {
  const hasher = new IncrementalSha256();
  reportPreparingProgress(options, 0, file.size);
  for (let offset = 0; offset < file.size; offset += SESSION_FILE_HASH_CHUNK_SIZE_BYTES) {
    throwIfAborted(options.signal);
    const end = Math.min(offset + SESSION_FILE_HASH_CHUNK_SIZE_BYTES, file.size);
    const buffer = await file.slice(offset, end).arrayBuffer();
    throwIfAborted(options.signal);
    hasher.update(new Uint8Array(buffer));
    reportPreparingProgress(options, end, file.size);
    // Keep the no-Worker fallback responsive between bounded chunks.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return hasher.digestHex();
};

/**
 * Compute the canonical whole-file SHA-256 without creating an O(file size)
 * ArrayBuffer in the WebView. The worker reads one bounded Blob slice at a time;
 * environments without Worker support use the same chunked algorithm inline.
 */
export const computeSha256Hex = async (
  file: File,
  options: ComputeSha256Options = {}
): Promise<string> => {
  throwIfAborted(options.signal);
  if (typeof Worker === 'undefined') {
    return await computeSha256HexInChunks(file, options);
  }

  reportPreparingProgress(options, 0, file.size);
  return await new Promise<string>((resolve, reject) => {
    const hashWorker = new SessionFileSha256Worker();
    const cleanup = () => {
      options.signal?.removeEventListener('abort', onAbort);
      hashWorker.terminate();
    };
    const onAbort = () => {
      cleanup();
      reject(new UploadAbortedError());
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    hashWorker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || 'File hash worker failed'));
    };
    hashWorker.onmessage = (event: MessageEvent<HashWorkerResponse>) => {
      const message = event.data;
      if (message.type === 'progress') {
        reportPreparingProgress(options, message.loadedBytes, message.totalBytes);
        return;
      }
      cleanup();
      if (message.type === 'complete') {
        resolve(message.sha256);
      } else {
        reject(new Error(message.message));
      }
    };
    hashWorker.postMessage({ file, chunkSizeBytes: SESSION_FILE_HASH_CHUNK_SIZE_BYTES });
  });
};

// --- Upload -----------------------------------------------------------------

const MAX_PART_ATTEMPTS = 3;

export type SessionFileUploadProgress = SessionFileTransferProgress;

export type UploadSessionFileArgs = {
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  token: string;
  file: File;
  /** Precomputed by the caller (composer computes once for the pending card). */
  sha256: string;
  textPreview: boolean;
  onProgress?: (progress: SessionFileUploadProgress) => void;
  /** Aborting rejects the in-flight upload; multipart uploads are also aborted server-side. */
  signal?: AbortSignal;
};

class UploadAbortedError extends Error {
  constructor() {
    super('File upload aborted');
    this.name = 'UploadAbortedError';
  }
}

export const isUploadAbortedError = (error: unknown): boolean =>
  error instanceof UploadAbortedError ||
  (error instanceof DOMException && error.name === 'AbortError');

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UploadAbortedError());
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(new UploadAbortedError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Validate an upload/complete response body (either `{ file: <block> }` or the
 * block at top level) into a `SessionFilePayload`. Throws on mismatch.
 */
const parseSessionFilePayload = (body: unknown): SessionFilePayload => {
  if (!body || typeof body !== 'object') {
    throw new Error('Invalid upload response');
  }
  const fileValue = 'file' in body ? (body as { file?: unknown }).file : body;
  const parsed = SessionInputBlockSchema.safeParse(fileValue);
  if (!parsed.success || parsed.data.type !== 'file') {
    throw new Error('Invalid upload payload');
  }
  const data = parsed.data;
  return {
    type: 'file',
    fileId: data.fileId,
    fileName: data.fileName,
    mimeType: data.mimeType,
    sizeBytes: data.sizeBytes,
    sha256: data.sha256,
    textPreview: data.textPreview,
    transport: data.transport,
    ...(typeof data.machineId === 'string' ? { machineId: data.machineId } : {}),
    uploadedAt: data.uploadedAt,
  };
};

const parseFileResponse = async (response: Response): Promise<SessionFilePayload> => {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return parseSessionFilePayload(body);
};

const errorFromResponse = async (response: Response): Promise<Error> => {
  let message = response.statusText;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (body && typeof body === 'object' && 'error' in body && body.error) {
      message = String(body.error);
    }
  } catch {
    // keep statusText
  }
  return new Error(message || `Upload failed with status ${response.status}`);
};

const buildUploadMetadataHeaders = (
  args: Pick<UploadSessionFileArgs, 'sessionId' | 'file' | 'sha256' | 'textPreview'>
): Record<string, string> =>
  buildSessionFileUploadMetadataHeaders({
    sessionId: args.sessionId,
    fileName: args.file.name,
    mimeType: args.file.type,
    sha256: args.sha256,
    sizeBytes: args.file.size,
    textPreview: args.textPreview,
  });

const uploadSingleShot = async (args: UploadSessionFileArgs): Promise<SessionFilePayload> => {
  const { workspaceId, file, token, onProgress, signal } = args;
  onProgress?.({ phase: 'uploading', percent: 0, loadedBytes: 0, totalBytes: file.size });

  // XHR (not fetch) for upload progress events.
  return await new Promise<SessionFilePayload>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', buildSessionFileUploadUrl(workspaceId));
    request.responseType = 'json';
    request.setRequestHeader('Authorization', `Bearer ${token}`);
    for (const [name, value] of Object.entries(buildUploadMetadataHeaders(args))) {
      request.setRequestHeader(name, value);
    }

    const onAbort = () => request.abort();
    if (signal) {
      if (signal.aborted) {
        reject(new UploadAbortedError());
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    request.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const ratio = event.total > 0 ? event.loaded / event.total : 0;
      onProgress?.({
        phase: 'uploading',
        percent: Math.max(0, Math.min(100, Math.round(ratio * 100))),
        loadedBytes: event.loaded,
        totalBytes: event.total,
      });
    };
    request.upload.onload = () => {
      onProgress?.({
        phase: 'verifying',
        percent: 100,
        loadedBytes: file.size,
        totalBytes: file.size,
      });
    };
    request.onerror = () => {
      cleanup();
      reject(new Error('File upload failed'));
    };
    request.onabort = () => {
      cleanup();
      reject(new UploadAbortedError());
    };
    request.onload = () => {
      cleanup();
      if (request.status < 200 || request.status >= 300) {
        const response = request.response as { error?: unknown } | null;
        const message =
          response && typeof response === 'object' && 'error' in response
            ? String(response.error ?? '')
            : request.statusText;
        reject(new Error(message || `Upload failed with status ${request.status}`));
        return;
      }
      let payload: SessionFilePayload;
      try {
        payload = parseSessionFilePayload(request.response);
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Invalid upload response'));
        return;
      }
      onProgress?.({
        phase: 'verifying',
        percent: 100,
        loadedBytes: file.size,
        totalBytes: file.size,
      });
      resolve(payload);
    };

    request.send(file);
  });
};

type MultipartPartResult = { partNumber: number; etag: string };

const uploadPart = async (args: {
  url: string;
  token: string;
  sessionId: SessionId;
  fileId: string;
  partNumber: number;
  blob: Blob;
  signal?: AbortSignal;
  onProgress: (loadedBytes: number) => void;
}): Promise<MultipartPartResult> =>
  await new Promise<MultipartPartResult>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', args.url);
    request.responseType = 'json';
    request.setRequestHeader('Authorization', `Bearer ${args.token}`);
    request.setRequestHeader('x-session-id', args.sessionId);
    request.setRequestHeader('x-file-id', args.fileId);
    request.setRequestHeader('x-file-part-size-bytes', String(args.blob.size));

    const onAbort = () => request.abort();
    if (args.signal?.aborted) {
      reject(new UploadAbortedError());
      return;
    }
    args.signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => args.signal?.removeEventListener('abort', onAbort);

    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        args.onProgress(Math.min(args.blob.size, event.loaded));
      }
    };
    request.onerror = () => {
      cleanup();
      reject(new Error(`Failed to upload part ${args.partNumber}`));
    };
    request.onabort = () => {
      cleanup();
      reject(new UploadAbortedError());
    };
    request.onload = () => {
      cleanup();
      if (request.status < 200 || request.status >= 300) {
        const response = request.response as { error?: unknown } | null;
        const message = response?.error ? String(response.error) : request.statusText;
        reject(new Error(message || `Upload failed with status ${request.status}`));
        return;
      }
      const response = request.response as { etag?: unknown } | null;
      if (!response || typeof response.etag !== 'string' || response.etag.length === 0) {
        reject(new Error(`Part ${args.partNumber} response did not include an etag`));
        return;
      }
      args.onProgress(args.blob.size);
      resolve({ partNumber: args.partNumber, etag: response.etag });
    };
    request.send(args.blob);
  });

const uploadPartWithRetry = async (
  args: UploadSessionFileArgs,
  uploadId: string,
  fileId: string,
  partNumber: number,
  blob: Blob,
  reportPartProgress: (partNumber: number, loadedBytes: number) => void
): Promise<MultipartPartResult> => {
  const { workspaceId, sessionId, token, signal } = args;
  const url = buildSessionFileApiUrl(
    API_BASE_URL,
    getSessionFileMultipartPartApiPath(workspaceId, uploadId, partNumber)
  );

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_PART_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) {
      throw new UploadAbortedError();
    }
    try {
      return await uploadPart({
        url,
        token,
        sessionId,
        fileId,
        partNumber,
        blob,
        signal,
        onProgress: (loadedBytes) => reportPartProgress(partNumber, loadedBytes),
      });
    } catch (error) {
      if (isUploadAbortedError(error)) {
        throw new UploadAbortedError();
      }
      lastError = error;
      if (attempt < MAX_PART_ATTEMPTS) {
        // Exponential backoff: 250ms, 500ms before the final attempt.
        await sleep(250 * 2 ** (attempt - 1), signal);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Failed to upload part ${partNumber}`);
};

const uploadMultipart = async (args: UploadSessionFileArgs): Promise<SessionFilePayload> => {
  const { workspaceId, sessionId, token, file, onProgress, signal } = args;
  const totalBytes = file.size;
  const partCount = getSessionFilePartCount(totalBytes);
  onProgress?.({ phase: 'uploading', percent: 0, loadedBytes: 0, totalBytes });

  // 1. create — declared metadata travels in the same x-* headers as the
  // single-shot upload; the response assigns the fileId that part/complete/
  // abort must echo back (the server rebuilds the R2 key from it).
  const createResponse = await fetch(
    buildSessionFileApiUrl(API_BASE_URL, getSessionFileMultipartCreateApiPath(workspaceId)),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        ...buildUploadMetadataHeaders(args),
      },
      signal,
    }
  );
  if (!createResponse.ok) {
    throw await errorFromResponse(createResponse);
  }
  const createBody = (await createResponse.json()) as { uploadId?: unknown; fileId?: unknown };
  const uploadId =
    createBody && typeof createBody.uploadId === 'string' ? createBody.uploadId : null;
  const fileId = createBody && typeof createBody.fileId === 'string' ? createBody.fileId : null;
  if (!uploadId || !fileId) {
    throw new Error('Invalid multipart create response');
  }

  let displayedLoadedBytes = 0;
  const reportPartProgress = (partNumber: number, partLoadedBytes: number) => {
    const committedBeforePart = (partNumber - 1) * SESSION_FILE_PART_SIZE_BYTES;
    displayedLoadedBytes = Math.max(
      displayedLoadedBytes,
      Math.min(totalBytes, committedBeforePart + partLoadedBytes)
    );
    onProgress?.({
      phase: 'uploading',
      percent: toPercent(displayedLoadedBytes, totalBytes),
      loadedBytes: displayedLoadedBytes,
      totalBytes,
    });
  };

  try {
    // 2. upload parts sequentially (1-based). Sequential keeps peak memory and
    // progress accounting simple; concurrent part uploads were not worth the
    // complexity for a ≤7-part ceiling.
    const parts: MultipartPartResult[] = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      const start = (partNumber - 1) * SESSION_FILE_PART_SIZE_BYTES;
      const end = Math.min(start + SESSION_FILE_PART_SIZE_BYTES, totalBytes);
      const blob = file.slice(start, end);
      const result = await uploadPartWithRetry(
        args,
        uploadId,
        fileId,
        partNumber,
        blob,
        reportPartProgress
      );
      parts.push(result);
    }

    // 3. complete (server verifies sha256 + total size)
    onProgress?.({
      phase: 'verifying',
      percent: 100,
      loadedBytes: totalBytes,
      totalBytes,
    });
    const completeResponse = await fetch(
      buildSessionFileApiUrl(
        API_BASE_URL,
        getSessionFileMultipartCompleteApiPath(workspaceId, uploadId)
      ),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'x-session-id': sessionId,
          'x-file-id': fileId,
        },
        body: JSON.stringify({ parts }),
        signal,
      }
    );
    if (!completeResponse.ok) {
      throw await errorFromResponse(completeResponse);
    }
    const payload = await parseFileResponse(completeResponse);
    onProgress?.({
      phase: 'verifying',
      percent: 100,
      loadedBytes: totalBytes,
      totalBytes,
    });
    return payload;
  } catch (error) {
    // The transfer owns bounded cleanup; its scope cannot finish before it.
    // The server still owns expiry if cleanup itself cannot reach it.
    await fetch(
      buildSessionFileApiUrl(
        API_BASE_URL,
        getSessionFileMultipartAbortApiPath(workspaceId, uploadId)
      ),
      {
        method: 'DELETE',
        signal: AbortSignal.timeout(5_000),
        headers: {
          Authorization: `Bearer ${token}`,
          'x-session-id': sessionId,
          'x-file-id': fileId,
        },
      }
    ).catch(() => {});
    throw error;
  }
};

/**
 * Upload a session file attachment over the cloud (R2) path. Routes to the
 * single-shot endpoint for small files and multipart (with per-part auto
 * retry) for large ones. Returns the server-confirmed `SessionFilePayload`
 * (the caller persists this into the `file` input block).
 */
export const uploadSessionFile = async (
  args: UploadSessionFileArgs
): Promise<SessionFilePayload> => {
  // Defensive re-check; the composer validates (and translates) before upload.
  const validationError = validateSessionFile(args.file);
  if (validationError === 'empty') {
    throw new Error(`File is empty: ${args.file.name}`);
  }
  if (validationError === 'too-large') {
    throw new Error(`File must be <= ${SESSION_FILE_MAX_SIZE_MB}MB: ${args.file.name}`);
  }
  if (shouldUseSingleShotUpload(args.file.size)) {
    return await uploadSingleShot(args);
  }
  return await uploadMultipart(args);
};
