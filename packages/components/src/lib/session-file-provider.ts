import type {
  CodeCollabAllChangesScope,
  CodeCollabContentUnavailableReason,
  CodeCollabFileKind,
  CodeCollabFileSourceState,
  FileDiff,
} from '@lody/shared';
import type { FileDiffMetadata } from '@pierre/diffs';
import {
  createFakeFileWorkspaceProvider,
  hasFileWorkspaceLspProvider,
  type FakeFileWorkspaceProviderOptions,
  type FileWorkspaceHostLivenessSnapshot,
  type FileWorkspaceLspProvider,
  type FileWorkspaceOpenResult,
  type FileWorkspaceProvider,
  type FileWorkspaceProviderEntry,
  type FileWorkspaceProviderState,
  type FileWorkspaceSnapshot,
} from './file-workspace-provider';
import type { DiffTextChunkSource } from './diff-text-chunk-source';

export type SessionFileProviderMode = 'live' | 'historical-turn';

export type {
  FileWorkspaceBinarySnapshot as SessionFileBinarySnapshot,
  FileWorkspaceHostLivenessSnapshot as SessionFileHostLivenessSnapshot,
  FileWorkspaceOpenResult as SessionFileOpenResult,
  FileWorkspaceProviderEntry as SessionFileProviderEntry,
  FileWorkspaceProviderState as SessionFileProviderState,
  FileWorkspaceSnapshot as SessionFileSnapshot,
  FileWorkspaceTextSnapshot as SessionFileTextSnapshot,
  FileWorkspaceUnavailableSnapshot as SessionFileUnavailableSnapshot,
} from './file-workspace-provider';

export type SessionFileDiffResult =
  | {
      readonly status: 'ready';
      readonly path: string;
      readonly oldSnapshot: FileWorkspaceSnapshot;
      readonly newSnapshot: FileWorkspaceSnapshot;
    }
  | {
      readonly status: 'ready-parsed';
      readonly path: string;
      readonly fileDiff: FileDiffMetadata;
      readonly oldTextLength: number;
      readonly newTextLength: number;
    }
  | {
      readonly status: 'ready-text-source';
      readonly path: string;
      readonly source: DiffTextChunkSource;
    }
  | {
      readonly status: 'unavailable';
      readonly path: string;
      readonly reason: CodeCollabContentUnavailableReason;
      readonly message?: string;
    };

export type SessionFileChangeEntry = {
  readonly fileId?: string;
  readonly path: string;
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly kind: CodeCollabFileKind;
  readonly sourceState: CodeCollabFileSourceState;
  readonly add?: number;
  readonly del?: number;
};

export type SessionFileChangedFilesResult =
  | {
      readonly status: 'ready';
      readonly files: readonly SessionFileChangeEntry[];
    }
  | {
      readonly status: 'unavailable';
      readonly reason: CodeCollabContentUnavailableReason;
      readonly message?: string;
    };

// One entry of a batched All Changes diff. `diff` carries the renderable result, or a
// `deferred` marker meaning the content exists on the machine but was not inlined in the
// batch (the caller fetches it on demand via `getDiff`).
export type SessionFileAllChangesDiffEntry = {
  readonly path: string;
  readonly add?: number;
  readonly del?: number;
  readonly diff: SessionFileDiffResult | { readonly status: 'deferred' };
};

export type SessionFileAllChangesDiffResult =
  | {
      readonly status: 'ready';
      readonly base: string;
      readonly entries: readonly SessionFileAllChangesDiffEntry[];
      readonly truncated: boolean;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: CodeCollabContentUnavailableReason;
      /** Explicit All Changes scope limitation (uncommitted mode). */
      readonly scopeReason?: 'not_a_git_worktree' | 'no_commits';
      readonly message?: string;
    };

export interface SessionFileHistoryProvider {
  readonly supportsHistoricalDiffs?: boolean;
  getDiff(
    pathOrFileId: string,
    turnId?: string,
    fileDiff?: FileDiff,
    options?: { readonly allChangesScope?: CodeCollabAllChangesScope }
  ): Promise<SessionFileDiffResult>;
  listChangedFiles(turnId?: string): Promise<SessionFileChangedFilesResult>;
  // Batched "All Changes" (current disk vs base) diff. Optional: providers that cannot
  // batch simply omit it and callers fall back to per-file getDiff.
  getAllChangesDiff?(
    focusPath?: string,
    scope?: CodeCollabAllChangesScope
  ): Promise<SessionFileAllChangesDiffResult>;
}

export interface SessionFileProvider
  extends Omit<FileWorkspaceProvider, 'openFile'>, SessionFileHistoryProvider {
  downloadFile?(path: string, signal?: AbortSignal): Promise<Uint8Array | null>;
  openFile(pathOrFileId: string, mode?: SessionFileProviderMode): Promise<FileWorkspaceOpenResult>;
}

export interface SessionFileLspProvider extends FileWorkspaceLspProvider {}

export function hasSessionFileLspProvider(
  provider: SessionFileProvider | null | undefined
): provider is SessionFileProvider & SessionFileLspProvider {
  return hasFileWorkspaceLspProvider(provider);
}

export type FakeSessionFileProviderOptions = FakeFileWorkspaceProviderOptions & {
  readonly supportsHistoricalDiffs?: boolean;
  readonly diffs?:
    | ReadonlyMap<string, SessionFileDiffResult>
    | Record<string, SessionFileDiffResult>;
  readonly changedFiles?: readonly SessionFileChangeEntry[];
  readonly changedFilesByTurn?:
    | ReadonlyMap<string, readonly SessionFileChangeEntry[]>
    | Record<string, readonly SessionFileChangeEntry[]>;
};

export function createFakeSessionFileProvider(
  options: FakeSessionFileProviderOptions = {}
): SessionFileProvider {
  return new FakeSessionFileProvider(options);
}

class FakeSessionFileProvider implements SessionFileProvider {
  private readonly workspaceProvider: FileWorkspaceProvider;
  readonly supportsHistoricalDiffs: boolean;
  private readonly diffs: Map<string, SessionFileDiffResult>;
  private readonly changedFiles: readonly SessionFileChangeEntry[];
  private readonly changedFilesByTurn: Map<string, readonly SessionFileChangeEntry[]>;

  constructor(options: FakeSessionFileProviderOptions) {
    this.workspaceProvider = createFakeFileWorkspaceProvider(options);
    this.supportsHistoricalDiffs = options.supportsHistoricalDiffs === true;
    this.diffs = toDiffMap(options.diffs);
    this.changedFiles = options.changedFiles ?? [];
    this.changedFilesByTurn = toChangedFilesByTurnMap(options.changedFilesByTurn);
  }

  get kind() {
    return this.workspaceProvider.kind;
  }

  getState(): FileWorkspaceProviderState {
    return this.workspaceProvider.getState();
  }

  listFiles(): Promise<readonly FileWorkspaceProviderEntry[]> {
    return this.workspaceProvider.listFiles();
  }

  searchFiles(query: string): Promise<readonly FileWorkspaceProviderEntry[]> {
    return this.workspaceProvider.searchFiles(query);
  }

  getFile(pathOrFileId: string): Promise<FileWorkspaceProviderEntry | null> {
    return this.workspaceProvider.getFile(pathOrFileId);
  }

  openFile(pathOrFileId: string): Promise<FileWorkspaceOpenResult> {
    return this.workspaceProvider.openFile(pathOrFileId);
  }

  saveText(pathOrFileId: string, text: string): Promise<FileWorkspaceOpenResult> {
    return this.workspaceProvider.saveText(pathOrFileId, text);
  }

  async getHostLivenessStatus(): Promise<FileWorkspaceHostLivenessSnapshot> {
    const status = await this.workspaceProvider.getHostLivenessStatus?.();
    if (!status) throw new Error('Host liveness is unavailable.');
    return status;
  }

  subscribeHostLiveness(
    callback: (snapshot: FileWorkspaceHostLivenessSnapshot) => void
  ): () => void {
    return this.workspaceProvider.subscribeHostLiveness?.(callback) ?? (() => undefined);
  }

  async getDiff(pathOrFileId: string): Promise<SessionFileDiffResult> {
    const entry = await this.getFile(pathOrFileId);
    const key = entry?.path ?? pathOrFileId;
    return (
      this.diffs.get(key) ?? {
        status: 'unavailable',
        path: key,
        reason: 'metadata-only',
      }
    );
  }

  async listChangedFiles(turnId?: string): Promise<SessionFileChangedFilesResult> {
    if (turnId !== undefined) {
      return { status: 'ready', files: this.changedFilesByTurn.get(turnId) ?? [] };
    }
    return { status: 'ready', files: this.changedFiles };
  }
}

export function canOpenHistoricalSessionDiffs(
  provider: SessionFileProvider | null | undefined
): boolean {
  return provider?.supportsHistoricalDiffs === true;
}

function toDiffMap(
  input: FakeSessionFileProviderOptions['diffs']
): Map<string, SessionFileDiffResult> {
  if (!input) return new Map();
  return input instanceof Map
    ? new Map<string, SessionFileDiffResult>(input)
    : new Map<string, SessionFileDiffResult>(Object.entries(input));
}

function toChangedFilesByTurnMap(
  input: FakeSessionFileProviderOptions['changedFilesByTurn']
): Map<string, readonly SessionFileChangeEntry[]> {
  if (!input) return new Map();
  return input instanceof Map
    ? new Map<string, readonly SessionFileChangeEntry[]>(input)
    : new Map<string, readonly SessionFileChangeEntry[]>(Object.entries(input));
}
