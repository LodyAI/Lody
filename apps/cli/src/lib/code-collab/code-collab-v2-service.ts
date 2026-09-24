import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod,
  lstat,
  opendir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import {
  CODE_COLLAB_V2_ALL_CHANGES_DIFF_LIMITS,
  CODE_COLLAB_V2_TEXT_LIMITS,
  getServerNow,
  buildCodeCollabFileIndexState,
  codeCollabFileIndexStatesEqual,
  type CodeCollabV2AllChangesDiffEntry,
  type CodeCollabV2AllChangesState,
  type CodeCollabV2AllChangesValue,
  type CodeCollabV2DiffSnapshot,
  type CodeCollabV2EncodedTextPayload,
  type CodeCollabV2Error,
  type CodeCollabV2ErrorCode,
  type CodeCollabV2FileIndexRequest,
  type CodeCollabV2FileIndexSnapshot,
  type CodeCollabV2FileTreeState,
  type CodeCollabV2FileTreeValue,
  type CodeCollabV2FileIndexState,
  type CodeCollabV2FileDigest,
  type CodeCollabV2InitDirectoryOk,
  type CodeCollabV2InitDirectoryRequest,
  type CodeCollabV2LspUnsupported,
  type CodeCollabV2OpenAllChangesDiffRequest,
  type CodeCollabV2OpenAllChangesDiffResponse,
  type CodeCollabV2OpenCurrentDiffRequest,
  type CodeCollabV2OpenCurrentDiffResponse,
  type CodeCollabV2OpenTextOk,
  type CodeCollabV2OpenTextRequest,
  type CodeCollabV2OpenTurnDiffRequest,
  type CodeCollabV2OpenTurnDiffResponse,
  type CodeCollabV2RefreshTextRequest,
  type CodeCollabV2RefreshTextResponse,
  type CodeCollabV2SaveTextRequest,
  type CodeCollabV2SaveTextResponse,
  type CodeCollabV2TextFormat,
  type SessionDiffStats,
  type SessionId,
} from '@lody/shared';
import { formatErrorMessage } from '@/utils/format-error';
import { getLogger } from '@/utils/logger';
import { mapWithConcurrency } from '@/lib/bounded-concurrency';
import { CodeCollabFileIndexChangedPublishError } from './code-collab-flock-publish';
import type { CodeCollabV2DiffStore } from './code-collab-v2-diff-store';
import { computeLineCountsAsync } from './diff-line-count-pool';
import { countTextLines } from './diff-line-counts';
import {
  computeFullFileIndexStateInWorker,
  scanDirectoryEntriesInWorker,
} from './file-index-scan-pool';
import { computeAllChanges, scanGitDirectoryEntries } from './file-index-scan-core';
import { closeDirectoryQuietly } from './directory-handle';
import { CODE_COLLAB_IGNORED_DIRECTORY_NAMES } from './workspace-watch-path-policy';
import type {
  WorkspaceWatchCoordinatorApi,
  WorkspaceWatchSubscription,
} from './workspace-watch-coordinator';

const execFileAsync = promisify(execFile);
// gzip/gunzip on libuv's threadpool instead of the sync variants: a large file's
// (de)compression must not block the single Node event loop, which would stall every
// other concurrent Machine RPC handler (open-file/refresh/diff) and the request loop.
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const ROOT_DIRECTORY_REQUEST_PATH = '.';
const DEFAULT_FILE_TREE_SCAN_ENTRY_BUDGET = 10_000;
export const DEFAULT_CODE_COLLAB_WATCH_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

type WorkspaceResolution =
  | {
      readonly ok: true;
      readonly ownerSessionId: SessionId;
      readonly workspaceRoot: string;
      readonly allChangesBaseBranch?: string;
    }
  | {
      readonly ok: false;
      readonly code:
        | 'session_not_found'
        | 'workspace_root_unavailable'
        | 'machine_offline'
        | 'permission_denied'
        | 'transient_io';
      readonly message: string;
    };

export type CodeCollabV2WorkspaceResolveOptions = {
  readonly access?: 'read' | 'write';
  readonly requestedByUserId?: string;
};

export type CodeCollabV2WorkspaceResolver = (
  sessionId: SessionId,
  options?: CodeCollabV2WorkspaceResolveOptions
) => Promise<WorkspaceResolution>;

export type CodeCollabV2FileIndexPublication = {
  readonly ownerSessionId: SessionId;
  readonly fileIndex: CodeCollabV2FileIndexState;
  readonly allChangesDiffStats: SessionDiffStats | null;
  readonly persistAllChangesDiffStats: boolean;
  readonly updatedAtMs: number;
  readonly reconcileRemote: boolean;
};

export type CodeCollabV2FileIndexPublishResult = {
  readonly changed: boolean;
};

export type CodeCollabV2FileIndexPublisher = (
  state: CodeCollabV2FileIndexPublication
) => Promise<CodeCollabV2FileIndexPublishResult | void>;

export type CodeCollabV2FileIndexSignalPublication = {
  readonly ownerSessionId: SessionId;
  readonly updatedAtMs: number;
};

export type CodeCollabV2FileIndexSignalPublisher = (
  state: CodeCollabV2FileIndexSignalPublication
) => Promise<void>;

export class CodeCollabV2ServiceError extends Error {
  readonly status = 'error' as const;

  constructor(
    readonly code: CodeCollabV2ErrorCode,
    message: string,
    readonly options: {
      readonly path?: string;
      readonly retryable?: boolean;
      readonly cause?: unknown;
    } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CodeCollabV2ServiceError';
  }

  toRpcError(): CodeCollabV2Error {
    return {
      status: 'error',
      code: this.code,
      message: this.message,
      ...(this.options.path === undefined ? {} : { path: this.options.path }),
      ...(this.options.retryable === undefined ? {} : { retryable: this.options.retryable }),
    };
  }
}

export function isCodeCollabV2ServiceError(error: unknown): error is CodeCollabV2ServiceError {
  return error instanceof CodeCollabV2ServiceError;
}

type StableRead = {
  readonly bytes: Uint8Array;
};

type InternalDiffSnapshot =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'binary' }
  | { readonly kind: 'too_large' };

type DiffStoreAllChangesSnapshotPair = {
  readonly oldSnapshot: InternalDiffSnapshot;
  readonly newSnapshot: InternalDiffSnapshot;
};

type AllChangesComputation = {
  readonly allChanges: CodeCollabV2AllChangesState;
  readonly source: 'git' | 'diff-store';
  readonly diffStoreSnapshots?: ReadonlyMap<string, DiffStoreAllChangesSnapshotPair>;
  readonly diffStoreDeferredPaths?: ReadonlySet<string>;
};

type ResolvedPath = {
  readonly ownerSessionId: SessionId;
  readonly workspaceRoot: string;
  readonly workspacePath: string;
  readonly absolutePath: string;
  readonly allChangesBaseBranch?: string;
};

type OwnerSharedState = {
  fileTree: CodeCollabV2FileTreeState;
  allChanges: CodeCollabV2AllChangesState;
};

type OwnerPublishedSharedState = {
  readonly fileIndex: CodeCollabV2FileIndexState;
  readonly persistedAllChangesDiffStats: boolean;
};

type FileTreePathIndex = {
  readonly childrenByDirectory: Map<string, Set<string>>;
};

type FullSharedStateWorkerPublishResult = {
  readonly entries: number;
  readonly scanMs: number;
  readonly allChangesMs: number;
  readonly allChangesSource: 'git' | 'diff-store';
  readonly buildMs: number;
  readonly workerMs: number;
  readonly changedPaths: number;
  readonly pathCount: number;
};

type QueuedSharedStateRefresh = {
  readonly kind: 'full' | 'turn';
  readonly resolved: ResolvedPath;
  readonly forcePublish: boolean;
  readonly persistAllChangesDiffStats: boolean;
  /** Local IPC snapshot reads update in-memory state without awaiting Flock I/O. */
  readonly publish: boolean;
};

type SharedStatePublishOptions = {
  readonly forcePublish?: boolean;
  readonly persistAllChangesDiffStats?: boolean;
  /** Defaults to true. Local IPC snapshots deliberately skip this asynchronous side effect. */
  readonly publish?: boolean;
};

type OwnerSharedStateRefreshQueue = {
  running: boolean;
  pending: QueuedSharedStateRefresh | null;
  waiters: Array<{
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
  }>;
};

type OwnerWorkspaceWatchState = {
  readonly ownerSessionId: SessionId;
  workspaceRoot: string;
  subscription: WorkspaceWatchSubscription | null;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

type OwnerFileIndexRepairState = {
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
  persistAllChangesDiffStats: boolean;
};

const DEFAULT_CODE_COLLAB_BACKGROUND_CONCURRENCY = 4;
const DEFAULT_DIFF_STORE_SNAPSHOT_CACHE_MAX_RAW_BYTES = 8 * 1024 * 1024;
const DEFAULT_FILE_INDEX_REPAIR_BASE_DELAY_MS = 1_000;
const DEFAULT_FILE_INDEX_REPAIR_MAX_DELAY_MS = 30_000;
const FILE_INDEX_REPAIR_JITTER_FRACTION = 0.2;

export class CodeCollabV2Service {
  private readonly stateByOwnerSessionId = new Map<SessionId, OwnerSharedState>();
  private readonly publishedStateByOwnerSessionId = new Map<SessionId, OwnerPublishedSharedState>();
  private readonly watchByOwnerSessionId = new Map<SessionId, OwnerWorkspaceWatchState>();
  private readonly refreshQueueByOwnerSessionId = new Map<
    SessionId,
    OwnerSharedStateRefreshQueue
  >();
  private readonly publishChainByOwnerSessionId = new Map<SessionId, Promise<void>>();
  private readonly pendingFileIndexSignalByOwnerSessionId = new Set<SessionId>();
  private readonly fileIndexRepairByOwnerSessionId = new Map<
    SessionId,
    OwnerFileIndexRepairState
  >();
  private disposed = false;
  private readonly logger = getLogger('code-collab');
  // Per-absolute-path write chains so concurrent saves to the same file stay
  // serialized (read-check-write atomic) even though the Machine RPC request loop
  // now dispatches handlers concurrently. Saves to different paths run in parallel.
  private readonly writeChainByAbsolutePath = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: {
      readonly resolveWorkspace: CodeCollabV2WorkspaceResolver;
      readonly publishFileIndex?: CodeCollabV2FileIndexPublisher;
      readonly publishFileIndexSignal?: CodeCollabV2FileIndexSignalPublisher;
      readonly maxRawTextBytes?: number;
      readonly maxCompressedBytes?: number;
      readonly plainTextBytes?: number;
      readonly maxFileTreeEntries?: number;
      readonly watchIdleTimeoutMs?: number;
      readonly workspaceId?: string;
      readonly workspaceWatchCoordinator?: WorkspaceWatchCoordinatorApi;
      readonly diffStore?: CodeCollabV2DiffStore;
      readonly fileIndexRepairBaseDelayMs?: number;
      readonly fileIndexRepairMaxDelayMs?: number;
      readonly fileIndexRepairRandom?: () => number;
      // Batched All Changes diff budgets (overridable for tests).
      readonly allChangesDiffLimits?: {
        readonly perFileMaxCompressedBytes: number;
        readonly responseBudgetCompressedBytes: number;
        readonly perFileMaxRawBytes: number;
      };
      readonly allChangesSnapshotCacheMaxRawBytes?: number;
    }
  ) {}

  dispose(): void {
    this.disposed = true;
    for (const repair of this.fileIndexRepairByOwnerSessionId.values()) {
      if (repair.timer) {
        clearTimeout(repair.timer);
      }
    }
    this.fileIndexRepairByOwnerSessionId.clear();
    for (const ownerSessionId of this.watchByOwnerSessionId.keys()) {
      this.releaseWorkspaceWatch(ownerSessionId);
    }
  }

  releaseWorkspaceWatchForOwner(ownerSessionId: SessionId): void {
    this.releaseWorkspaceWatch(ownerSessionId);
  }

  async openText(request: CodeCollabV2OpenTextRequest): Promise<CodeCollabV2OpenTextOk> {
    const resolved = await this.resolveRequestPath(request.sessionId as SessionId, request.path);
    void this.ensureWorkspaceWatch(resolved).catch(() => undefined);
    const read = await this.readSupportedTextFile(resolved);
    void this.reconcilePathState(resolved).catch(() => undefined);
    return {
      status: 'ok',
      path: resolved.workspacePath,
      digest: digestBytes(read.bytes),
      text: await this.encodeTextPayload(read.bytes, resolved.workspacePath),
      format: detectTextFormat(read.bytes),
    };
  }

  async getFileIndex(
    request: CodeCollabV2FileIndexRequest
  ): Promise<CodeCollabV2FileIndexSnapshot> {
    const resolved = await this.resolveRequestDirectoryPath(
      request.sessionId as SessionId,
      ROOT_DIRECTORY_REQUEST_PATH
    );
    const hasState = this.stateByOwnerSessionId.has(resolved.ownerSessionId);
    const hasActiveWatch = this.watchByOwnerSessionId.has(resolved.ownerSessionId);
    const activatedLocally = !hasState || !hasActiveWatch;
    if (activatedLocally) {
      await this.enqueueSharedStateRefresh(resolved.ownerSessionId, {
        kind: 'full',
        resolved,
        forcePublish: false,
        persistAllChangesDiffStats: false,
        // This response is the local authority snapshot. Flock publication is
        // durable replication, not a prerequisite for an Electron local view.
        publish: false,
      });
    }
    // Keep normal watcher-driven Flock propagation alive, but do not make this
    // local IPC read wait for subscription setup or a publication transaction.
    void this.ensureWorkspaceWatch(resolved).catch(() => undefined);
    const state = this.getOwnerState(resolved.ownerSessionId);
    const snapshot = {
      status: 'ok' as const,
      ownerSessionId: resolved.ownerSessionId,
      fileIndex: buildCodeCollabFileIndexState(
        cloneFileTreeState(state.fileTree),
        cloneAllChangesState(state.allChanges)
      ),
      updatedAtMs: getServerNow(),
    };
    if (activatedLocally) {
      // A local IPC snapshot is authoritative for first paint, but an existing
      // durable Flock replica can be stale after the CLI was stopped. Reconcile
      // the freshly scanned in-memory state in the background so a later local
      // Flock join converges back to this authority instead of preserving stale
      // rows. This intentionally does not delay the RPC response.
      void this.publishOwnerState(resolved.ownerSessionId, state, { forcePublish: true }).catch(
        (error: unknown) => {
          this.logger.debug(
            `[code-collab] local file-index Flock repair failed ownerSessionId=${
              resolved.ownerSessionId
            }: ${formatErrorMessage(error)}`
          );
        }
      );
    }
    return snapshot;
  }

  async refreshText(
    request: CodeCollabV2RefreshTextRequest
  ): Promise<CodeCollabV2RefreshTextResponse> {
    const resolved = await this.resolveRequestPath(request.sessionId as SessionId, request.path);
    void this.ensureWorkspaceWatch(resolved).catch(() => undefined);
    const read = await this.readSupportedTextFile(resolved);
    const digest = digestBytes(read.bytes);
    void this.reconcilePathState(resolved).catch(() => undefined);
    if (digest === request.digest) {
      return {
        status: 'up_to_date',
        path: resolved.workspacePath,
        digest,
      };
    }
    return {
      status: 'updated',
      path: resolved.workspacePath,
      digest,
      text: await this.encodeTextPayload(read.bytes, resolved.workspacePath),
      format: detectTextFormat(read.bytes),
    };
  }

  async saveText(request: CodeCollabV2SaveTextRequest): Promise<CodeCollabV2SaveTextResponse> {
    let resolved: ResolvedPath;
    try {
      resolved = await this.resolveRequestPath(request.sessionId as SessionId, request.path, {
        access: 'write',
        requestedByUserId: request.requestedByUserId,
      });
    } catch (error) {
      if (isCodeCollabV2ServiceError(error) && error.code === 'path_conflict') {
        return {
          status: 'conflict',
          reason: 'path_conflict',
          path: request.path,
          baseDigest: request.baseDigest,
        };
      }
      throw error;
    }
    // Serialize the read-check-write per file. The request loop dispatches saves
    // concurrently, so without this two saves to the same path could both observe
    // the same base digest, both pass the conflict check, and silently clobber one
    // another. Different paths still save in parallel.
    return this.serializeByAbsolutePath(resolved.absolutePath, async () => {
      const disk = await this.readDiskStateForSave(resolved);
      if (disk.kind === 'missing') {
        return {
          status: 'conflict',
          reason: 'file_deleted',
          path: resolved.workspacePath,
          baseDigest: request.baseDigest,
        };
      }

      // Conflict whenever the disk digest differs from the guest's base, OR when the disk
      // content is no longer readable (too large / binary / invalid UTF-8). We never throw a
      // hard error in those cases: the guest's unsaved edits must be preserved, and the
      // conflict carries the disk digest (when known) so merge/override flows can resubmit.
      if (disk.digest === undefined || disk.digest !== request.baseDigest) {
        return {
          status: 'conflict',
          reason: 'digest_mismatch',
          path: resolved.workspacePath,
          baseDigest: request.baseDigest,
          ...(disk.digest === undefined ? {} : { diskDigest: disk.digest }),
          ...(disk.kind === 'present'
            ? { diskText: await this.tryEncodeConflictDiskText(disk.bytes, resolved.workspacePath) }
            : {}),
        };
      }

      const nextBytes = await this.decodeSubmittedText(
        request.text,
        resolved.workspacePath,
        request.format
      );
      await writeFileAtomically(resolved.absolutePath, nextBytes, resolved.workspacePath);
      void this.reconcilePathState(resolved).catch(() => undefined);
      return {
        status: 'ok',
        path: resolved.workspacePath,
        digest: digestBytes(nextBytes),
        rawBytes: nextBytes.byteLength,
      };
    });
  }

  /**
   * Run `fn` exclusively per absolute path: concurrent calls for the same file
   * chain one after another, while different files run in parallel. Keeps the
   * save read-check-write atomic now that the RPC request loop dispatches handlers
   * concurrently.
   */
  private async serializeByAbsolutePath<T>(absolutePath: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.writeChainByAbsolutePath.get(absolutePath) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    // The stored tail never rejects, so the next caller always chains cleanly.
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.writeChainByAbsolutePath.set(absolutePath, tail);
    try {
      return await run;
    } finally {
      // Drop the entry only when no newer save has chained onto this path.
      if (this.writeChainByAbsolutePath.get(absolutePath) === tail) {
        this.writeChainByAbsolutePath.delete(absolutePath);
      }
    }
  }

  async initDirectory(
    request: CodeCollabV2InitDirectoryRequest
  ): Promise<CodeCollabV2InitDirectoryOk> {
    const resolved = await this.resolveRequestDirectoryPath(
      request.sessionId as SessionId,
      request.path
    );
    void this.ensureWorkspaceWatch(resolved).catch(() => undefined);
    if (resolved.workspacePath) {
      const state = this.getOwnerState(resolved.ownerSessionId);
      if (!isLazyDirectoryValue(state.fileTree[resolved.workspacePath])) {
        throw new CodeCollabV2ServiceError('unsupported_skipped', 'Path is not a lazy directory.', {
          path: resolved.workspacePath,
        });
      }
    }
    const stat = await lstat(resolved.absolutePath).catch((error: unknown) => {
      throw mapNodeReadError(error, resolved.workspacePath);
    });
    if (!stat.isDirectory()) {
      throw new CodeCollabV2ServiceError('unsupported_skipped', 'Path is not a lazy directory.', {
        path: resolved.workspacePath,
      });
    }
    const publishedEntries = await this.scanAndPublishDirectory(resolved);
    return {
      status: 'ok',
      path: resolved.workspacePath || ROOT_DIRECTORY_REQUEST_PATH,
      publishedEntries,
    };
  }

  async refreshSharedState(
    request: { readonly sessionId: SessionId },
    options: { readonly forcePublish?: boolean } = {}
  ): Promise<void> {
    const resolved = await this.resolveRequestDirectoryPath(
      request.sessionId,
      ROOT_DIRECTORY_REQUEST_PATH
    );
    void this.ensureWorkspaceWatch(resolved).catch(() => undefined);
    await this.enqueueSharedStateRefresh(resolved.ownerSessionId, {
      kind: 'full',
      resolved,
      forcePublish: options.forcePublish === true,
      persistAllChangesDiffStats: false,
      publish: true,
    });
  }

  async refreshSharedStateAfterTurn(request: { readonly sessionId: SessionId }): Promise<void> {
    const resolved = await this.resolveRequestDirectoryPath(
      request.sessionId,
      ROOT_DIRECTORY_REQUEST_PATH
    );
    void this.ensureWorkspaceWatch(resolved).catch(() => undefined);
    await this.enqueueSharedStateRefresh(resolved.ownerSessionId, {
      kind: 'turn',
      resolved,
      forcePublish: false,
      persistAllChangesDiffStats: true,
      publish: true,
    });
  }

  private async refreshSharedStateNow(
    resolved: ResolvedPath,
    options: SharedStatePublishOptions = {}
  ): Promise<void> {
    const startedAtMs = Date.now();
    const state = this.getOwnerState(resolved.ownerSessionId);
    const fileTreeIndex = buildFileTreePathIndex(state.fileTree);
    const expandedDirectoryPaths = collectExpandedDirectoryPaths(state.fileTree);
    const workerResult = await this.computeAndPublishFullSharedStateInWorker(
      resolved,
      state,
      fileTreeIndex,
      options
    );
    if (workerResult) {
      this.logger.info(
        `[code-collab] file-index full refresh completed ownerSessionId=${
          resolved.ownerSessionId
        } expandedDirectories=${expandedDirectoryPaths.length} durationMs=${
          Date.now() - startedAtMs
        } scanMs=${workerResult.scanMs} allChangesMs=${workerResult.allChangesMs} buildMs=${
          workerResult.buildMs
        } workerMs=${workerResult.workerMs} source=${workerResult.allChangesSource} changedPaths=${
          workerResult.changedPaths
        } paths=${workerResult.pathCount} force=${options.forcePublish === true}`
      );
      return;
    }

    const scanStartedAtMs = Date.now();
    await this.scanDirectoryIntoState(state, resolved, {
      recursive: true,
      replaceFileTree: true,
      fileTreeIndex,
    });
    const scanMs = Date.now() - scanStartedAtMs;
    await this.computeAllChangesAndPublish(resolved, state, { ...options, fileTreeIndex });
    this.logger.info(
      `[code-collab] file-index full refresh completed ownerSessionId=${
        resolved.ownerSessionId
      } expandedDirectories=${expandedDirectoryPaths.length} durationMs=${
        Date.now() - startedAtMs
      } scanMs=${scanMs} force=${options.forcePublish === true}`
    );
  }

  private async refreshSharedStateAfterTurnNow(resolved: ResolvedPath): Promise<void> {
    const startedAtMs = Date.now();
    void this.ensureWorkspaceWatch(resolved).catch(() => undefined);
    const state = this.getOwnerState(resolved.ownerSessionId);
    const fileTreeIndex = buildFileTreePathIndex(state.fileTree);
    const workerResult = await this.computeAndPublishFullSharedStateInWorker(
      resolved,
      state,
      fileTreeIndex,
      {
        persistAllChangesDiffStats: true,
      }
    );
    if (workerResult) {
      this.logger.info(
        `[code-collab] file-index turn refresh completed ownerSessionId=${
          resolved.ownerSessionId
        } source=${workerResult.allChangesSource} changedPaths=${
          workerResult.changedPaths
        } directories=0 durationMs=${
          Date.now() - startedAtMs
        } allChangesMs=${workerResult.allChangesMs} scanMs=${workerResult.scanMs} buildMs=${
          workerResult.buildMs
        } workerMs=${workerResult.workerMs} paths=${workerResult.pathCount}`
      );
      return;
    }

    const allChangesStartedAtMs = Date.now();
    const allChangesResult = await this.computeAllChangesForResolvedWorkspaceWithSource(resolved);
    state.allChanges = allChangesResult.allChanges;
    const allChangesMs = Date.now() - allChangesStartedAtMs;
    if (allChangesResult.source === 'git') {
      const scanStartedAtMs = Date.now();
      const entries = await this.scanDirectoryIntoState(state, resolved, {
        recursive: true,
        replaceFileTree: true,
        fileTreeIndex,
      });
      const scanMs = Date.now() - scanStartedAtMs;
      await this.ensureAllChangesFileTreeEntries(resolved, state, fileTreeIndex);
      await this.publishOwnerState(resolved.ownerSessionId, state, {
        persistAllChangesDiffStats: true,
      });
      this.logger.info(
        `[code-collab] file-index turn refresh completed ownerSessionId=${
          resolved.ownerSessionId
        } source=git mode=main-thread-full-fallback changedPaths=${
          Object.keys(state.allChanges).length
        } directories=0 durationMs=${Date.now() - startedAtMs} allChangesMs=${allChangesMs} scanMs=${scanMs} paths=${entries}`
      );
      return;
    }
    const diffStorePaths =
      (await this.deps.diffStore?.listChangedPaths({
        ownerSessionId: resolved.ownerSessionId,
      })) ?? [];
    const candidatePaths = collectTurnRefreshCandidatePaths(state.allChanges, diffStorePaths);
    const directoryPaths = collectCandidateDirectoryPaths(candidatePaths);
    const scanStartedAtMs = Date.now();
    for (const directoryPath of directoryPaths) {
      try {
        const directoryResolved = await this.resolveRequestDirectoryPath(
          resolved.ownerSessionId,
          directoryPath || ROOT_DIRECTORY_REQUEST_PATH
        );
        await this.scanDirectoryIntoState(state, directoryResolved, { fileTreeIndex });
      } catch (error) {
        if (isCodeCollabV2ServiceError(error) && error.code === 'file_not_found') {
          deleteFileTreePathAndDescendants(state.fileTree, directoryPath, fileTreeIndex);
          continue;
        }
        if (isCodeCollabV2ServiceError(error) && error.code === 'path_conflict') {
          setFileTreePathValue(
            state.fileTree,
            directoryPath,
            { kind: 'skipped', reason: 'path_conflict' },
            fileTreeIndex
          );
          deleteDescendantFileTreeEntries(state.fileTree, directoryPath, fileTreeIndex);
          continue;
        }
        throw error;
      }
    }
    const scanMs = Date.now() - scanStartedAtMs;
    await this.ensureAllChangesFileTreeEntries(resolved, state, fileTreeIndex);
    await this.publishOwnerState(resolved.ownerSessionId, state, {
      persistAllChangesDiffStats: true,
    });
    this.logger.info(
      `[code-collab] file-index turn refresh completed ownerSessionId=${
        resolved.ownerSessionId
      } source=${allChangesResult.source} changedPaths=${candidatePaths.length} directories=${
        directoryPaths.length
      } durationMs=${Date.now() - startedAtMs} allChangesMs=${allChangesMs} scanMs=${scanMs}`
    );
  }

  private enqueueSharedStateRefresh(
    ownerSessionId: SessionId,
    refresh: QueuedSharedStateRefresh
  ): Promise<void> {
    let queue = this.refreshQueueByOwnerSessionId.get(ownerSessionId);
    if (!queue) {
      queue = { running: false, pending: null, waiters: [] };
      this.refreshQueueByOwnerSessionId.set(ownerSessionId, queue);
    }
    queue.pending = mergeQueuedSharedStateRefresh(queue.pending, refresh);
    const waiter = new Promise<void>((resolve, reject) => {
      queue.waiters.push({ resolve, reject });
    });
    if (!queue.running) {
      void this.drainSharedStateRefreshQueue(ownerSessionId, queue);
    }
    return waiter;
  }

  private async drainSharedStateRefreshQueue(
    ownerSessionId: SessionId,
    queue: OwnerSharedStateRefreshQueue
  ): Promise<void> {
    queue.running = true;
    let firstError: unknown;
    try {
      while (queue.pending) {
        const refresh = queue.pending;
        queue.pending = null;
        try {
          if (refresh.kind === 'turn') {
            await this.refreshSharedStateAfterTurnNow(refresh.resolved);
          } else {
            await this.refreshSharedStateNow(refresh.resolved, {
              forcePublish: refresh.forcePublish,
              persistAllChangesDiffStats: refresh.persistAllChangesDiffStats,
              publish: refresh.publish,
            });
          }
        } catch (error) {
          firstError ??= error;
          this.logger.debug(
            `[code-collab] file-index refresh failed ownerSessionId=${ownerSessionId} kind=${
              refresh.kind
            }: ${formatErrorMessage(error)}`
          );
        }
      }
    } finally {
      queue.running = false;
      if (this.refreshQueueByOwnerSessionId.get(ownerSessionId) === queue && !queue.pending) {
        this.refreshQueueByOwnerSessionId.delete(ownerSessionId);
      }
      const waiters = queue.waiters.splice(0);
      for (const waiter of waiters) {
        if (firstError === undefined) {
          waiter.resolve();
        } else {
          waiter.reject(firstError);
        }
      }
      if (queue.pending && !queue.running) {
        void this.drainSharedStateRefreshQueue(ownerSessionId, queue);
      }
    }
  }

  async lspDefinition(): Promise<CodeCollabV2LspUnsupported> {
    return { status: 'unsupported', code: 'lsp_not_wired' };
  }

  async lspReferences(): Promise<CodeCollabV2LspUnsupported> {
    return { status: 'unsupported', code: 'lsp_not_wired' };
  }

  async openCurrentDiff(
    request: CodeCollabV2OpenCurrentDiffRequest
  ): Promise<CodeCollabV2OpenCurrentDiffResponse> {
    const resolved = await this.resolveRequestPath(request.sessionId as SessionId, request.path);
    void this.ensureWorkspaceWatch(resolved).catch(() => undefined);
    const oldSnapshot = await this.resolveCurrentDiffBaseSnapshot(resolved);
    if (oldSnapshot.status === 'unavailable') {
      return {
        status: 'unavailable',
        path: resolved.workspacePath,
        reason: 'base_unavailable',
        message: 'No Git base or local ACP diff evidence is available for this file.',
      };
    }

    const newSnapshot = await readCurrentDiffSnapshot(
      resolved,
      this.deps.maxRawTextBytes ?? CODE_COLLAB_V2_TEXT_LIMITS.maxRawTextBytes
    );
    if (newSnapshot.status === 'unavailable') {
      return {
        status: 'unavailable',
        path: resolved.workspacePath,
        reason: 'transient_io',
        message: newSnapshot.message,
      };
    }
    if (areDiffSnapshotsEqual(oldSnapshot.snapshot, newSnapshot.snapshot)) {
      return {
        status: 'unavailable',
        path: resolved.workspacePath,
        reason: 'not_changed',
        message: 'The file is unchanged from the current All Changes base.',
      };
    }

    const lineStats = await diffSnapshotLineStats(oldSnapshot.snapshot, newSnapshot.snapshot);
    return {
      status: 'ok',
      path: resolved.workspacePath,
      oldSnapshot: await this.encodeDiffSnapshot(oldSnapshot.snapshot, resolved.workspacePath),
      newSnapshot: await this.encodeDiffSnapshot(newSnapshot.snapshot, resolved.workspacePath),
      ...(lineStats === undefined ? {} : { add: lineStats[0], del: lineStats[1] }),
    };
  }

  // Batched All Changes diff: compute every changed file's current diff (disk vs base) in
  // one pass and return them in a single response. The file set + base come from the same
  // `computeAllChanges` source as the published list, so list and content stay consistent.
  // Files that would blow the per-file or total response budget come back `deferred` and the
  // client lazily fetches them via `open-current-diff`.
  async openAllChangesDiff(
    request: CodeCollabV2OpenAllChangesDiffRequest
  ): Promise<CodeCollabV2OpenAllChangesDiffResponse> {
    const root = await this.resolveRequestDirectoryPath(
      request.sessionId as SessionId,
      ROOT_DIRECTORY_REQUEST_PATH
    );
    void this.ensureWorkspaceWatch(root).catch(() => undefined);

    const limits = this.deps.allChangesDiffLimits ?? CODE_COLLAB_V2_ALL_CHANGES_DIFF_LIMITS;
    const { allChanges, source, diffStoreSnapshots, diffStoreDeferredPaths } =
      await this.computeAllChangesForResolvedWorkspaceWithSource(root, {
        includeDiffStoreSnapshots: true,
        preferredDiffStoreSnapshotPath: request.focusPath,
        diffStoreSnapshotCacheMaxRawBytes:
          this.deps.allChangesSnapshotCacheMaxRawBytes ??
          DEFAULT_DIFF_STORE_SNAPSHOT_CACHE_MAX_RAW_BYTES,
        diffStoreSnapshotPerFileMaxRawBytes: limits.perFileMaxRawBytes,
      });
    const base =
      source === 'git'
        ? ((await resolveAllChangesDiffBase(root.workspaceRoot, root.allChangesBaseBranch)) ??
          'HEAD')
        : 'diff-store';

    const maxRawTextBytes = this.deps.maxRawTextBytes ?? CODE_COLLAB_V2_TEXT_LIMITS.maxRawTextBytes;
    const focusPath = request.focusPath;

    // focus first, then ascending changed-line count so the smallest files inline before the
    // budget runs out and the big ones fall through to deferred.
    const orderedPaths = Object.keys(allChanges).sort((a, b) => {
      if (a === focusPath) return b === focusPath ? 0 : -1;
      if (b === focusPath) return 1;
      return allChangesValueWeight(allChanges[a]) - allChangesValueWeight(allChanges[b]);
    });

    const entries: CodeCollabV2AllChangesDiffEntry[] = [];
    let truncated = false;
    let usedBudget = 0;

    for (const workspacePath of orderedPaths) {
      const stats = allChangesValueStats(allChanges[workspacePath]);
      const fileResolved: ResolvedPath = {
        ownerSessionId: root.ownerSessionId,
        workspaceRoot: root.workspaceRoot,
        workspacePath,
        absolutePath: path.resolve(root.workspaceRoot, workspacePath),
        ...(root.allChangesBaseBranch === undefined
          ? {}
          : { allChangesBaseBranch: root.allChangesBaseBranch }),
      };

      const cachedSnapshots = diffStoreSnapshots?.get(workspacePath);
      if (!cachedSnapshots && diffStoreDeferredPaths?.has(workspacePath)) {
        entries.push({ status: 'deferred', path: workspacePath, ...stats });
        truncated = true;
        continue;
      }
      const [oldSnapshot, newSnapshot] = cachedSnapshots
        ? ([
            { status: 'ready', snapshot: cachedSnapshots.oldSnapshot },
            { status: 'ready', snapshot: cachedSnapshots.newSnapshot },
          ] as const)
        : await Promise.all([
            this.resolveCurrentDiffBaseSnapshot(fileResolved),
            readCurrentDiffSnapshot(fileResolved, maxRawTextBytes),
          ]);
      if (oldSnapshot.status === 'unavailable' || newSnapshot.status === 'unavailable') {
        // Base/disk not readable right now — a single-file fetch can retry.
        entries.push({ status: 'deferred', path: workspacePath, ...stats });
        truncated = true;
        continue;
      }
      if (areDiffSnapshotsEqual(oldSnapshot.snapshot, newSnapshot.snapshot)) {
        // Listed as changed but base snapshot equals disk (also covers binary↔binary).
        // Matches open-current-diff's not_changed.
        entries.push({
          status: 'unavailable',
          path: workspacePath,
          reason: 'not_changed',
          ...stats,
        });
        continue;
      }
      // binary / too_large snapshots fall through here and encode to tiny placeholder
      // snapshots ({kind:'binary'|'too_large'}), inlined as `ok` exactly like open-current-diff.
      // Raw-size precheck avoids gzipping a big text file just to discard it below.
      const rawBytes =
        internalDiffSnapshotRawBytes(oldSnapshot.snapshot) +
        internalDiffSnapshotRawBytes(newSnapshot.snapshot);
      if (rawBytes > limits.perFileMaxRawBytes) {
        entries.push({ status: 'deferred', path: workspacePath, ...stats });
        truncated = true;
        continue;
      }
      const oldEncoded = await this.encodeDiffSnapshot(oldSnapshot.snapshot, workspacePath);
      const newEncoded = await this.encodeDiffSnapshot(newSnapshot.snapshot, workspacePath);
      const entryBytes =
        encodedDiffSnapshotWireBytes(oldEncoded) + encodedDiffSnapshotWireBytes(newEncoded);
      if (
        entryBytes > limits.perFileMaxCompressedBytes ||
        usedBudget + entryBytes > limits.responseBudgetCompressedBytes
      ) {
        entries.push({ status: 'deferred', path: workspacePath, ...stats });
        truncated = true;
        continue;
      }
      usedBudget += entryBytes;
      entries.push({
        status: 'ok',
        path: workspacePath,
        oldSnapshot: oldEncoded,
        newSnapshot: newEncoded,
        ...stats,
      });
    }

    return { status: 'ok', base, entries, truncated };
  }

  async openTurnDiff(
    request: CodeCollabV2OpenTurnDiffRequest
  ): Promise<CodeCollabV2OpenTurnDiffResponse> {
    const resolved = await this.resolveRequestPath(request.sessionId as SessionId, request.path);
    const maxRawTextBytes = this.deps.maxRawTextBytes ?? CODE_COLLAB_V2_TEXT_LIMITS.maxRawTextBytes;
    const turnSnapshot = await this.deps.diffStore?.getTurnDiffSnapshot({
      ownerSessionId: resolved.ownerSessionId,
      turnId: request.turnId,
      path: resolved.workspacePath,
      maxRawBytes: Math.min(Number.MAX_SAFE_INTEGER, maxRawTextBytes * 2),
    });
    if (!turnSnapshot || turnSnapshot.status !== 'ready') {
      return {
        status: 'unavailable',
        path: resolved.workspacePath,
        turnId: request.turnId,
        reason: 'turn_unavailable',
        message: 'No local ACP diff evidence is available for this turn and file.',
      };
    }

    const oldSnapshot: InternalDiffSnapshot =
      turnSnapshot.oldText === null
        ? { kind: 'missing' }
        : { kind: 'text', text: turnSnapshot.oldText };
    const newSnapshot: InternalDiffSnapshot =
      turnSnapshot.newText === null
        ? { kind: 'missing' }
        : { kind: 'text', text: turnSnapshot.newText };
    if (areDiffSnapshotsEqual(oldSnapshot, newSnapshot)) {
      return {
        status: 'unavailable',
        path: resolved.workspacePath,
        turnId: request.turnId,
        reason: 'not_changed',
        message: 'The stored turn diff has identical old and new snapshots.',
      };
    }

    const lineStats = await diffSnapshotLineStats(oldSnapshot, newSnapshot);
    return {
      status: 'ok',
      path: resolved.workspacePath,
      turnId: request.turnId,
      oldSnapshot: await this.encodeDiffSnapshot(oldSnapshot, resolved.workspacePath),
      newSnapshot: await this.encodeDiffSnapshot(newSnapshot, resolved.workspacePath),
      ...(lineStats === undefined ? {} : { add: lineStats[0], del: lineStats[1] }),
    };
  }

  private async resolveRequestPath(
    sessionId: SessionId,
    requestedPath: string,
    options?: CodeCollabV2WorkspaceResolveOptions
  ): Promise<ResolvedPath> {
    return await this.resolvePath(sessionId, requestedPath, { allowRoot: false, ...options });
  }

  private async resolveRequestDirectoryPath(
    sessionId: SessionId,
    requestedPath: string,
    options?: CodeCollabV2WorkspaceResolveOptions
  ): Promise<ResolvedPath> {
    return await this.resolvePath(sessionId, requestedPath, { allowRoot: true, ...options });
  }

  private async resolvePath(
    sessionId: SessionId,
    requestedPath: string,
    options: { readonly allowRoot: boolean } & CodeCollabV2WorkspaceResolveOptions
  ): Promise<ResolvedPath> {
    const resolvedWorkspace = await this.deps.resolveWorkspace(sessionId, {
      access: options.access ?? 'read',
      ...(options.requestedByUserId === undefined
        ? {}
        : { requestedByUserId: options.requestedByUserId }),
    });
    if (!resolvedWorkspace.ok) {
      throw new CodeCollabV2ServiceError(resolvedWorkspace.code, resolvedWorkspace.message, {
        retryable:
          resolvedWorkspace.code === 'transient_io' || resolvedWorkspace.code === 'machine_offline',
      });
    }
    const workspaceRoot = path.resolve(resolvedWorkspace.workspaceRoot);
    const workspacePath = normalizeWorkspacePath(
      resolveWorkspaceRelativeRequestPath(workspaceRoot, requestedPath),
      options
    );
    const requestedAbsolutePath = path.resolve(workspaceRoot, workspacePath);
    const absolutePath =
      (await resolveExistingPathWithoutConflicts(workspaceRoot, workspacePath, requestedPath)) ??
      requestedAbsolutePath;
    const relative = path.relative(workspaceRoot, absolutePath);
    if (isPathOutsideRoot(relative)) {
      throw new CodeCollabV2ServiceError('invalid_path', 'Path escapes workspace root.', {
        path: requestedPath,
      });
    }
    return {
      ownerSessionId: resolvedWorkspace.ownerSessionId,
      workspaceRoot,
      workspacePath,
      absolutePath,
      ...(resolvedWorkspace.allChangesBaseBranch
        ? { allChangesBaseBranch: resolvedWorkspace.allChangesBaseBranch }
        : {}),
    };
  }

  private async readSupportedTextFile(resolved: ResolvedPath): Promise<StableRead> {
    const read = await stableReadFile(
      resolved,
      this.deps.maxRawTextBytes ?? CODE_COLLAB_V2_TEXT_LIMITS.maxRawTextBytes
    );
    if (hasBinaryNul(read.bytes)) {
      throw new CodeCollabV2ServiceError(
        'unsupported_binary',
        'Binary files are not supported yet.',
        {
          path: resolved.workspacePath,
        }
      );
    }
    try {
      decodeUtf8(read.bytes);
    } catch (error) {
      throw new CodeCollabV2ServiceError('decode_error', 'File is not valid UTF-8 text.', {
        path: resolved.workspacePath,
        cause: error,
      });
    }
    return read;
  }

  private async encodeTextPayload(
    bytes: Uint8Array,
    workspacePath: string
  ): Promise<CodeCollabV2EncodedTextPayload> {
    const plainTextBytes = this.deps.plainTextBytes ?? CODE_COLLAB_V2_TEXT_LIMITS.plainTextBytes;
    if (bytes.byteLength <= plainTextBytes) {
      return {
        encoding: 'plain',
        text: decodeUtf8(bytes),
        rawBytes: bytes.byteLength,
      };
    }
    const compressed = await gzipAsync(bytes);
    const maxCompressedBytes =
      this.deps.maxCompressedBytes ?? CODE_COLLAB_V2_TEXT_LIMITS.maxCompressedBytes;
    if (compressed.byteLength > maxCompressedBytes) {
      throw new CodeCollabV2ServiceError(
        'too_large',
        `Compressed text payload exceeds ${maxCompressedBytes} bytes.`,
        { path: workspacePath }
      );
    }
    return {
      encoding: 'gzip-base64',
      data: compressed.toString('base64'),
      rawBytes: bytes.byteLength,
      compressedBytes: compressed.byteLength,
    };
  }

  /**
   * Stable-read the current disk bytes for a save conflict check without applying the text
   * support gate. The digest is computed from the raw bytes so a conflict can still be reported
   * when the disk content is binary, invalid UTF-8, or too large to return as text.
   */
  private async readDiskStateForSave(resolved: ResolvedPath): Promise<
    | { readonly kind: 'missing' }
    | {
        readonly kind: 'present';
        readonly digest: CodeCollabV2FileDigest;
        readonly bytes: Uint8Array;
      }
    | { readonly kind: 'too_large'; readonly digest: CodeCollabV2FileDigest | undefined }
  > {
    const maxRawTextBytes = this.deps.maxRawTextBytes ?? CODE_COLLAB_V2_TEXT_LIMITS.maxRawTextBytes;
    try {
      const read = await stableReadFile(resolved, maxRawTextBytes);
      return { kind: 'present', digest: digestBytes(read.bytes), bytes: read.bytes };
    } catch (error) {
      if (
        isNotFoundError(error) ||
        (isCodeCollabV2ServiceError(error) && error.code === 'file_not_found')
      ) {
        return { kind: 'missing' };
      }
      if (isCodeCollabV2ServiceError(error) && error.code === 'too_large') {
        const digest = await streamFileDigest(resolved).catch(() => undefined);
        return { kind: 'too_large', digest };
      }
      throw error;
    }
  }

  private async tryEncodeConflictDiskText(
    bytes: Uint8Array,
    workspacePath: string
  ): Promise<CodeCollabV2EncodedTextPayload | undefined> {
    if (hasBinaryNul(bytes)) {
      return undefined;
    }
    try {
      decodeUtf8(bytes);
    } catch {
      return undefined;
    }
    try {
      return await this.encodeTextPayload(bytes, workspacePath);
    } catch (error) {
      if (isCodeCollabV2ServiceError(error) && error.code === 'too_large') {
        return undefined;
      }
      throw error;
    }
  }

  private async decodeSubmittedText(
    payload: CodeCollabV2EncodedTextPayload,
    workspacePath: string,
    format?: CodeCollabV2TextFormat
  ): Promise<Uint8Array> {
    let bytes: Uint8Array;
    if (payload.encoding === 'plain') {
      bytes = Buffer.from(payload.text, 'utf8');
      const plainTextBytes = this.deps.plainTextBytes ?? CODE_COLLAB_V2_TEXT_LIMITS.plainTextBytes;
      if (bytes.byteLength > plainTextBytes) {
        throw new CodeCollabV2ServiceError(
          'decode_error',
          'Plain text payload exceeds the plain text byte limit.',
          {
            path: workspacePath,
          }
        );
      }
    } else {
      const compressed = Buffer.from(payload.data, 'base64');
      if (compressed.byteLength !== payload.compressedBytes) {
        throw new CodeCollabV2ServiceError('decode_error', 'Compressed byte length mismatch.', {
          path: workspacePath,
        });
      }
      const maxCompressedBytes =
        this.deps.maxCompressedBytes ?? CODE_COLLAB_V2_TEXT_LIMITS.maxCompressedBytes;
      if (compressed.byteLength > maxCompressedBytes) {
        throw new CodeCollabV2ServiceError(
          'too_large',
          `Compressed text payload exceeds ${maxCompressedBytes} bytes.`,
          {
            path: workspacePath,
          }
        );
      }
      try {
        bytes = await gunzipAsync(compressed);
      } catch (error) {
        throw new CodeCollabV2ServiceError('decode_error', 'Unable to decode compressed text.', {
          path: workspacePath,
          cause: error,
        });
      }
    }
    if (bytes.byteLength !== payload.rawBytes) {
      throw new CodeCollabV2ServiceError('decode_error', 'Raw byte length mismatch.', {
        path: workspacePath,
      });
    }
    const maxRawTextBytes = this.deps.maxRawTextBytes ?? CODE_COLLAB_V2_TEXT_LIMITS.maxRawTextBytes;
    if (bytes.byteLength > maxRawTextBytes) {
      throw new CodeCollabV2ServiceError('too_large', `Text exceeds ${maxRawTextBytes} bytes.`, {
        path: workspacePath,
      });
    }
    if (hasBinaryNul(bytes)) {
      throw new CodeCollabV2ServiceError(
        'unsupported_binary',
        'Binary text payloads are not supported.',
        {
          path: workspacePath,
        }
      );
    }
    let text = decodeUtf8(bytes);
    if (format?.eol === 'lf' || format?.eol === 'crlf') {
      text = normalizeTextEol(text, format.eol);
    }
    if (format?.bom === true && !text.startsWith('\uFEFF')) {
      text = `\uFEFF${text}`;
    }
    return Buffer.from(text, 'utf8');
  }

  private getOwnerState(ownerSessionId: SessionId): OwnerSharedState {
    const existing = this.stateByOwnerSessionId.get(ownerSessionId);
    if (existing) {
      return existing;
    }
    const next: OwnerSharedState = { fileTree: {}, allChanges: {} };
    this.stateByOwnerSessionId.set(ownerSessionId, next);
    return next;
  }

  private async scanAndPublishDirectory(resolved: ResolvedPath): Promise<number> {
    const startedAtMs = Date.now();
    await this.ensureWorkspaceWatch(resolved);
    const state = this.getOwnerState(resolved.ownerSessionId);
    const fileTreeIndex = buildFileTreePathIndex(state.fileTree);
    if (resolved.workspacePath.length === 0) {
      const workerResult = await this.computeAndPublishFullSharedStateInWorker(
        resolved,
        state,
        fileTreeIndex,
        { persistAllChangesDiffStats: true }
      );
      if (workerResult) {
        this.logger.info(
          `[code-collab] file-index init-directory completed ownerSessionId=${
            resolved.ownerSessionId
          } path=${ROOT_DIRECTORY_REQUEST_PATH} entries=${workerResult.entries} durationMs=${
            Date.now() - startedAtMs
          } scanMs=${workerResult.scanMs} allChangesMs=${workerResult.allChangesMs} buildMs=${
            workerResult.buildMs
          } workerMs=${workerResult.workerMs} source=${workerResult.allChangesSource} changedPaths=${
            workerResult.changedPaths
          } paths=${workerResult.pathCount}`
        );
        return workerResult.entries;
      }
    }
    const scanStartedAtMs = Date.now();
    const publishedEntries = await this.scanDirectoryIntoState(state, resolved, {
      recursive: true,
      replaceFileTree: resolved.workspacePath.length === 0,
      fileTreeIndex,
    });
    const scanMs = Date.now() - scanStartedAtMs;
    await this.computeAllChangesAndPublish(resolved, state, {
      fileTreeIndex,
      persistAllChangesDiffStats: resolved.workspacePath.length === 0,
    });
    this.logger.info(
      `[code-collab] file-index init-directory completed ownerSessionId=${
        resolved.ownerSessionId
      } path=${resolved.workspacePath || ROOT_DIRECTORY_REQUEST_PATH} entries=${publishedEntries} durationMs=${
        Date.now() - startedAtMs
      } scanMs=${scanMs}`
    );
    return publishedEntries;
  }

  private async computeAndPublishFullSharedStateInWorker(
    resolved: Pick<ResolvedPath, 'allChangesBaseBranch' | 'ownerSessionId' | 'workspaceRoot'>,
    state: OwnerSharedState,
    fileTreeIndex: FileTreePathIndex,
    options: SharedStatePublishOptions = {}
  ): Promise<FullSharedStateWorkerPublishResult | null> {
    const startedAtMs = Date.now();
    const baseInput = {
      kind: 'full-state',
      workspaceRoot: resolved.workspaceRoot,
      maxRawTextBytes: this.deps.maxRawTextBytes ?? CODE_COLLAB_V2_TEXT_LIMITS.maxRawTextBytes,
      entryBudget: this.deps.maxFileTreeEntries ?? DEFAULT_FILE_TREE_SCAN_ENTRY_BUDGET,
      ...(resolved.allChangesBaseBranch === undefined
        ? {}
        : { preferredBaseBranch: resolved.allChangesBaseBranch }),
    } as const;
    let workerMs = 0;
    const runFullStateWorker = async (
      input: Parameters<typeof computeFullFileIndexStateInWorker>[0]
    ) => {
      const workerStartedAtMs = Date.now();
      const result = await computeFullFileIndexStateInWorker(input);
      workerMs += Date.now() - workerStartedAtMs;
      return result;
    };
    let result = await runFullStateWorker(baseInput);
    if (result?.status === 'needs-provided-all-changes') {
      const allChangesStartedAtMs = Date.now();
      const { allChanges } = await this.computeAllChangesFromDiffStore(resolved);
      const allChangesMs = Date.now() - allChangesStartedAtMs;
      result = await runFullStateWorker({
        ...baseInput,
        providedAllChanges: {
          source: 'diff-store',
          state: allChanges,
          computeMs: allChangesMs,
        },
      });
    }
    if (!result || result.status !== 'ok') {
      return null;
    }

    replaceFileTreeEntries(state.fileTree, new Map(result.fileTreeEntries), fileTreeIndex);
    state.allChanges = result.allChanges;
    if (options.publish !== false) {
      await this.publishPreparedOwnerFileIndex(resolved.ownerSessionId, result.fileIndex, options, {
        startedAtMs,
        cloneMs: 0,
        buildMs: 0,
        workerMs,
      });
    }
    return {
      entries: result.fileTreeEntries.length,
      scanMs: result.scanMs,
      allChangesMs: result.allChangesMs,
      allChangesSource: result.allChangesSource,
      buildMs: result.buildMs,
      workerMs,
      changedPaths: result.changedPaths,
      pathCount: result.pathCount,
    };
  }

  private async scanDirectoryIntoState(
    state: OwnerSharedState,
    resolved: ResolvedPath,
    options: {
      readonly recursive?: boolean;
      readonly replaceFileTree?: boolean;
      readonly fileTreeIndex?: FileTreePathIndex;
    } = {}
  ): Promise<number> {
    const scanInput = {
      directoryAbsolutePath: resolved.absolutePath,
      directoryWorkspacePath: resolved.workspacePath,
      maxRawTextBytes: this.deps.maxRawTextBytes ?? CODE_COLLAB_V2_TEXT_LIMITS.maxRawTextBytes,
      entryBudget: this.deps.maxFileTreeEntries ?? DEFAULT_FILE_TREE_SCAN_ENTRY_BUDGET,
      recursive: options.recursive === true,
    };
    const entries =
      (await scanDirectoryEntriesInWorker(scanInput)) ?? (await scanDirectoryEntries(scanInput));
    if (options.replaceFileTree === true) {
      replaceFileTreeEntries(state.fileTree, entries, options.fileTreeIndex);
      return entries.size;
    }
    if (options.recursive === true) {
      replaceDirectoryTreeEntries(
        state.fileTree,
        resolved.workspacePath,
        entries,
        options.fileTreeIndex
      );
      return entries.size;
    }
    replaceImmediateDirectoryEntries(
      state.fileTree,
      resolved.workspacePath,
      entries,
      options.fileTreeIndex
    );
    for (const [workspacePath, value] of entries) {
      setFileTreePathValue(state.fileTree, workspacePath, value, options.fileTreeIndex);
    }
    return entries.size;
  }

  private async computeAllChangesAndPublish(
    resolved: Pick<ResolvedPath, 'allChangesBaseBranch' | 'ownerSessionId' | 'workspaceRoot'>,
    state: OwnerSharedState,
    options: SharedStatePublishOptions & { readonly fileTreeIndex?: FileTreePathIndex } = {}
  ): Promise<void> {
    state.allChanges = await this.computeAllChangesForResolvedWorkspace(resolved);
    await this.ensureAllChangesFileTreeEntries(resolved, state, options.fileTreeIndex);
    if (options.publish !== false) {
      await this.publishOwnerState(resolved.ownerSessionId, state, options);
    }
  }

  private async computeAllChangesForResolvedWorkspace(
    resolved: Pick<ResolvedPath, 'allChangesBaseBranch' | 'ownerSessionId' | 'workspaceRoot'>
  ): Promise<CodeCollabV2AllChangesState> {
    return (await this.computeAllChangesForResolvedWorkspaceWithSource(resolved)).allChanges;
  }

  private async computeAllChangesForResolvedWorkspaceWithSource(
    resolved: Pick<ResolvedPath, 'allChangesBaseBranch' | 'ownerSessionId' | 'workspaceRoot'>,
    options: {
      readonly includeDiffStoreSnapshots?: boolean;
      readonly preferredDiffStoreSnapshotPath?: string;
      readonly diffStoreSnapshotCacheMaxRawBytes?: number;
      readonly diffStoreSnapshotPerFileMaxRawBytes?: number;
    } = {}
  ): Promise<AllChangesComputation> {
    if (await isInsideGitWorktree(resolved.workspaceRoot)) {
      return {
        allChanges: await computeAllChanges(resolved.workspaceRoot, {
          preferredBaseBranch: resolved.allChangesBaseBranch,
        }),
        source: 'git',
      };
    }
    const result = await this.computeAllChangesFromDiffStore(resolved, options);
    return { ...result, source: 'diff-store' };
  }

  private async ensureAllChangesFileTreeEntries(
    resolved: Pick<ResolvedPath, 'workspaceRoot'>,
    state: OwnerSharedState,
    fileTreeIndex?: FileTreePathIndex
  ): Promise<void> {
    const missingWorkspacePaths = Object.keys(state.allChanges).filter(
      (workspacePath) => state.fileTree[workspacePath] === undefined
    );
    if (missingWorkspacePaths.length === 0) {
      return;
    }

    await mapWithConcurrency(
      missingWorkspacePaths,
      DEFAULT_CODE_COLLAB_BACKGROUND_CONCURRENCY,
      async (workspacePath) => {
        const absolutePath = path.resolve(resolved.workspaceRoot, workspacePath);
        const value = await classifyPathForFileTree(absolutePath).catch((error: unknown) => {
          const code = errorCode(error);
          if (isNotFoundError(error) || code === 'ENOENT' || code === 'ENOTDIR') {
            return undefined;
          }
          return { kind: 'skipped', reason: 'transient_io' } satisfies CodeCollabV2FileTreeValue;
        });
        if (value === undefined) {
          return;
        }
        setFileTreePathValue(state.fileTree, workspacePath, value, fileTreeIndex);
        if (!isLazyDirectoryValue(value)) {
          deleteDescendantFileTreeEntries(state.fileTree, workspacePath, fileTreeIndex);
        }
      }
    );
  }

  private async computeAllChangesFromDiffStore(
    resolved: Pick<ResolvedPath, 'ownerSessionId' | 'workspaceRoot'>,
    options: {
      readonly includeDiffStoreSnapshots?: boolean;
      readonly preferredDiffStoreSnapshotPath?: string;
      readonly diffStoreSnapshotCacheMaxRawBytes?: number;
      readonly diffStoreSnapshotPerFileMaxRawBytes?: number;
    } = {}
  ): Promise<{
    readonly allChanges: CodeCollabV2AllChangesState;
    readonly diffStoreSnapshots?: ReadonlyMap<string, DiffStoreAllChangesSnapshotPair>;
    readonly diffStoreDeferredPaths?: ReadonlySet<string>;
  }> {
    const store = this.deps.diffStore;
    if (!store) {
      return { allChanges: {} };
    }
    const changes: CodeCollabV2AllChangesState = {};
    const includeSnapshots = options.includeDiffStoreSnapshots ?? false;
    const diffStoreSnapshots = new Map<string, DiffStoreAllChangesSnapshotPair>();
    const diffStoreDeferredPaths = new Set<string>();
    const snapshotCacheMaxRawBytes = Math.max(
      0,
      options.diffStoreSnapshotCacheMaxRawBytes ?? DEFAULT_DIFF_STORE_SNAPSHOT_CACHE_MAX_RAW_BYTES
    );
    const snapshotPerFileMaxRawBytes =
      options.diffStoreSnapshotPerFileMaxRawBytes ?? Number.POSITIVE_INFINITY;
    const snapshotReadMaxRawBytes = Math.max(
      0,
      Math.min(
        this.deps.maxRawTextBytes ?? CODE_COLLAB_V2_TEXT_LIMITS.maxRawTextBytes,
        snapshotPerFileMaxRawBytes
      )
    );
    let cachedSnapshotRawBytes = 0;
    const changedPaths = await store.listChangedPaths({
      ownerSessionId: resolved.ownerSessionId,
    });
    const processPath = async (workspacePath: string): Promise<void> => {
      const oldSnapshot = await store.getEarliestOldSnapshot({
        ownerSessionId: resolved.ownerSessionId,
        path: workspacePath,
        maxRawBytes: snapshotReadMaxRawBytes,
      });
      if (oldSnapshot.status === 'too_large') {
        changes[workspacePath] = true;
        if (includeSnapshots) diffStoreDeferredPaths.add(workspacePath);
        return;
      }
      if (oldSnapshot.status === 'unavailable') return;
      const current = await readCurrentDiffSnapshot(
        {
          workspaceRoot: resolved.workspaceRoot,
          workspacePath,
          absolutePath: path.resolve(resolved.workspaceRoot, workspacePath),
        },
        snapshotReadMaxRawBytes
      );
      if (current.status === 'unavailable') return;
      const oldValue: InternalDiffSnapshot =
        oldSnapshot.text === null ? { kind: 'missing' } : { kind: 'text', text: oldSnapshot.text };
      if (areDiffSnapshotsEqual(oldValue, current.snapshot)) return;
      const lineStats = await diffSnapshotLineStats(oldValue, current.snapshot);
      changes[workspacePath] =
        lineStats === undefined
          ? true
          : current.snapshot.kind === 'missing'
            ? { diff: [lineStats[0], lineStats[1]], del: true }
            : { diff: lineStats };
      if (!includeSnapshots) return;

      const rawBytes =
        internalDiffSnapshotRawBytes(oldValue) + internalDiffSnapshotRawBytes(current.snapshot);
      if (
        rawBytes > snapshotPerFileMaxRawBytes ||
        rawBytes > snapshotCacheMaxRawBytes - cachedSnapshotRawBytes
      ) {
        diffStoreDeferredPaths.add(workspacePath);
        return;
      }
      // No await between budget check and mutation: concurrent tasks cannot
      // oversubscribe this per-request raw-text budget on the JS event loop.
      cachedSnapshotRawBytes += rawBytes;
      diffStoreSnapshots.set(workspacePath, {
        oldSnapshot: oldValue,
        newSnapshot: current.snapshot,
      });
    };

    const preferredPath = options.preferredDiffStoreSnapshotPath;
    const hasPreferredPath = preferredPath !== undefined && changedPaths.includes(preferredPath);
    if (hasPreferredPath) await processPath(preferredPath);
    await mapWithConcurrency(
      hasPreferredPath
        ? changedPaths.filter((workspacePath) => workspacePath !== preferredPath)
        : changedPaths,
      DEFAULT_CODE_COLLAB_BACKGROUND_CONCURRENCY,
      processPath
    );
    return {
      allChanges: changes,
      ...(includeSnapshots ? { diffStoreSnapshots, diffStoreDeferredPaths } : {}),
    };
  }

  private async ensureWorkspaceWatch(
    resolved: Pick<ResolvedPath, 'ownerSessionId' | 'workspaceRoot'>
  ): Promise<void> {
    if (!this.deps.publishFileIndex || !this.deps.workspaceWatchCoordinator) {
      return;
    }
    const workspaceRoot = path.resolve(resolved.workspaceRoot);
    const existing = this.watchByOwnerSessionId.get(resolved.ownerSessionId);
    if (existing?.workspaceRoot === workspaceRoot) {
      this.armWorkspaceWatchIdleTimer(existing);
      return;
    }
    this.releaseWorkspaceWatch(resolved.ownerSessionId);

    const state: OwnerWorkspaceWatchState = {
      ownerSessionId: resolved.ownerSessionId,
      workspaceRoot,
      subscription: null,
      refreshTimer: null,
      idleTimer: null,
    };
    this.watchByOwnerSessionId.set(resolved.ownerSessionId, state);
    this.armWorkspaceWatchIdleTimer(state);
    const subscription = await this.deps.workspaceWatchCoordinator.subscribe({
      workspaceId: this.deps.workspaceId ?? 'code-collab',
      ownerSessionId: resolved.ownerSessionId,
      workspaceRoot,
      onDirty: () => this.scheduleWatchedWorkspaceRefresh(resolved.ownerSessionId),
    });
    if (this.watchByOwnerSessionId.get(resolved.ownerSessionId) !== state) {
      subscription?.release();
      return;
    }
    state.subscription = subscription;
  }

  private scheduleWatchedWorkspaceRefresh(ownerSessionId: SessionId): void {
    const state = this.watchByOwnerSessionId.get(ownerSessionId);
    if (!state) {
      return;
    }
    if (state.refreshTimer) {
      this.deps.workspaceWatchCoordinator?.recordCoalescedRefresh?.();
      clearTimeout(state.refreshTimer);
    }
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      void this.refreshWatchedWorkspace(ownerSessionId).catch(() => undefined);
    }, 150);
  }

  private async refreshWatchedWorkspace(ownerSessionId: SessionId): Promise<void> {
    const resolved = await this.resolveRequestDirectoryPath(
      ownerSessionId,
      ROOT_DIRECTORY_REQUEST_PATH
    );
    await this.enqueueSharedStateRefresh(resolved.ownerSessionId, {
      kind: 'full',
      resolved,
      forcePublish: false,
      persistAllChangesDiffStats: false,
      publish: true,
    });
  }

  private armWorkspaceWatchIdleTimer(state: OwnerWorkspaceWatchState): void {
    const timeoutMs = this.deps.watchIdleTimeoutMs ?? DEFAULT_CODE_COLLAB_WATCH_IDLE_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return;
    }
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
    }
    state.idleTimer = setTimeout(() => {
      this.releaseWorkspaceWatch(state.ownerSessionId);
    }, timeoutMs);
    state.idleTimer.unref?.();
  }

  private releaseWorkspaceWatch(ownerSessionId: SessionId): void {
    const state = this.watchByOwnerSessionId.get(ownerSessionId);
    if (!state) {
      return;
    }
    state.subscription?.release();
    state.subscription = null;
    if (state.refreshTimer) {
      clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
    }
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
    this.watchByOwnerSessionId.delete(ownerSessionId);
  }

  private async reconcilePathState(resolved: ResolvedPath): Promise<void> {
    const state = this.getOwnerState(resolved.ownerSessionId);
    const fileTreeIndex = buildFileTreePathIndex(state.fileTree);
    const nextFileTreeValue = await classifyPathForFileTree(resolved.absolutePath).catch(
      (error: unknown) => {
        if (isNotFoundError(error) || errorCode(error) === 'ENOENT') {
          deleteFileTreePathAndDescendants(state.fileTree, resolved.workspacePath, fileTreeIndex);
          return undefined;
        }
        return { kind: 'skipped', reason: 'transient_io' } satisfies CodeCollabV2FileTreeValue;
      }
    );
    if (nextFileTreeValue === undefined) {
      deleteFileTreePathAndDescendants(state.fileTree, resolved.workspacePath, fileTreeIndex);
    } else {
      setFileTreePathValue(
        state.fileTree,
        resolved.workspacePath,
        nextFileTreeValue,
        fileTreeIndex
      );
      if (!isLazyDirectoryValue(nextFileTreeValue)) {
        deleteDescendantFileTreeEntries(state.fileTree, resolved.workspacePath, fileTreeIndex);
      }
    }
    await this.computeAllChangesAndPublish(resolved, state, { fileTreeIndex });
  }

  private async resolveCurrentDiffBaseSnapshot(
    resolved: ResolvedPath
  ): Promise<
    | { readonly status: 'ready'; readonly snapshot: InternalDiffSnapshot }
    | { readonly status: 'unavailable' }
  > {
    if (await isInsideGitWorktree(resolved.workspaceRoot)) {
      const base = await resolveAllChangesDiffBase(
        resolved.workspaceRoot,
        resolved.allChangesBaseBranch
      );
      if (base) {
        const gitSnapshot = await readGitBaseDiffSnapshot(
          resolved.workspaceRoot,
          base,
          resolved.workspacePath,
          this.deps.maxRawTextBytes ?? CODE_COLLAB_V2_TEXT_LIMITS.maxRawTextBytes
        );
        if (gitSnapshot.status === 'ready') {
          return gitSnapshot;
        }
      }
    }

    const maxRawTextBytes = this.deps.maxRawTextBytes ?? CODE_COLLAB_V2_TEXT_LIMITS.maxRawTextBytes;
    const storeSnapshot = await this.deps.diffStore?.getEarliestOldSnapshot({
      ownerSessionId: resolved.ownerSessionId,
      path: resolved.workspacePath,
      maxRawBytes: maxRawTextBytes,
    });
    if (!storeSnapshot || storeSnapshot.status === 'unavailable') {
      return { status: 'unavailable' };
    }
    if (storeSnapshot.status === 'too_large') {
      return { status: 'ready', snapshot: { kind: 'too_large' } };
    }
    return {
      status: 'ready',
      snapshot:
        storeSnapshot.text === null
          ? { kind: 'missing' }
          : { kind: 'text', text: storeSnapshot.text },
    };
  }

  private async encodeDiffSnapshot(
    snapshot: InternalDiffSnapshot,
    workspacePath: string
  ): Promise<CodeCollabV2DiffSnapshot> {
    switch (snapshot.kind) {
      case 'text': {
        const bytes = Buffer.from(snapshot.text, 'utf8');
        return {
          kind: 'text',
          text: await this.encodeTextPayload(bytes, workspacePath),
          format: detectTextFormat(bytes),
        };
      }
      case 'missing':
        return { kind: 'missing' };
      case 'binary':
        return { kind: 'binary' };
      case 'too_large':
        return { kind: 'too_large' };
    }
    const exhaustive: never = snapshot;
    throw new Error(`Unsupported Code Collab v2 diff snapshot: ${String(exhaustive)}`);
  }

  private async publishOwnerState(
    ownerSessionId: SessionId,
    state: OwnerSharedState,
    options: SharedStatePublishOptions = {}
  ): Promise<void> {
    await this.enqueueOwnerPublication(
      ownerSessionId,
      async () => await this.publishOwnerStateNow(ownerSessionId, state, options)
    );
  }

  private async publishOwnerStateNow(
    ownerSessionId: SessionId,
    state: OwnerSharedState,
    options: SharedStatePublishOptions
  ): Promise<void> {
    const startedAtMs = Date.now();
    if (!this.deps.publishFileIndex || this.disposed) {
      return;
    }
    const cloneStartedAtMs = Date.now();
    const fileTree = cloneFileTreeState(state.fileTree);
    const allChanges = cloneAllChangesState(state.allChanges);
    const cloneMs = Date.now() - cloneStartedAtMs;
    const buildStartedAtMs = Date.now();
    const fileIndex = buildCodeCollabFileIndexState(fileTree, allChanges);
    const buildMs = Date.now() - buildStartedAtMs;
    await this.publishPreparedOwnerFileIndexNow(ownerSessionId, fileIndex, options, {
      startedAtMs,
      cloneMs,
      buildMs,
    });
  }

  private async publishPreparedOwnerFileIndex(
    ownerSessionId: SessionId,
    fileIndex: CodeCollabV2FileIndexState,
    options: SharedStatePublishOptions = {},
    metrics: {
      readonly startedAtMs?: number;
      readonly cloneMs?: number;
      readonly buildMs?: number;
      readonly workerMs?: number;
    } = {}
  ): Promise<void> {
    await this.enqueueOwnerPublication(ownerSessionId, async () => {
      if (this.disposed) {
        return;
      }
      await this.publishPreparedOwnerFileIndexNow(ownerSessionId, fileIndex, options, metrics);
    });
  }

  private async publishPreparedOwnerFileIndexNow(
    ownerSessionId: SessionId,
    fileIndex: CodeCollabV2FileIndexState,
    options: SharedStatePublishOptions,
    metrics: {
      readonly startedAtMs?: number;
      readonly cloneMs?: number;
      readonly buildMs?: number;
      readonly workerMs?: number;
    }
  ): Promise<void> {
    const startedAtMs = metrics.startedAtMs ?? Date.now();
    const publishFileIndex = this.deps.publishFileIndex;
    const publishFileIndexSignal = this.deps.publishFileIndexSignal;
    if (!publishFileIndex) {
      return;
    }

    const pathCount = Object.keys(fileIndex).length;
    const updatedAtMs = getServerNow();
    const previous = this.publishedStateByOwnerSessionId.get(ownerSessionId);
    const equalityStartedAtMs = Date.now();
    const sameFileIndex = previous && codeCollabFileIndexStatesEqual(previous.fileIndex, fileIndex);
    const persistedAllChangesDiffStats = options.persistAllChangesDiffStats === true;
    const equalityMs = Date.now() - equalityStartedAtMs;
    if (
      sameFileIndex &&
      options.forcePublish !== true &&
      (!persistedAllChangesDiffStats || previous.persistedAllChangesDiffStats)
    ) {
      this.logger.debug(
        `[code-collab] file-index publish skipped ownerSessionId=${ownerSessionId} paths=${pathCount} durationMs=${
          Date.now() - startedAtMs
        } cloneMs=${metrics.cloneMs ?? 0} buildMs=${metrics.buildMs ?? 0} equalityMs=${equalityMs}${
          metrics.workerMs === undefined ? '' : ` workerMs=${metrics.workerMs}`
        }`
      );
      return;
    }

    const nextPublishedState: OwnerPublishedSharedState = {
      fileIndex,
      persistedAllChangesDiffStats:
        persistedAllChangesDiffStats ||
        (sameFileIndex === true && previous.persistedAllChangesDiffStats),
    };
    this.publishedStateByOwnerSessionId.set(ownerSessionId, nextPublishedState);
    const publishStartedAtMs = Date.now();
    try {
      let publishResult: CodeCollabV2FileIndexPublishResult | void;
      try {
        publishResult = await publishFileIndex({
          ownerSessionId,
          fileIndex,
          allChangesDiffStats: summarizeFileIndexAllChanges(fileIndex),
          persistAllChangesDiffStats: options.persistAllChangesDiffStats === true,
          updatedAtMs,
          reconcileRemote: options.forcePublish === true || previous === undefined,
        });
      } catch (error) {
        if (error instanceof CodeCollabFileIndexChangedPublishError) {
          this.pendingFileIndexSignalByOwnerSessionId.add(ownerSessionId);
        }
        throw error;
      }
      const shouldPublishSignal =
        publishResult?.changed !== false ||
        sameFileIndex !== true ||
        this.pendingFileIndexSignalByOwnerSessionId.has(ownerSessionId);
      if (publishFileIndexSignal && shouldPublishSignal) {
        this.pendingFileIndexSignalByOwnerSessionId.add(ownerSessionId);
        await publishFileIndexSignal({
          ownerSessionId,
          updatedAtMs,
        });
        this.pendingFileIndexSignalByOwnerSessionId.delete(ownerSessionId);
      }
      const publishMs = Date.now() - publishStartedAtMs;
      this.logger.info(
        `[code-collab] file-index publish completed ownerSessionId=${ownerSessionId} paths=${pathCount} durationMs=${
          Date.now() - startedAtMs
        } cloneMs=${metrics.cloneMs ?? 0} buildMs=${
          metrics.buildMs ?? 0
        } equalityMs=${equalityMs} publishMs=${publishMs} force=${options.forcePublish === true}${
          metrics.workerMs === undefined ? '' : ` workerMs=${metrics.workerMs}`
        }`
      );
      this.clearOwnerFileIndexRepair(ownerSessionId);
    } catch (error) {
      if (this.publishedStateByOwnerSessionId.get(ownerSessionId) === nextPublishedState) {
        if (previous) {
          this.publishedStateByOwnerSessionId.set(ownerSessionId, previous);
        } else {
          this.publishedStateByOwnerSessionId.delete(ownerSessionId);
        }
      }
      this.scheduleOwnerFileIndexRepair(ownerSessionId, {
        persistAllChangesDiffStats: persistedAllChangesDiffStats,
      });
      throw error;
    }
  }

  private scheduleOwnerFileIndexRepair(
    ownerSessionId: SessionId,
    options: { readonly persistAllChangesDiffStats: boolean }
  ): void {
    if (this.disposed || !this.deps.publishFileIndex) {
      return;
    }

    let repair = this.fileIndexRepairByOwnerSessionId.get(ownerSessionId);
    if (!repair) {
      repair = {
        attempt: 0,
        timer: null,
        persistAllChangesDiffStats: options.persistAllChangesDiffStats,
      };
      this.fileIndexRepairByOwnerSessionId.set(ownerSessionId, repair);
    } else if (options.persistAllChangesDiffStats) {
      repair.persistAllChangesDiffStats = true;
    }
    if (repair.timer) {
      return;
    }

    const attempt = repair.attempt;
    const delayMs = this.computeFileIndexRepairDelayMs(attempt);
    repair.attempt += 1;
    this.logger.debug(
      `[code-collab] scheduling targeted file-index repair ownerSessionId=${ownerSessionId} delayMs=${delayMs} attempt=${repair.attempt}`
    );
    repair.timer = setTimeout(() => {
      if (this.disposed || this.fileIndexRepairByOwnerSessionId.get(ownerSessionId) !== repair) {
        return;
      }
      repair.timer = null;
      void this.enqueueOwnerPublication(ownerSessionId, async () => {
        if (this.disposed || this.fileIndexRepairByOwnerSessionId.get(ownerSessionId) !== repair) {
          return;
        }
        const state = this.stateByOwnerSessionId.get(ownerSessionId);
        if (!state) {
          this.fileIndexRepairByOwnerSessionId.delete(ownerSessionId);
          return;
        }
        await this.publishOwnerStateNow(ownerSessionId, state, {
          forcePublish: true,
          persistAllChangesDiffStats: repair.persistAllChangesDiffStats,
        });
      }).catch((error: unknown) => {
        this.logger.debug(
          `[code-collab] targeted file-index repair failed ownerSessionId=${ownerSessionId}: ${formatErrorMessage(
            error
          )}`
        );
      });
    }, delayMs);
    repair.timer.unref?.();
  }

  private clearOwnerFileIndexRepair(ownerSessionId: SessionId): void {
    const repair = this.fileIndexRepairByOwnerSessionId.get(ownerSessionId);
    if (!repair) {
      return;
    }
    if (repair.timer) {
      clearTimeout(repair.timer);
    }
    this.fileIndexRepairByOwnerSessionId.delete(ownerSessionId);
  }

  private computeFileIndexRepairDelayMs(attempt: number): number {
    const safeAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
    const baseDelayMs = Math.max(
      0,
      this.deps.fileIndexRepairBaseDelayMs ?? DEFAULT_FILE_INDEX_REPAIR_BASE_DELAY_MS
    );
    const maxDelayMs = Math.max(
      baseDelayMs,
      this.deps.fileIndexRepairMaxDelayMs ?? DEFAULT_FILE_INDEX_REPAIR_MAX_DELAY_MS
    );
    const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** safeAttempt);
    const random = this.deps.fileIndexRepairRandom ?? Math.random;
    const jitter =
      exponentialDelay *
      FILE_INDEX_REPAIR_JITTER_FRACTION *
      (Math.min(1, Math.max(0, random())) * 2 - 1);
    return Math.min(maxDelayMs, Math.max(0, Math.round(exponentialDelay + jitter)));
  }

  private enqueueOwnerPublication(
    ownerSessionId: SessionId,
    task: () => Promise<void>
  ): Promise<void> {
    const previous = this.publishChainByOwnerSessionId.get(ownerSessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    const settled = result.then(
      () => undefined,
      () => undefined
    );
    this.publishChainByOwnerSessionId.set(ownerSessionId, settled);
    void settled.finally(() => {
      if (this.publishChainByOwnerSessionId.get(ownerSessionId) === settled) {
        this.publishChainByOwnerSessionId.delete(ownerSessionId);
      }
    });
    return result;
  }
}

function cloneFileTreeValue(value: CodeCollabV2FileTreeValue): CodeCollabV2FileTreeValue {
  return value === true ? true : { ...value };
}

function cloneFileTreeState(state: CodeCollabV2FileTreeState): CodeCollabV2FileTreeState {
  const next: CodeCollabV2FileTreeState = {};
  for (const [workspacePath, value] of Object.entries(state)) {
    next[workspacePath] = cloneFileTreeValue(value);
  }
  return next;
}

function cloneAllChangesValue(value: CodeCollabV2AllChangesValue): CodeCollabV2AllChangesValue {
  if (value === true) return true;
  return {
    ...(value.diff === undefined ? {} : { diff: [value.diff[0], value.diff[1]] }),
    ...(value.del === true ? { del: true } : {}),
  };
}

function cloneAllChangesState(state: CodeCollabV2AllChangesState): CodeCollabV2AllChangesState {
  const next: CodeCollabV2AllChangesState = {};
  for (const [workspacePath, value] of Object.entries(state)) {
    next[workspacePath] = cloneAllChangesValue(value);
  }
  return next;
}

function summarizeFileIndexAllChanges(
  fileIndex: CodeCollabV2FileIndexState
): SessionDiffStats | null {
  let add = 0;
  let del = 0;
  for (const value of Object.values(fileIndex)) {
    const change = value === true || !('change' in value) ? undefined : value.change;
    if (change === undefined) {
      continue;
    }
    if (change === true || change.diff === undefined) {
      return null;
    }
    add += change.diff[0];
    del += change.diff[1];
  }
  return { allChange: { add, del } };
}

function normalizeWorkspacePath(
  input: string,
  options: { readonly allowRoot?: boolean } = {}
): string {
  if (input.length === 0) {
    throw new CodeCollabV2ServiceError('invalid_path', 'Path is required.');
  }
  if (input.includes('\0') || input.includes('\\')) {
    throw new CodeCollabV2ServiceError('invalid_path', 'Path contains invalid characters.', {
      path: input,
    });
  }
  if (path.posix.isAbsolute(input) || path.win32.isAbsolute(input) || /^[A-Za-z]:/u.test(input)) {
    throw new CodeCollabV2ServiceError('invalid_path', 'Absolute paths are not allowed.', {
      path: input,
    });
  }
  const normalized = path.posix.normalize(input.normalize('NFC'));
  if (normalized === '.') {
    if (options.allowRoot === true) {
      return '';
    }
    throw new CodeCollabV2ServiceError('invalid_path', 'Path is required.', { path: input });
  }
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new CodeCollabV2ServiceError('invalid_path', 'Path escapes workspace root.', {
      path: input,
    });
  }
  return normalized;
}

function resolveWorkspaceRelativeRequestPath(workspaceRoot: string, input: string): string {
  if (!path.isAbsolute(input)) {
    return input;
  }

  const relative = path.relative(workspaceRoot, path.resolve(input));
  if (isPathOutsideRoot(relative)) {
    throw new CodeCollabV2ServiceError('invalid_path', 'Path escapes workspace root.', {
      path: input,
    });
  }
  return relative.split(path.sep).join('/');
}

function isPathOutsideRoot(relativePath: string): boolean {
  return (
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  );
}

async function stableReadFile(resolved: ResolvedPath, maxBytes: number): Promise<StableRead> {
  let lastTransientError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await lstat(resolved.absolutePath).catch((error: unknown) => {
      throw mapNodeReadError(error, resolved.workspacePath);
    });
    if (before.isSymbolicLink()) {
      throw new CodeCollabV2ServiceError('unsupported_skipped', 'Symlinks are not supported.', {
        path: resolved.workspacePath,
      });
    }
    if (!before.isFile()) {
      throw new CodeCollabV2ServiceError('unsupported_skipped', 'Path is not a regular file.', {
        path: resolved.workspacePath,
      });
    }
    if (before.size > maxBytes) {
      throw new CodeCollabV2ServiceError('too_large', `Text exceeds ${maxBytes} bytes.`, {
        path: resolved.workspacePath,
      });
    }
    await assertRealPathInsideWorkspace(resolved);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(resolved.absolutePath);
    } catch (error) {
      if (isTransientReadError(error)) {
        lastTransientError = error;
        continue;
      }
      throw mapNodeReadError(error, resolved.workspacePath);
    }
    const after = await lstat(resolved.absolutePath).catch((error: unknown) => {
      throw mapNodeReadError(error, resolved.workspacePath);
    });
    if (
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs &&
      before.dev === after.dev &&
      before.ino === after.ino &&
      after.size === bytes.byteLength
    ) {
      return { bytes: new Uint8Array(bytes) };
    }
  }
  throw new CodeCollabV2ServiceError('transient_io', 'File changed while reading.', {
    path: resolved.workspacePath,
    retryable: true,
    cause: lastTransientError,
  });
}

async function readCurrentDiffSnapshot(
  resolved: Pick<ResolvedPath, 'absolutePath' | 'workspacePath' | 'workspaceRoot'>,
  maxBytes: number
): Promise<
  | { readonly status: 'ready'; readonly snapshot: InternalDiffSnapshot }
  | { readonly status: 'unavailable'; readonly message: string }
> {
  try {
    const read = await stableReadFile(
      {
        ownerSessionId: '' as SessionId,
        ...resolved,
      },
      maxBytes
    );
    if (hasBinaryNul(read.bytes)) {
      return { status: 'ready', snapshot: { kind: 'binary' } };
    }
    try {
      return { status: 'ready', snapshot: { kind: 'text', text: decodeUtf8(read.bytes) } };
    } catch {
      return { status: 'ready', snapshot: { kind: 'binary' } };
    }
  } catch (error) {
    if (
      isNotFoundError(error) ||
      (isCodeCollabV2ServiceError(error) && error.code === 'file_not_found')
    ) {
      return { status: 'ready', snapshot: { kind: 'missing' } };
    }
    if (isCodeCollabV2ServiceError(error) && error.code === 'too_large') {
      return { status: 'ready', snapshot: { kind: 'too_large' } };
    }
    if (
      isCodeCollabV2ServiceError(error) &&
      (error.code === 'unsupported_binary' ||
        error.code === 'unsupported_skipped' ||
        error.code === 'decode_error')
    ) {
      return { status: 'ready', snapshot: { kind: 'binary' } };
    }
    return {
      status: 'unavailable',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function assertRealPathInsideWorkspace(resolved: ResolvedPath): Promise<void> {
  const [rootRealpath, fileRealpath] = await Promise.all([
    realpath(resolved.workspaceRoot),
    realpath(resolved.absolutePath),
  ]).catch((error: unknown) => {
    throw mapNodeReadError(error, resolved.workspacePath);
  });
  const relative = path.relative(rootRealpath, fileRealpath);
  if (isPathOutsideRoot(relative)) {
    throw new CodeCollabV2ServiceError('invalid_path', 'Resolved path escapes workspace root.', {
      path: resolved.workspacePath,
    });
  }
}

async function writeFileAtomically(
  absolutePath: string,
  bytes: Uint8Array,
  workspacePath: string
): Promise<void> {
  const temporaryPath = `${absolutePath}.lody-save-${process.pid}-${randomUUID()}.tmp`;
  // writeFile's mode is still masked by umask. chmod the temp file before rename
  // so an existing 0755 script does not become 0644/0664 and lose +x.
  const preserveMode =
    process.platform === 'win32'
      ? undefined
      : await lstat(absolutePath)
          .then((existing) => (existing.isFile() ? existing.mode & 0o777 : undefined))
          .catch(() => undefined);
  try {
    await writeFile(temporaryPath, bytes, { mode: 0o666 });
    if (preserveMode !== undefined) {
      await chmod(temporaryPath, preserveMode);
    }
    await rename(temporaryPath, absolutePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw new CodeCollabV2ServiceError('transient_io', 'Failed to write file.', {
      path: workspacePath,
      retryable: true,
      cause: error,
    });
  }
}

function digestBytes(bytes: Uint8Array): CodeCollabV2FileDigest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * Stream a file through SHA-256 without loading it into memory. Used to report a disk digest in
 * save conflicts when the file is too large to return as text. Best-effort: the caller treats a
 * rejection as "digest unavailable".
 */
async function streamFileDigest(resolved: ResolvedPath): Promise<CodeCollabV2FileDigest> {
  await assertRealPathInsideWorkspace(resolved);
  const hash = createHash('sha256');
  const handle = await open(resolved.absolutePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return `sha256:${hash.digest('hex')}`;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

function detectTextFormat(bytes: Uint8Array): CodeCollabV2TextFormat {
  return {
    encoding: 'utf8',
    bom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
    eol: detectEol(decodeUtf8(bytes)),
  };
}

function detectEol(text: string): CodeCollabV2TextFormat['eol'] {
  const crlfCount = text.match(/\r\n/gu)?.length ?? 0;
  const withoutCrlf = text.replace(/\r\n/gu, '');
  const lfCount = withoutCrlf.match(/\n/gu)?.length ?? 0;
  const crCount = withoutCrlf.match(/\r/gu)?.length ?? 0;
  if (crCount > 0 || (crlfCount > 0 && lfCount > 0)) return 'mixed';
  if (crlfCount > 0) return 'crlf';
  if (lfCount > 0) return 'lf';
  return 'unknown';
}

function normalizeTextEol(text: string, eol: 'lf' | 'crlf'): string {
  const normalized = text.replace(/\r\n|\r|\n/gu, '\n');
  return eol === 'lf' ? normalized : normalized.replace(/\n/gu, '\r\n');
}

function hasBinaryNul(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.byteLength, 8 * 1024);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

function isNotFoundError(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function isTransientReadError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'EBUSY' || code === 'EAGAIN' || code === 'ETXTBSY';
}

function mapNodeReadError(error: unknown, workspacePath: string): CodeCollabV2ServiceError {
  const code = errorCode(error);
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new CodeCollabV2ServiceError('file_not_found', 'File was not found.', {
      path: workspacePath,
    });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new CodeCollabV2ServiceError('permission_denied', 'Permission denied.', {
      path: workspacePath,
      cause: error,
    });
  }
  return new CodeCollabV2ServiceError('transient_io', 'File operation failed.', {
    path: workspacePath,
    retryable: true,
    cause: error,
  });
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

async function scanDirectoryEntries(options: {
  readonly directoryAbsolutePath: string;
  readonly directoryWorkspacePath: string;
  readonly maxRawTextBytes: number;
  readonly entryBudget: number;
  readonly recursive: boolean;
}): Promise<Map<string, CodeCollabV2FileTreeValue>> {
  const gitEntries = await scanGitDirectoryEntries(options);
  if (gitEntries) {
    return gitEntries;
  }

  const entries = new Map<string, CodeCollabV2FileTreeValue>();
  const queue: Array<{ readonly absolutePath: string; readonly workspacePath: string }> = [
    {
      absolutePath: options.directoryAbsolutePath,
      workspacePath: options.directoryWorkspacePath,
    },
  ];
  let remainingEntries = Math.max(0, options.entryBudget);

  while (queue.length > 0 && remainingEntries > 0) {
    const currentDirectory = queue.shift();
    if (!currentDirectory) {
      break;
    }

    const directoryEntries = await readDirectoryEntriesForScan(currentDirectory).catch(
      (error: unknown) => {
        if (currentDirectory.workspacePath === options.directoryWorkspacePath) {
          throw error;
        }
        entries.set(currentDirectory.workspacePath, scanDirectoryReadErrorValue(error));
        return null;
      }
    );
    if (!directoryEntries) {
      continue;
    }
    const collisionKeys = findDirectoryEntryCollisionKeys(directoryEntries);
    for (const { entry, comparisonKey } of directoryEntries) {
      if (remainingEntries <= 0) {
        break;
      }
      const workspacePath = joinWorkspacePath(currentDirectory.workspacePath, entry.name);
      const absolutePath = path.join(currentDirectory.absolutePath, entry.name);
      const value = collisionKeys.has(comparisonKey)
        ? ({ kind: 'skipped', reason: 'path_conflict' } as const)
        : classifyDirectoryEntry(entry);
      if (value === undefined) {
        continue;
      }
      entries.set(workspacePath, value);
      remainingEntries -= 1;
      if (options.recursive && isLazyDirectoryValue(value) && remainingEntries > 0) {
        queue.push({ absolutePath, workspacePath });
      }
    }
  }
  return entries;
}

function scanDirectoryReadErrorValue(error: unknown): CodeCollabV2FileTreeValue {
  if (isCodeCollabV2ServiceError(error)) {
    if (error.code === 'permission_denied') {
      return { kind: 'skipped', reason: 'permission_denied' };
    }
    if (error.code === 'file_not_found') {
      return { kind: 'skipped', reason: 'not_found' };
    }
  }
  return { kind: 'skipped', reason: 'transient_io' };
}

async function readDirectoryEntriesForScan(directoryPath: {
  readonly absolutePath: string;
  readonly workspacePath: string;
}): Promise<
  Array<{
    readonly entry: {
      readonly name: string;
      isDirectory(): boolean;
      isFile(): boolean;
      isSymbolicLink(): boolean;
    };
    readonly comparisonKey: string;
  }>
> {
  const directory = await opendir(directoryPath.absolutePath).catch((error: unknown) => {
    throw mapNodeReadError(error, directoryPath.workspacePath || ROOT_DIRECTORY_REQUEST_PATH);
  });
  try {
    const directoryEntries: Array<{
      readonly entry: {
        readonly name: string;
        isDirectory(): boolean;
        isFile(): boolean;
        isSymbolicLink(): boolean;
      };
      readonly comparisonKey: string;
    }> = [];
    for await (const entry of directory) {
      if (entry.name === '.' || entry.name === '..') {
        continue;
      }
      directoryEntries.push({
        entry,
        comparisonKey: pathSegmentComparisonKey(entry.name),
      });
    }
    return directoryEntries.sort((left, right) => {
      const keyOrder = left.comparisonKey.localeCompare(right.comparisonKey);
      return keyOrder === 0 ? left.entry.name.localeCompare(right.entry.name) : keyOrder;
    });
  } finally {
    await closeDirectoryQuietly(directory);
  }
}

function classifyDirectoryEntry(entry: {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): CodeCollabV2FileTreeValue | undefined {
  if (entry.isDirectory()) {
    return CODE_COLLAB_IGNORED_DIRECTORY_NAMES.has(entry.name)
      ? undefined
      : ({ kind: 'lazy' } as const);
  }
  if (entry.isSymbolicLink()) {
    return { kind: 'skipped', reason: 'symlink' };
  }
  if (!entry.isFile()) {
    return { kind: 'skipped', reason: 'special' };
  }
  return true;
}

async function classifyPathForFileTree(absolutePath: string): Promise<CodeCollabV2FileTreeValue> {
  const stat = await lstat(absolutePath);
  if (stat.isDirectory()) {
    return { kind: 'lazy' };
  }
  if (stat.isSymbolicLink()) {
    return { kind: 'skipped', reason: 'symlink' };
  }
  if (!stat.isFile()) {
    return { kind: 'skipped', reason: 'special' };
  }
  return true;
}

function joinWorkspacePath(parent: string, child: string): string {
  return (parent ? `${parent}/${child}` : child).normalize('NFC');
}

async function resolveExistingPathWithoutConflicts(
  workspaceRoot: string,
  workspacePath: string,
  requestedPath: string
): Promise<string | null> {
  if (!workspacePath) {
    return workspaceRoot;
  }
  let absolutePath = workspaceRoot;
  for (const segment of workspacePath.split('/')) {
    const entries = await readdir(absolutePath, { withFileTypes: true }).catch((error: unknown) => {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return null;
      }
      throw mapNodeReadError(error, requestedPath);
    });
    if (entries === null) {
      return null;
    }
    const comparisonKey = pathSegmentComparisonKey(segment);
    const matchingEntries = entries.filter(
      (entry) => pathSegmentComparisonKey(entry.name) === comparisonKey
    );
    const uniqueNames = new Set(matchingEntries.map((entry) => entry.name));
    if (uniqueNames.size > 1) {
      throw new CodeCollabV2ServiceError(
        'path_conflict',
        'Path is ambiguous because multiple filesystem entries differ only by case or Unicode normalization.',
        { path: requestedPath }
      );
    }
    const match =
      matchingEntries.find((entry) => entry.name === segment) ??
      matchingEntries.find((entry) => entry.name.normalize('NFC') === segment);
    if (!match) {
      return null;
    }
    absolutePath = path.join(absolutePath, match.name);
  }
  return absolutePath;
}

function pathSegmentComparisonKey(segment: string): string {
  return segment.normalize('NFC').toLocaleLowerCase('en-US');
}

function findDirectoryEntryCollisionKeys(
  entries: readonly { readonly entry: { readonly name: string }; readonly comparisonKey: string }[]
): Set<string> {
  const namesByKey = new Map<string, Set<string>>();
  for (const { entry, comparisonKey } of entries) {
    const names = namesByKey.get(comparisonKey);
    if (names) {
      names.add(entry.name);
    } else {
      namesByKey.set(comparisonKey, new Set([entry.name]));
    }
  }
  const collisionKeys = new Set<string>();
  for (const [comparisonKey, names] of namesByKey) {
    if (names.size > 1) {
      collisionKeys.add(comparisonKey);
    }
  }
  return collisionKeys;
}

function collectExpandedDirectoryPaths(fileTree: CodeCollabV2FileTreeState): string[] {
  const expanded = new Set<string>();
  for (const workspacePath of Object.keys(fileTree)) {
    const segments = workspacePath.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      expanded.add(segments.slice(0, index).join('/'));
    }
  }
  return [...expanded].sort((left, right) => pathDepth(left) - pathDepth(right));
}

function isLazyDirectoryValue(value: CodeCollabV2FileTreeValue | undefined): boolean {
  return value !== undefined && value !== true && value.kind === 'lazy';
}

function mergeQueuedSharedStateRefresh(
  current: QueuedSharedStateRefresh | null,
  next: QueuedSharedStateRefresh
): QueuedSharedStateRefresh {
  if (!current) {
    return next;
  }
  return {
    kind: current.kind === 'full' || next.kind === 'full' ? 'full' : 'turn',
    resolved: next.resolved,
    forcePublish: current.forcePublish || next.forcePublish,
    persistAllChangesDiffStats:
      current.persistAllChangesDiffStats || next.persistAllChangesDiffStats,
    // A normal refresh must still replicate when it coalesces with an IPC-only
    // snapshot read; the inverse must never make normal work skip publication.
    publish: current.publish || next.publish,
  };
}

function collectTurnRefreshCandidatePaths(
  allChanges: CodeCollabV2AllChangesState,
  diffStorePaths: readonly string[]
): readonly string[] {
  return [...new Set([...Object.keys(allChanges), ...diffStorePaths])].sort();
}

function collectCandidateDirectoryPaths(workspacePaths: readonly string[]): readonly string[] {
  const directories = new Set<string>(['']);
  for (const workspacePath of workspacePaths) {
    const segments = workspacePath.split('/').filter((segment) => segment.length > 0);
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join('/'));
    }
  }
  return [...directories].sort((left, right) => pathDepth(left) - pathDepth(right));
}

function buildFileTreePathIndex(fileTree: CodeCollabV2FileTreeState): FileTreePathIndex {
  const index: FileTreePathIndex = { childrenByDirectory: new Map() };
  for (const workspacePath of Object.keys(fileTree)) {
    addFileTreePathToIndex(index, workspacePath);
  }
  return index;
}

function setFileTreePathValue(
  fileTree: CodeCollabV2FileTreeState,
  workspacePath: string,
  value: CodeCollabV2FileTreeValue,
  index?: FileTreePathIndex
): void {
  fileTree[workspacePath] = value;
  if (index) {
    addFileTreePathToIndex(index, workspacePath);
  }
}

function replaceFileTreeEntries(
  fileTree: CodeCollabV2FileTreeState,
  nextEntries: ReadonlyMap<string, CodeCollabV2FileTreeValue>,
  index?: FileTreePathIndex
): void {
  for (const workspacePath of Object.keys(fileTree)) {
    delete fileTree[workspacePath];
  }
  index?.childrenByDirectory.clear();
  for (const [workspacePath, value] of nextEntries) {
    setFileTreePathValue(fileTree, workspacePath, value, index);
  }
}

function replaceDirectoryTreeEntries(
  fileTree: CodeCollabV2FileTreeState,
  directoryWorkspacePath: string,
  nextEntries: ReadonlyMap<string, CodeCollabV2FileTreeValue>,
  index?: FileTreePathIndex
): void {
  deleteDescendantFileTreeEntries(fileTree, directoryWorkspacePath, index);
  for (const [workspacePath, value] of nextEntries) {
    setFileTreePathValue(fileTree, workspacePath, value, index);
  }
}

function replaceImmediateDirectoryEntries(
  fileTree: CodeCollabV2FileTreeState,
  directoryWorkspacePath: string,
  nextEntries: ReadonlyMap<string, CodeCollabV2FileTreeValue>,
  index?: FileTreePathIndex
): void {
  const existingPaths = index
    ? [...(index.childrenByDirectory.get(directoryWorkspacePath) ?? [])]
    : Object.keys(fileTree).filter((existingPath) =>
        isImmediateChildPath(directoryWorkspacePath, existingPath)
      );
  for (const existingPath of existingPaths) {
    const nextValue = nextEntries.get(existingPath);
    if (nextValue !== undefined) {
      if (nextValue === true || nextValue.kind !== 'lazy') {
        deleteDescendantFileTreeEntries(fileTree, existingPath, index);
      }
      continue;
    }
    deleteDescendantFileTreeEntries(fileTree, existingPath, index);
    delete fileTree[existingPath];
    if (index) {
      removeFileTreePathFromIndex(index, existingPath);
    }
  }
}

function deleteFileTreePathAndDescendants(
  fileTree: CodeCollabV2FileTreeState,
  workspacePath: string,
  index?: FileTreePathIndex
): void {
  deleteDescendantFileTreeEntries(fileTree, workspacePath, index);
  delete fileTree[workspacePath];
  if (index) {
    removeFileTreePathFromIndex(index, workspacePath);
  }
}

function deleteDescendantFileTreeEntries(
  fileTree: CodeCollabV2FileTreeState,
  workspacePath: string,
  index?: FileTreePathIndex
): void {
  if (index) {
    const stack = [...(index.childrenByDirectory.get(workspacePath) ?? [])];
    for (let cursor = 0; cursor < stack.length; cursor += 1) {
      const existingPath = stack[cursor]!;
      const children = index.childrenByDirectory.get(existingPath);
      if (children) {
        stack.push(...children);
      }
      delete fileTree[existingPath];
      removeFileTreePathFromIndex(index, existingPath);
    }
    index.childrenByDirectory.delete(workspacePath);
    return;
  }
  const prefix = `${workspacePath}/`;
  for (const existingPath of Object.keys(fileTree)) {
    if (existingPath.startsWith(prefix)) {
      delete fileTree[existingPath];
    }
  }
}

function addFileTreePathToIndex(index: FileTreePathIndex, workspacePath: string): void {
  const parent = parentWorkspacePath(workspacePath);
  let children = index.childrenByDirectory.get(parent);
  if (!children) {
    children = new Set();
    index.childrenByDirectory.set(parent, children);
  }
  children.add(workspacePath);
}

function removeFileTreePathFromIndex(index: FileTreePathIndex, workspacePath: string): void {
  const parent = parentWorkspacePath(workspacePath);
  const children = index.childrenByDirectory.get(parent);
  if (children) {
    children.delete(workspacePath);
    if (children.size === 0) {
      index.childrenByDirectory.delete(parent);
    }
  }
  index.childrenByDirectory.delete(workspacePath);
}

function parentWorkspacePath(workspacePath: string): string {
  const index = workspacePath.lastIndexOf('/');
  return index === -1 ? '' : workspacePath.slice(0, index);
}

function isImmediateChildPath(directoryWorkspacePath: string, candidatePath: string): boolean {
  const prefix = directoryWorkspacePath ? `${directoryWorkspacePath}/` : '';
  if (!candidatePath.startsWith(prefix)) {
    return false;
  }
  const remainder = candidatePath.slice(prefix.length);
  return remainder.length > 0 && !remainder.includes('/');
}

function pathDepth(workspacePath: string): number {
  return workspacePath.split('/').length;
}

async function isInsideGitWorktree(workspaceRoot: string): Promise<boolean> {
  const inside = await runGit(workspaceRoot, ['rev-parse', '--is-inside-work-tree']);
  return inside.ok && inside.stdout.trim() === 'true';
}

async function readGitBaseDiffSnapshot(
  workspaceRoot: string,
  baseCommit: string,
  workspacePath: string,
  maxBytes: number
): Promise<
  | { readonly status: 'ready'; readonly snapshot: InternalDiffSnapshot }
  | { readonly status: 'unavailable' }
> {
  const objectSpec = `${baseCommit}:${workspacePath}`;
  const exists = await runGit(workspaceRoot, ['cat-file', '-e', objectSpec]);
  if (!exists.ok) {
    return { status: 'ready', snapshot: { kind: 'missing' } };
  }
  const objectType = await runGit(workspaceRoot, ['cat-file', '-t', objectSpec]);
  if (!objectType.ok || objectType.stdout.trim() !== 'blob') {
    return { status: 'ready', snapshot: { kind: 'binary' } };
  }
  const objectSize = await runGit(workspaceRoot, ['cat-file', '-s', objectSpec]);
  const size = Number(objectSize.ok ? objectSize.stdout.trim() : NaN);
  if (Number.isFinite(size) && size > maxBytes) {
    return { status: 'ready', snapshot: { kind: 'too_large' } };
  }
  const blob = await runGitBuffer(workspaceRoot, ['show', objectSpec], maxBytes + 1);
  if (!blob.ok) {
    return { status: 'unavailable' };
  }
  if (blob.stdout.byteLength > maxBytes) {
    return { status: 'ready', snapshot: { kind: 'too_large' } };
  }
  if (hasBinaryNul(blob.stdout)) {
    return { status: 'ready', snapshot: { kind: 'binary' } };
  }
  try {
    return { status: 'ready', snapshot: { kind: 'text', text: decodeUtf8(blob.stdout) } };
  } catch {
    return { status: 'ready', snapshot: { kind: 'binary' } };
  }
}

async function resolveAllChangesDiffBase(
  workspaceRoot: string,
  preferredBaseBranch?: string
): Promise<string | null> {
  const inside = await runGit(workspaceRoot, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return null;
  }

  const baseRef = await resolveAllChangesBaseRef(workspaceRoot, preferredBaseBranch);
  if (baseRef) {
    const mergeBase = await runGit(workspaceRoot, ['merge-base', baseRef, 'HEAD']);
    const trimmed = mergeBase.ok ? mergeBase.stdout.trim() : '';
    if (trimmed) {
      return trimmed;
    }
  }

  const head = await runGit(workspaceRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
  return head.ok && head.stdout.trim() ? 'HEAD' : null;
}

async function resolveAllChangesBaseRef(
  workspaceRoot: string,
  preferredBaseBranch?: string
): Promise<string | null> {
  const candidates = [
    ...(preferredBaseBranch ? [`origin/${preferredBaseBranch}`, preferredBaseBranch] : []),
    'origin/main',
    'main',
    'origin/master',
    'master',
    'origin/HEAD',
  ];
  for (const candidate of candidates) {
    const exists = await runGit(workspaceRoot, ['rev-parse', '--verify', `${candidate}^{commit}`]);
    if (exists.ok) {
      return candidate;
    }
  }
  return null;
}

async function diffSnapshotLineStats(
  oldSnapshot: InternalDiffSnapshot,
  newSnapshot: InternalDiffSnapshot
): Promise<[number, number] | undefined> {
  if (oldSnapshot.kind === 'text' && newSnapshot.kind === 'text') {
    return computeLineCountsAsync(oldSnapshot.text, newSnapshot.text);
  }
  if (oldSnapshot.kind === 'missing' && newSnapshot.kind === 'text') {
    return [countTextLines(newSnapshot.text), 0];
  }
  if (oldSnapshot.kind === 'text' && newSnapshot.kind === 'missing') {
    return [0, countTextLines(oldSnapshot.text)];
  }
  return undefined;
}

function areDiffSnapshotsEqual(left: InternalDiffSnapshot, right: InternalDiffSnapshot): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  // A too-large marker carries no content identity, so it cannot prove equality.
  if (left.kind === 'too_large') {
    return false;
  }
  return left.kind !== 'text' || left.text === (right as { readonly text: string }).text;
}

// Helpers for the batched All Changes diff (`openAllChangesDiff`).
function allChangesValueWeight(value: CodeCollabV2AllChangesValue | undefined): number {
  if (value === undefined || value === true || value.diff === undefined) {
    return 0;
  }
  return value.diff[0] + value.diff[1];
}

function allChangesValueStats(value: CodeCollabV2AllChangesValue | undefined): {
  add?: number;
  del?: number;
} {
  if (value === undefined || value === true || value.diff === undefined) {
    return {};
  }
  return { add: value.diff[0], del: value.diff[1] };
}

function internalDiffSnapshotRawBytes(snapshot: InternalDiffSnapshot): number {
  return snapshot.kind === 'text' ? Buffer.byteLength(snapshot.text, 'utf8') : 0;
}

function encodedDiffSnapshotWireBytes(snapshot: CodeCollabV2DiffSnapshot): number {
  if (snapshot.kind !== 'text') {
    return 0;
  }
  const payload = snapshot.text;
  return payload.encoding === 'plain'
    ? Buffer.byteLength(payload.text, 'utf8')
    : payload.data.length;
}

async function runGit(
  cwd: string,
  args: readonly string[]
): Promise<{ ok: true; stdout: string } | { ok: false }> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false };
  }
}

async function runGitBuffer(
  cwd: string,
  args: readonly string[],
  maxBuffer: number
): Promise<{ ok: true; stdout: Buffer } | { ok: false }> {
  try {
    const { stdout } = (await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'buffer',
      maxBuffer,
    })) as { stdout: Buffer };
    return { ok: true, stdout };
  } catch {
    return { ok: false };
  }
}
