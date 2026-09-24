import type { LocalFilePreviewResource } from '@lody/shared/local-file-preview';
import { createLocalPagedFileSource } from './paged-file-source';
import {
  CODE_COLLAB_V2_TEXT_LIMITS,
  type CodeCollabFileSourceState,
  type CodeCollabRole,
  type CodeCollabV2AllChangesState,
  type CodeCollabV2DiffSnapshot,
  type CodeCollabV2EncodedTextPayload,
  type CodeCollabV2Error,
  type CodeCollabV2FileDigest,
  type CodeCollabV2FileTreeState,
  type CodeCollabV2FileTreeValue,
  type CodeCollabV2LspUnsupported,
  type CodeCollabV2OpenAllChangesDiffResponse,
  type CodeCollabV2OpenCurrentDiffResponse,
  type CodeCollabV2OpenTextOk,
  type CodeCollabV2OpenTurnDiffResponse,
  type CodeCollabV2RefreshTextResponse,
  type CodeCollabV2SaveTextResponse,
  type CodeCollabV2TextFormat,
  type FilePreviewV3Digest,
  type FilePreviewV3ErrorCode,
  type FilePreviewV3Response,
  type SessionId,
} from '@lody/shared';
import { SaveTextConflictError, SaveTextTransientError } from './code-collab-save-errors';
import type {
  SessionFileAllChangesDiffEntry,
  SessionFileAllChangesDiffResult,
  SessionFileChangedFilesResult,
  SessionFileDiffResult,
  SessionFileOpenResult,
  SessionFileProvider,
  SessionFileProviderEntry,
  SessionFileProviderMode,
  SessionFileSnapshot,
  SessionFileProviderState,
} from './session-file-provider';

const CODE_COLLAB_V2_UNAVAILABLE_MESSAGE = 'Code Collab v2 file browsing is unavailable.';
export const CODE_COLLAB_OPEN_TEXT_CACHE_MAX_BYTES = 75 * 1024 * 1024;

export type ParsedFileMetadataSnapshot = {
  readonly files: readonly SessionFileProviderEntry[];
  readonly sourceState?: CodeCollabFileSourceState;
  readonly updatedAtMs?: number;
};

export type CodeCollabSessionFileProviderRuntime = {
  readonly sessionId: SessionId;
  /**
   * File Preview v3 — the read path behind `openFile`. Always resolves; a
   * transport failure arrives as `status: 'error'`.
   */
  previewFile(
    path: string,
    knownDigest?: FilePreviewV3Digest
  ): Promise<FilePreviewV3Response | LocalFilePreviewResource | null>;
  /** Retained for `saveText`'s digest bookkeeping and older provider callers. */
  openText(path: string): Promise<CodeCollabV2OpenTextOk | CodeCollabV2Error | null>;
  refreshText(
    path: string,
    digest: CodeCollabV2FileDigest
  ): Promise<CodeCollabV2RefreshTextResponse | CodeCollabV2Error | null>;
  saveText(
    path: string,
    baseDigest: CodeCollabV2FileDigest,
    text: CodeCollabV2EncodedTextPayload,
    format?: CodeCollabV2TextFormat
  ): Promise<CodeCollabV2SaveTextResponse | CodeCollabV2Error | null>;
  openCurrentDiff(
    path: string
  ): Promise<CodeCollabV2OpenCurrentDiffResponse | CodeCollabV2Error | null>;
  openAllChangesDiff(
    focusPath?: string
  ): Promise<CodeCollabV2OpenAllChangesDiffResponse | CodeCollabV2Error | null>;
  openTurnDiff(
    path: string,
    turnId: string
  ): Promise<CodeCollabV2OpenTurnDiffResponse | CodeCollabV2Error | null>;
  initDirectory(path: string): Promise<{ readonly status: 'ok' } | CodeCollabV2Error | null>;
  lspDefinition(
    path: string,
    position: { readonly line: number; readonly character: number }
  ): Promise<CodeCollabV2LspUnsupported | CodeCollabV2Error | null>;
  lspReferences(
    path: string,
    position: { readonly line: number; readonly character: number }
  ): Promise<CodeCollabV2LspUnsupported | CodeCollabV2Error | null>;
};

export type CodeCollabSessionFileProviderCache = {
  getFiles(): readonly SessionFileProviderEntry[] | null;
  setFiles(files: readonly SessionFileProviderEntry[]): void;
  getMetadata(): ParsedFileMetadataSnapshot | null;
  setMetadata(metadata: ParsedFileMetadataSnapshot): void;
  clear(): void;
};

export function createCodeCollabSessionFileProviderMemoryCache(): CodeCollabSessionFileProviderCache {
  let files: readonly SessionFileProviderEntry[] | null = null;
  let metadata: ParsedFileMetadataSnapshot | null = null;
  return {
    getFiles: () => files,
    setFiles: (nextFiles) => {
      files = [...nextFiles];
    },
    getMetadata: () => metadata,
    setMetadata: (nextMetadata) => {
      metadata = nextMetadata;
      files = [...nextMetadata.files];
    },
    clear: () => {
      files = null;
      metadata = null;
    },
  };
}

export type CodeCollabSessionFileProviderOptions = {
  readonly runtime?: CodeCollabSessionFileProviderRuntime;
  readonly role?: CodeCollabRole;
  readonly sourceState?: CodeCollabFileSourceState;
  readonly files?: readonly SessionFileProviderEntry[];
  readonly fileTree?: CodeCollabV2FileTreeState;
  readonly allChanges?: CodeCollabV2AllChangesState;
  readonly updatedAtMs?: number;
  readonly historicalTurnId?: string;
  readonly cache?: CodeCollabSessionFileProviderCache;
  readonly textState?: CodeCollabSessionFileProviderTextState;
  readonly message?: string;
};

export type CodeCollabSessionOpenTextCacheEntry = {
  readonly digest: CodeCollabV2FileDigest;
  readonly text: string;
  readonly rawBytes?: number;
  readonly format?: CodeCollabV2TextFormat;
  /**
   * Every cache key this entry is stored under, when there is more than one.
   * Set by `openFile` when the machine resolved a different on-disk spelling
   * than the request; `saveText` refreshes all of them, so a later
   * `checkTextChanged` under either spelling sees the post-save digest instead
   * of reporting our own save as an external change.
   */
  readonly cacheKeys?: readonly string[];
};

type SaveConflictCacheEntry = {
  readonly path: string;
  readonly userText: string;
  readonly diskDigest?: CodeCollabV2FileDigest;
  readonly diskText?: string;
  readonly format?: CodeCollabV2TextFormat;
};

export type CodeCollabSessionFileProviderTextState = {
  readonly openCache: CodeCollabSessionOpenTextCache;
  readonly conflictCache: Map<string, SaveConflictCacheEntry>;
  readonly textSubscribers: Map<string, Set<(text: string) => void>>;
};

export type CodeCollabSessionFileProviderTextStateOptions = {
  readonly maxOpenTextCacheBytes?: number;
};

export class CodeCollabSessionOpenTextCache {
  private readonly entries = new Map<string, CodeCollabSessionOpenTextCacheEntry>();
  private readonly bytesByPath = new Map<string, number>();
  private totalBytes = 0;

  constructor(readonly maxBytes: number = CODE_COLLAB_OPEN_TEXT_CACHE_MAX_BYTES) {}

  get byteSize(): number {
    return this.totalBytes;
  }

  get size(): number {
    return this.entries.size;
  }

  get(path: string): CodeCollabSessionOpenTextCacheEntry | undefined {
    const entry = this.entries.get(path);
    if (!entry) return undefined;
    this.entries.delete(path);
    this.entries.set(path, entry);
    return entry;
  }

  set(path: string, entry: CodeCollabSessionOpenTextCacheEntry): void {
    this.delete(path);
    const bytes = estimateOpenCacheEntryBytes(entry);
    if (bytes > this.maxBytes) return;
    this.entries.set(path, entry);
    this.bytesByPath.set(path, bytes);
    this.totalBytes += bytes;
    this.evictOldestEntries();
  }

  delete(path: string): boolean {
    const existed = this.entries.delete(path);
    if (!existed) return false;
    this.totalBytes -= this.bytesByPath.get(path) ?? 0;
    this.bytesByPath.delete(path);
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.bytesByPath.clear();
    this.totalBytes = 0;
  }

  private evictOldestEntries(): void {
    while (this.totalBytes > this.maxBytes) {
      const oldestPath = this.entries.keys().next().value as string | undefined;
      if (oldestPath === undefined) break;
      this.delete(oldestPath);
    }
  }
}

export function createCodeCollabSessionFileProviderTextState(
  options: CodeCollabSessionFileProviderTextStateOptions = {}
): CodeCollabSessionFileProviderTextState {
  return {
    openCache: new CodeCollabSessionOpenTextCache(options.maxOpenTextCacheBytes),
    conflictCache: new Map<string, SaveConflictCacheEntry>(),
    textSubscribers: new Map<string, Set<(text: string) => void>>(),
  };
}

export type CodeCollabTextChangeCheckResult =
  | {
      readonly status: 'up_to_date';
      readonly path: string;
      readonly digest: CodeCollabV2FileDigest;
    }
  | {
      readonly status: 'changed';
      readonly path: string;
      readonly digest?: CodeCollabV2FileDigest;
      readonly reason?: CodeCollabV2Error['code'];
      readonly message?: string;
    }
  | {
      readonly status: 'unavailable';
      readonly path: string;
      readonly reason: CodeCollabV2Error['code'] | 'not_open' | 'metadata_only' | 'transient_io';
      readonly message?: string;
    };

const sharedTextEncoder = new TextEncoder();

function getUtf8ByteLength(text: string): number {
  return sharedTextEncoder.encode(text).byteLength;
}

function estimateOpenCacheEntryBytes(entry: CodeCollabSessionOpenTextCacheEntry): number {
  return entry.rawBytes ?? getUtf8ByteLength(entry.text);
}

export class CodeCollabSessionFileProvider implements SessionFileProvider {
  readonly kind = 'code-collab';
  readonly supportsHistoricalDiffs: boolean;
  private readonly runtime?: CodeCollabSessionFileProviderRuntime;
  private readonly role: CodeCollabRole;
  private readonly sourceState: CodeCollabFileSourceState;
  private readonly message?: string;
  private readonly files: readonly SessionFileProviderEntry[];
  private readonly allChanges: CodeCollabV2AllChangesState;
  private readonly openCache: CodeCollabSessionOpenTextCache;
  private readonly conflictCache: Map<string, SaveConflictCacheEntry>;
  private readonly textSubscribers: Map<string, Set<(text: string) => void>>;

  constructor(options: CodeCollabSessionFileProviderOptions = {}) {
    this.runtime = options.runtime;
    this.supportsHistoricalDiffs = options.runtime !== undefined;
    this.role = options.role ?? 'read';
    this.sourceState =
      options.sourceState ?? resolveCodeCollabSessionFileProviderSourceState(this.role);
    this.message = options.message;
    this.files =
      options.files ??
      codeCollabFileTreeToSessionFileEntries(options.fileTree ?? {}, this.sourceState);
    this.allChanges = options.allChanges ?? {};
    const textState = options.textState ?? createCodeCollabSessionFileProviderTextState();
    this.openCache = textState.openCache;
    this.conflictCache = textState.conflictCache;
    this.textSubscribers = textState.textSubscribers;
    options.cache?.setMetadata({
      files: this.files,
      sourceState: this.sourceState,
      updatedAtMs: options.updatedAtMs,
    });
  }

  getState(): SessionFileProviderState {
    return {
      kind: this.kind,
      ready: this.runtime !== undefined,
      sourceState: this.runtime === undefined ? 'degraded' : this.sourceState,
      ...(this.message === undefined ? {} : { message: this.message }),
    };
  }

  async listFiles(): Promise<readonly SessionFileProviderEntry[]> {
    return this.files;
  }

  subscribeFiles(callback: (files: readonly SessionFileProviderEntry[]) => void): () => void {
    callback(this.files);
    return () => undefined;
  }

  async searchFiles(query: string): Promise<readonly SessionFileProviderEntry[]> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return this.files;
    return this.files.filter((file) => file.path.toLowerCase().includes(normalized));
  }

  async getFile(pathOrFileId: string): Promise<SessionFileProviderEntry | null> {
    return this.findFile(pathOrFileId);
  }

  /**
   * Open a file for preview through File Preview v3.
   *
   * The file index is only a hint here: it tells us whether the path is a lazy
   * directory, and it seeds the entry shown while loading. It is deliberately NOT
   * a gate any more — a binary file, or a path the index has never seen (an
   * agent-produced temporary file, for instance), still goes to the machine,
   * which is the only authority on what the file actually is. The machine
   * answers with a plain read; it never activates Code Collab for a preview.
   */
  async openFile(
    pathOrFileId: string,
    _mode?: SessionFileProviderMode
  ): Promise<SessionFileOpenResult> {
    const path = this.resolvePath(pathOrFileId);
    const indexed = this.findFile(pathOrFileId) ?? textEntry(path, this.sourceState);
    if (!this.runtime) {
      return unavailable(
        indexed,
        'metadata-only',
        this.message ?? CODE_COLLAB_V2_UNAVAILABLE_MESSAGE
      );
    }
    if (indexed.entryType === 'lazy-directory') {
      return unavailable(indexed, 'metadata-only', 'Open the directory to load its children.');
    }

    const cached = this.openCache.get(path);
    const response = await this.runtime.previewFile(path, cached?.digest);
    if (!response) {
      return unavailable(indexed, 'transient-io', 'File preview request timed out.');
    }
    if (response.status === 'error') {
      return unavailable(
        indexed,
        filePreviewErrorCodeToUnavailableReason(response.code),
        response.message ?? response.code
      );
    }
    if (response.status === 'resource') {
      // Paged content must never seed save-text's full-document conflict cache.
      for (const key of new Set([
        path,
        response.path,
        ...(cached?.cacheKeys ?? []),
        ...(this.openCache.get(response.path)?.cacheKeys ?? []),
      ]))
        this.openCache.delete(key);
      return {
        status: 'ready',
        entry: {
          ...indexed,
          path: response.path,
          fileId: response.path,
          kind: response.kind,
          sizeBytes: response.sizeBytes,
          readonly: true,
        },
        snapshot:
          response.kind === 'text'
            ? {
                kind: 'paged-text',
                source: createLocalPagedFileSource(response.url, response.sizeBytes),
              }
            : { kind: 'binary', url: response.url },
      };
    }
    if (response.status === 'unchanged') {
      return {
        status: 'ready',
        entry: { ...indexed, readonly: indexed.readonly || response.external === true },
        snapshot: {
          kind: 'text',
          text: cached?.text ?? '',
          eol: cached?.format?.eol,
        },
      };
    }

    const entry: SessionFileProviderEntry = {
      ...indexed,
      path: response.path,
      fileId: response.path,
      kind: response.kind === 'binary' ? 'binary' : 'text',
      sizeBytes: response.sizeBytes,
      // Preview reads a WIDER set of paths than save-text writes: preview also
      // serves the temp/scratch roots, while `save-text` refuses anything outside
      // the session workspace. An `external` file is therefore readonly no matter
      // what the index says — otherwise the editor offers a Save that the machine
      // is guaranteed to reject, and the user loses the edit. Binary is readonly
      // for the ordinary reason: there is no text editor for it.
      readonly: response.kind === 'binary' || response.external === true ? true : indexed.readonly,
    };

    if (response.kind === 'binary') {
      if (response.content.encoding !== 'base64') {
        return unavailable(
          entry,
          'unsupported-encoding',
          'Binary preview arrived with a text encoding.'
        );
      }
      // Binary is never put in the text open cache: that cache backs save-text
      // conflict detection, and there is no text to conflict on.
      this.openCache.delete(path);
      this.openCache.delete(response.path);
      return {
        status: 'ready',
        entry,
        snapshot: {
          kind: 'binary',
          bytes: base64ToUint8Array(response.content.data),
          ...(response.mimeType === undefined ? {} : { mimeType: response.mimeType }),
        },
      };
    }

    const text = await decodeFilePreviewText(response);
    const format: CodeCollabV2TextFormat | undefined =
      response.format === undefined
        ? undefined
        : {
            encoding: 'utf8',
            ...(response.format.bom === undefined ? {} : { bom: response.format.bom }),
            ...(response.format.eol === undefined ? {} : { eol: response.format.eol }),
          };
    // Cache under BOTH spellings when the machine resolved a different one.
    //
    // `response.path` is required: it becomes `entry.fileId` above, so it is
    // what `saveText` is later called with, and keying only by the request made
    // save report "Open the file before saving it." for a file open on screen.
    // The requested path is required too: the viewer tab keeps the spelling it
    // was opened with (`session-detail.tsx` refreshes a tab's `fileId` from the
    // file INDEX, which never learns the resolved name), so `checkTextChanged`
    // and the next `openFile` still arrive with the original. Dropping that key
    // silently disables the external-change pre-check and re-downloads the file
    // on every re-open, because no `knownDigest` can be sent.
    const cacheKeys = path === response.path ? undefined : [response.path, path];
    const cacheEntry = {
      digest: response.digest,
      text,
      rawBytes: response.content.rawBytes,
      ...(format === undefined ? {} : { format }),
      ...(cacheKeys === undefined ? {} : { cacheKeys }),
    };
    for (const key of cacheKeys ?? [response.path]) {
      this.openCache.set(key, cacheEntry);
    }
    return {
      status: 'ready',
      entry: {
        ...entry,
        ...(format?.eol === undefined ? {} : { textEol: format.eol }),
        ...(format?.bom === undefined ? {} : { hasBom: format.bom }),
      },
      snapshot: {
        kind: 'text',
        text,
        ...(format?.eol === undefined ? {} : { eol: format.eol }),
      },
    };
  }

  async initializeDirectory(directoryId: string): Promise<void> {
    if (!this.runtime) {
      throw new Error(this.message ?? CODE_COLLAB_V2_UNAVAILABLE_MESSAGE);
    }
    const path = this.resolvePath(directoryId);
    const response = await this.runtime.initDirectory(path);
    if (!response) {
      throw new Error('Code Collab directory request timed out.');
    }
    if (isCodeCollabV2Error(response)) {
      throw new Error(response.message ?? response.code);
    }
  }

  async checkTextChanged(pathOrFileId: string): Promise<CodeCollabTextChangeCheckResult> {
    const path = this.resolvePath(pathOrFileId);
    if (!this.runtime) {
      return {
        status: 'unavailable',
        path,
        reason: 'metadata_only',
        message: this.message ?? CODE_COLLAB_V2_UNAVAILABLE_MESSAGE,
      };
    }
    const cached = this.openCache.get(path);
    if (!cached) {
      return {
        status: 'unavailable',
        path,
        reason: 'not_open',
        message: 'Open the file before checking for remote changes.',
      };
    }

    const response = await this.runtime.refreshText(path, cached.digest);
    if (!response) {
      return {
        status: 'unavailable',
        path,
        reason: 'transient_io',
        message: 'Code Collab request timed out.',
      };
    }
    if (isCodeCollabV2Error(response)) {
      if (response.retryable === true) {
        return {
          status: 'unavailable',
          path,
          reason: response.code,
          message: response.message ?? response.code,
        };
      }
      return {
        status: 'changed',
        path,
        reason: response.code,
        message: response.message ?? response.code,
      };
    }
    if (response.status === 'up_to_date') {
      return { status: 'up_to_date', path, digest: cached.digest };
    }
    return {
      status: 'changed',
      path: response.path,
      digest: response.digest,
    };
  }

  async saveText(pathOrFileId: string, text: string): Promise<SessionFileOpenResult> {
    if (!this.runtime) {
      return unavailable(
        undefined,
        'metadata-only',
        this.message ?? CODE_COLLAB_V2_UNAVAILABLE_MESSAGE
      );
    }
    const path = this.resolvePath(pathOrFileId);
    const entry = this.findFile(pathOrFileId) ?? textEntry(path, this.sourceState);
    const cached = this.openCache.get(path);
    if (!cached) {
      return unavailable(entry, 'metadata-only', 'Open the file before saving it.');
    }
    const payload = await encodeTextPayload(text);
    const response = await this.runtime.saveText(path, cached.digest, payload, cached.format);
    if (!response) {
      throw new SaveTextTransientError('Code Collab save timed out.');
    }
    if (isCodeCollabV2Error(response)) {
      if (response.retryable) {
        throw new SaveTextTransientError(response.message ?? response.code);
      }
      return codeCollabErrorToOpenResult(entry, response);
    }
    if (response.status === 'conflict') {
      const diskText = response.diskText ? await decodeTextPayload(response.diskText) : undefined;
      const conflictId = crypto.randomUUID();
      this.conflictCache.set(conflictId, {
        path,
        userText: text,
        diskDigest: response.diskDigest,
        diskText,
        format: cached.format,
      });
      throw new SaveTextConflictError(response.reason, conflictId);
    }
    // Refresh EVERY key the open stored this entry under, not just the one the
    // save was addressed to. The viewer tab keeps the requested spelling while
    // `entry.fileId` carries the machine's, so after a save through the fileId a
    // `checkTextChanged` with the tab spelling would otherwise find the pre-save
    // digest and report our own save as an external change.
    const savedEntry = {
      digest: response.digest,
      text,
      rawBytes: payload.rawBytes,
      format: cached.format,
      ...(cached.cacheKeys === undefined ? {} : { cacheKeys: cached.cacheKeys }),
    };
    for (const key of cached.cacheKeys ?? [path]) {
      this.openCache.set(key, savedEntry);
    }
    this.emitText(path, text);
    return {
      status: 'ready',
      entry,
      snapshot: { kind: 'text', text, eol: cached.format?.eol },
    };
  }

  subscribeText(pathOrFileId: string, callback: (text: string) => void): () => void {
    const path = this.resolvePath(pathOrFileId);
    let subscribers = this.textSubscribers.get(path);
    if (!subscribers) {
      subscribers = new Set();
      this.textSubscribers.set(path, subscribers);
    }
    subscribers.add(callback);
    return () => {
      subscribers?.delete(callback);
      if (subscribers?.size === 0) {
        this.textSubscribers.delete(path);
      }
    };
  }

  async resolveSaveConflict(
    _pathOrFileId: string,
    params: {
      readonly conflictId: string;
      readonly resolution: 'override' | 'discard' | 'load_with_conflicts';
    }
  ): Promise<void> {
    const conflict = this.conflictCache.get(params.conflictId);
    if (!conflict || !this.runtime) {
      throw new Error('Conflict state is no longer available.');
    }
    if (params.resolution === 'discard') {
      if (conflict.diskText !== undefined) {
        this.emitText(conflict.path, conflict.diskText);
      }
      this.conflictCache.delete(params.conflictId);
      return;
    }
    if (!conflict.diskDigest) {
      throw new Error('Conflict cannot be resolved without the latest disk digest.');
    }
    if (params.resolution === 'load_with_conflicts') {
      if (conflict.diskText === undefined) {
        throw new Error('Conflict markers require the latest disk text.');
      }
      const text = buildConflictMarkerText(conflict.diskText, conflict.userText);
      this.openCache.set(conflict.path, {
        digest: conflict.diskDigest,
        text,
        rawBytes: getUtf8ByteLength(text),
        format: conflict.format,
      });
      this.emitText(conflict.path, text);
      this.conflictCache.delete(params.conflictId);
      return;
    }
    const payload = await encodeTextPayload(conflict.userText);
    const response = await this.runtime.saveText(
      conflict.path,
      conflict.diskDigest,
      payload,
      conflict.format
    );
    if (!response || isCodeCollabV2Error(response) || response.status !== 'ok') {
      throw new Error('Conflict resolution failed.');
    }
    this.openCache.set(conflict.path, {
      digest: response.digest,
      text: conflict.userText,
      rawBytes: payload.rawBytes,
      format: conflict.format,
    });
    this.emitText(conflict.path, conflict.userText);
    this.conflictCache.delete(params.conflictId);
  }

  async getDiff(pathOrFileId: string, turnId?: string): Promise<SessionFileDiffResult> {
    const path = this.resolvePath(pathOrFileId);
    if (!this.runtime) {
      return {
        status: 'unavailable',
        path,
        reason: 'metadata-only',
        message: this.message ?? CODE_COLLAB_V2_UNAVAILABLE_MESSAGE,
      };
    }
    if (turnId) {
      return await this.getTurnDiff(path, turnId);
    }
    const response = await this.runtime.openCurrentDiff(path);
    if (!response) {
      return {
        status: 'unavailable',
        path,
        reason: 'transient-io',
        message: 'Code Collab current diff request timed out.',
      };
    }
    if (isCodeCollabV2Error(response)) {
      return {
        status: 'unavailable',
        path: response.path ?? path,
        reason: errorCodeToUnavailableReason(response.code),
        message: response.message ?? response.code,
      };
    }
    if (response.status === 'unavailable') {
      return {
        status: 'unavailable',
        path: response.path,
        reason: currentDiffUnavailableReasonToContentReason(response.reason),
        message: response.message ?? response.reason,
      };
    }
    return {
      status: 'ready',
      path: response.path,
      oldSnapshot: await currentDiffSnapshotToFileWorkspaceSnapshot(response.oldSnapshot),
      newSnapshot: await currentDiffSnapshotToFileWorkspaceSnapshot(response.newSnapshot),
    };
  }

  private async getTurnDiff(path: string, turnId: string): Promise<SessionFileDiffResult> {
    if (!this.runtime) {
      return {
        status: 'unavailable',
        path,
        reason: 'metadata-only',
        message: this.message ?? CODE_COLLAB_V2_UNAVAILABLE_MESSAGE,
      };
    }
    const response = await this.runtime.openTurnDiff(path, turnId);
    if (!response) {
      return {
        status: 'unavailable',
        path,
        reason: 'transient-io',
        message: 'Code Collab turn diff request timed out.',
      };
    }
    if (isCodeCollabV2Error(response)) {
      return {
        status: 'unavailable',
        path: response.path ?? path,
        reason: errorCodeToUnavailableReason(response.code),
        message: response.message ?? response.code,
      };
    }
    if (response.status === 'unavailable') {
      return {
        status: 'unavailable',
        path: response.path,
        reason: turnDiffUnavailableReasonToContentReason(response.reason),
        message: response.message ?? response.reason,
      };
    }
    return {
      status: 'ready',
      path: response.path,
      oldSnapshot: await currentDiffSnapshotToFileWorkspaceSnapshot(response.oldSnapshot),
      newSnapshot: await currentDiffSnapshotToFileWorkspaceSnapshot(response.newSnapshot),
    };
  }

  async listChangedFiles(): Promise<SessionFileChangedFilesResult> {
    return {
      status: 'ready',
      files: Object.entries(this.allChanges)
        .map(([path, value]) => {
          if (value === true) {
            return {
              path,
              fileId: path,
              kind: 'text' as const,
              sourceState: this.sourceState,
            };
          }
          return {
            path,
            fileId: path,
            kind: value.del === true ? ('deleted' as const) : ('text' as const),
            sourceState: this.sourceState,
            ...(value.diff === undefined ? {} : { add: value.diff[0], del: value.diff[1] }),
          };
        })
        .sort((left, right) => left.path.localeCompare(right.path)),
    };
  }

  async getAllChangesDiff(focusPath?: string): Promise<SessionFileAllChangesDiffResult> {
    if (!this.runtime) {
      return {
        status: 'unavailable',
        reason: 'metadata-only',
        message: this.message ?? CODE_COLLAB_V2_UNAVAILABLE_MESSAGE,
      };
    }
    const response = await this.runtime.openAllChangesDiff(focusPath);
    if (!response) {
      return {
        status: 'unavailable',
        reason: 'transient-io',
        message: 'Code Collab All Changes diff request timed out.',
      };
    }
    if (isCodeCollabV2Error(response)) {
      return {
        status: 'unavailable',
        reason: errorCodeToUnavailableReason(response.code),
        message: response.message ?? response.code,
      };
    }
    if (response.status === 'unavailable') {
      return {
        status: 'unavailable',
        reason: response.reason === 'transient_io' ? 'transient-io' : 'metadata-only',
        message: response.message ?? response.reason,
      };
    }
    const entries: SessionFileAllChangesDiffEntry[] = [];
    for (const entry of response.entries) {
      const stats = {
        ...(entry.add === undefined ? {} : { add: entry.add }),
        ...(entry.del === undefined ? {} : { del: entry.del }),
      };
      if (entry.status === 'deferred') {
        entries.push({ path: entry.path, ...stats, diff: { status: 'deferred' } });
        continue;
      }
      if (entry.status === 'unavailable') {
        entries.push({
          path: entry.path,
          ...stats,
          diff: { status: 'unavailable', path: entry.path, reason: 'metadata-only' },
        });
        continue;
      }
      entries.push({
        path: entry.path,
        ...stats,
        diff: {
          status: 'ready',
          path: entry.path,
          oldSnapshot: await currentDiffSnapshotToFileWorkspaceSnapshot(entry.oldSnapshot),
          newSnapshot: await currentDiffSnapshotToFileWorkspaceSnapshot(entry.newSnapshot),
        },
      });
    }
    return { status: 'ready', base: response.base, entries, truncated: response.truncated };
  }

  async requestLspDefinition(
    pathOrFileId: string,
    position: { readonly line: number; readonly character: number }
  ): Promise<unknown> {
    return await this.runtime?.lspDefinition(this.resolvePath(pathOrFileId), position);
  }

  async requestLspReferences(
    pathOrFileId: string,
    position: { readonly line: number; readonly character: number }
  ): Promise<unknown> {
    return await this.runtime?.lspReferences(this.resolvePath(pathOrFileId), position);
  }

  private findFile(pathOrFileId: string): SessionFileProviderEntry | null {
    return (
      this.files.find((file) => file.path === pathOrFileId || file.fileId === pathOrFileId) ?? null
    );
  }

  private resolvePath(pathOrFileId: string): string {
    return this.findFile(pathOrFileId)?.path ?? pathOrFileId;
  }

  private emitText(path: string, text: string): void {
    for (const callback of this.textSubscribers.get(path) ?? []) {
      callback(text);
    }
  }
}

export function resolveCodeCollabSessionFileProviderSourceState(
  role: CodeCollabRole
): CodeCollabFileSourceState {
  return role === 'read' ? 'live-readonly' : 'live-collaborative';
}

export function codeCollabFileTreeToSessionFileEntries(
  fileTree: CodeCollabV2FileTreeState,
  sourceState: CodeCollabFileSourceState
): readonly SessionFileProviderEntry[] {
  return Object.entries(fileTree)
    .map(([path, value]) => codeCollabFileTreeValueToSessionFileEntry(path, value, sourceState))
    .filter((entry): entry is SessionFileProviderEntry => entry !== null)
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function codeCollabFileTreeValueToSessionFileEntry(
  path: string,
  value: CodeCollabV2FileTreeValue,
  sourceState: CodeCollabFileSourceState
): SessionFileProviderEntry | null {
  if (value === true) {
    return textEntry(path, sourceState);
  }
  if (value.kind === 'lazy') {
    return {
      entryType: 'lazy-directory',
      directoryId: path,
      path,
      kind: 'special',
      sourceState,
      readonly: true,
      unavailableReason: 'metadata-only',
    };
  }
  if (value.kind === 'binary') {
    // No `unavailableReason`: since File Preview v3, binary files open. The row
    // must stay clickable (`canOpen` in `session-file-provider-view-model.ts` is
    // gated on this field), and the machine decides whether the bytes are
    // renderable.
    return {
      entryType: 'file',
      fileId: path,
      path,
      kind: 'binary',
      sourceState,
      readonly: true,
    };
  }
  if (value.kind === 'too_large') {
    return {
      entryType: 'file',
      fileId: path,
      path,
      kind: 'large',
      sourceState,
      readonly: true,
      sizeBytes: value.rawBytes,
      unavailableReason: 'text-too-large',
    };
  }
  return {
    entryType: 'file',
    fileId: path,
    path,
    kind: 'special',
    sourceState,
    readonly: true,
    unavailableReason: 'unsupported-special',
  };
}

function textEntry(path: string, sourceState: CodeCollabFileSourceState): SessionFileProviderEntry {
  return {
    entryType: 'file',
    fileId: path,
    path,
    kind: 'text',
    sourceState,
    readonly: sourceState !== 'live-collaborative',
  };
}

function unavailable(
  entry: SessionFileProviderEntry | undefined,
  reason: SessionFileOpenResult extends infer TResult
    ? TResult extends { status: 'unavailable'; reason: infer TReason }
      ? TReason
      : never
    : never,
  message?: string
): SessionFileOpenResult {
  return {
    status: 'unavailable',
    ...(entry === undefined ? {} : { entry }),
    reason,
    ...(message === undefined ? {} : { message }),
  };
}

function codeCollabErrorToOpenResult(
  entry: SessionFileProviderEntry,
  error: CodeCollabV2Error
): SessionFileOpenResult {
  return unavailable(entry, errorCodeToUnavailableReason(error.code), error.message ?? error.code);
}

type SessionFileUnavailableReason = SessionFileOpenResult extends infer TResult
  ? TResult extends { status: 'unavailable'; reason: infer TReason }
    ? TReason
    : never
  : never;

function filePreviewErrorCodeToUnavailableReason(
  code: FilePreviewV3ErrorCode
): SessionFileUnavailableReason {
  switch (code) {
    case 'permission_denied':
      return 'permission-denied';
    case 'too_large':
      return 'text-too-large';
    case 'file_not_found':
      return 'deleted';
    case 'decode_error':
      return 'unsupported-encoding';
    case 'not_a_file':
      return 'unsupported-special';
    // `path_not_allowed` deliberately maps to permission-denied rather than a new
    // reason: to the user it is "Lody is not allowed to read that", which is the
    // existing `outside-workspace` presentation in `session-file-error-state.tsx`.
    case 'path_not_allowed':
    case 'invalid_path':
      return 'permission-denied';
    case 'session_not_found':
    case 'workspace_root_unavailable':
      return 'metadata-only';
    case 'machine_offline':
    case 'transient_io':
      return 'transient-io';
  }
  const exhaustive: never = code;
  throw new Error(`Unsupported file preview error code: ${String(exhaustive)}`);
}

async function decodeFilePreviewText(
  response: Extract<FilePreviewV3Response, { status: 'ok' }>
): Promise<string> {
  const content = response.content;
  if (content.encoding === 'utf8-plain') {
    return content.text;
  }
  if (content.encoding !== 'utf8-gzip-base64') {
    throw new Error('File preview text payload has a binary encoding.');
  }
  const compressed = base64ToUint8Array(content.data);
  if (compressed.byteLength !== content.compressedBytes) {
    throw new Error('File preview compressed payload size mismatch.');
  }
  const bytes = await gzipDecode(compressed);
  if (bytes.byteLength !== content.rawBytes) {
    throw new Error('File preview payload size mismatch.');
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function errorCodeToUnavailableReason(
  code: CodeCollabV2Error['code']
): SessionFileOpenResult extends infer TResult
  ? TResult extends { status: 'unavailable'; reason: infer TReason }
    ? TReason
    : never
  : never {
  switch (code) {
    case 'permission_denied':
      return 'permission-denied';
    case 'too_large':
      return 'text-too-large';
    case 'unsupported_binary':
    case 'unsupported_skipped':
    case 'lsp_not_wired':
      return 'unsupported-special';
    case 'file_not_found':
      return 'deleted';
    case 'path_conflict':
      return 'path-collision';
    case 'decode_error':
      return 'unsupported-encoding';
    default:
      return 'transient-io';
  }
}

function currentDiffUnavailableReasonToContentReason(
  reason: Extract<CodeCollabV2OpenCurrentDiffResponse, { status: 'unavailable' }>['reason']
): SessionFileDiffResult extends infer TResult
  ? TResult extends { status: 'unavailable'; reason: infer TReason }
    ? TReason
    : never
  : never {
  switch (reason) {
    case 'base_unavailable':
    case 'not_changed':
      return 'metadata-only';
    case 'unsupported_binary':
      return 'unsupported-special';
    case 'transient_io':
      return 'transient-io';
  }
  const exhaustive: never = reason;
  throw new Error(`Unsupported current diff unavailable reason: ${String(exhaustive)}`);
}

function turnDiffUnavailableReasonToContentReason(
  reason: Extract<CodeCollabV2OpenTurnDiffResponse, { status: 'unavailable' }>['reason']
): SessionFileDiffResult extends infer TResult
  ? TResult extends { status: 'unavailable'; reason: infer TReason }
    ? TReason
    : never
  : never {
  switch (reason) {
    case 'turn_unavailable':
    case 'not_changed':
      return 'metadata-only';
    case 'transient_io':
      return 'transient-io';
  }
  const exhaustive: never = reason;
  throw new Error(`Unsupported turn diff unavailable reason: ${String(exhaustive)}`);
}

async function currentDiffSnapshotToFileWorkspaceSnapshot(
  snapshot: CodeCollabV2DiffSnapshot
): Promise<SessionFileSnapshot> {
  switch (snapshot.kind) {
    case 'text':
      return {
        kind: 'text',
        text: await decodeTextPayload(snapshot.text),
        eol: snapshot.format?.eol,
      };
    case 'missing':
      return { kind: 'unavailable', reason: 'deleted' };
    case 'binary':
      return { kind: 'binary' };
    case 'too_large':
      return { kind: 'unavailable', reason: 'text-too-large' };
  }
  const exhaustive: never = snapshot;
  throw new Error(`Unsupported Code Collab v2 diff snapshot: ${String(exhaustive)}`);
}

function buildConflictMarkerText(diskText: string, userText: string): string {
  return [
    '<<<<<<< disk',
    trimTrailingLineBreaks(diskText),
    '=======',
    trimTrailingLineBreaks(userText),
    '>>>>>>> local edits',
    '',
  ].join('\n');
}

function trimTrailingLineBreaks(text: string): string {
  return text.replace(/(?:\r\n|\r|\n)+$/u, '');
}

function isCodeCollabV2Error(value: unknown): value is CodeCollabV2Error {
  return (
    typeof value === 'object' && value !== null && 'status' in value && value.status === 'error'
  );
}

async function decodeTextPayload(payload: CodeCollabV2EncodedTextPayload): Promise<string> {
  if (payload.encoding === 'plain') {
    const bytes = new TextEncoder().encode(payload.text);
    if (bytes.byteLength !== payload.rawBytes) {
      throw new Error('Code Collab text payload size mismatch.');
    }
    return payload.text;
  }
  const compressed = base64ToUint8Array(payload.data);
  if (compressed.byteLength !== payload.compressedBytes) {
    throw new Error('Code Collab compressed payload size mismatch.');
  }
  const bytes = await gzipDecode(compressed);
  if (bytes.byteLength !== payload.rawBytes) {
    throw new Error('Code Collab text payload size mismatch.');
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function encodeTextPayload(text: string): Promise<CodeCollabV2EncodedTextPayload> {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= CODE_COLLAB_V2_TEXT_LIMITS.plainTextBytes) {
    return { encoding: 'plain', text, rawBytes: bytes.byteLength };
  }
  const compressed = await gzipEncode(bytes);
  if (compressed.byteLength > CODE_COLLAB_V2_TEXT_LIMITS.maxCompressedBytes) {
    throw new SaveTextTransientError('File is too large to save through Code Collab.');
  }
  return {
    encoding: 'gzip-base64',
    data: uint8ArrayToBase64(compressed),
    rawBytes: bytes.byteLength,
    compressedBytes: compressed.byteLength,
  };
}

async function gzipEncode(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([copyToArrayBuffer(bytes)])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gzipDecode(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([copyToArrayBuffer(bytes)])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
