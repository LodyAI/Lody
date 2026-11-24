export const DEFAULT_RETENTION_DAYS = 100;
export const DEFAULT_MAX_STORAGE_BYTES = 1024 ** 3;
export const DEFAULT_GC_TARGET_BYTES = 900 * 1024 ** 2;

export type TurnDiffCompression = 'zstd' | 'gzip';

export interface TurnDiffStoreOptions {
  /** Existing current-schema database only; never initialize, migrate or collect. */
  readonly readOnly?: boolean;
  readonly dbPath: string;
  readonly retentionDays?: number;
  readonly maxStorageBytes?: number;
  readonly gcTargetBytes?: number;
  readonly compression?: TurnDiffCompression;
}

export interface TurnDiffStoreEvent {
  readonly path: string;
  readonly oldText: string | null;
  readonly newText: string | null;
  /** True only when newText was verified as the caller's current document state. */
  readonly newIsCurrent: boolean;
  /** Attempt-start sequence consumed by this path only when newIsCurrent is true. */
  readonly headProof: number | null;
  readonly add: number;
  readonly del: number;
}

export interface RecordTurnDiffInput {
  readonly ownerId: string;
  readonly turnId: string;
  readonly events: readonly TurnDiffStoreEvent[];
  /**
   * Stable, globally comparable turn key used for turn-history and GC ordering.
   * Defaults to capturedAtMs + turnId; shared workspaces should pass an explicit key.
   */
  readonly orderKey?: string;
  /** Stable turn time used to derive retention. */
  readonly capturedAtMs?: number;
  /** Current calibrated time for expiry checks. High-level clients use their injected clock. */
  readonly recordedAtMs?: number;
}

export interface TurnDiffFileSummary {
  readonly path: string;
  readonly add: number;
  readonly del: number;
}

export type TurnDiffSnapshot =
  | { readonly status: 'ready'; readonly text: string | null }
  | { readonly status: 'too_large'; readonly rawBytes: number }
  | { readonly status: 'unavailable' };

export type TurnDiffSnapshotPair =
  | { readonly status: 'ready'; readonly oldText: string | null; readonly newText: string | null }
  | { readonly status: 'too_large'; readonly rawBytes: number }
  | { readonly status: 'unavailable' };

export type LatestTurnDiffText =
  | { readonly status: 'tracked'; readonly text: string | null }
  | { readonly status: 'too_large'; readonly rawBytes: number }
  | { readonly status: 'untracked' };

export interface RecordTurnDiffMetrics {
  readonly rawBytes: number;
  readonly newChunks: number;
  readonly reusedChunks: number;
  readonly encodeMs: number;
  readonly chunkingMs: number;
  readonly hashingMs: number;
  readonly compressionMs: number;
  readonly transactionMs: number;
  readonly totalMs: number;
}

export interface RecordTurnDiffResult {
  readonly files: readonly TurnDiffFileSummary[];
  readonly metrics: RecordTurnDiffMetrics;
  readonly gcScheduled: boolean;
}

export interface TurnDiffStorageBytes {
  readonly database: number;
  readonly wal: number;
  readonly shm: number;
  readonly total: number;
}

export interface TurnDiffGcResult {
  readonly deletedTurns: number;
  readonly deletedSnapshots: number;
  readonly deletedChunks: number;
  readonly before: TurnDiffStorageBytes;
  readonly after: TurnDiffStorageBytes;
  readonly blockedByLiveData: boolean;
}

export interface TurnDiffStoreStats {
  readonly turns: number;
  readonly files: number;
  readonly snapshots: number;
  readonly chunks: number;
  readonly snapshotReferences: number;
  readonly chunkReferences: number;
  readonly rawChunkBytes: number;
  readonly storedChunkBytes: number;
  readonly invalidSnapshotRefCounts: number;
  readonly invalidChunkRefCounts: number;
  readonly integrity: string;
  readonly storage: TurnDiffStorageBytes;
}

export interface ListChangedPathsInput {
  readonly ownerId: string;
  /** Calibrated retention clock. High-level clients fill this when omitted. */
  readonly nowMs?: number;
}

export interface SnapshotPathInput extends ListChangedPathsInput {
  readonly path: string;
  /** Refuse reconstruction when the response would exceed this many raw UTF-8 bytes. */
  readonly maxRawBytes?: number;
}

export interface TurnSnapshotInput extends SnapshotPathInput {
  readonly turnId: string;
}

/** Without turnId, select the earliest retained old side for this owner's path. */
export interface SnapshotDescriptorInput extends SnapshotPathInput {
  readonly turnId?: string;
  readonly side?: 'old' | 'new';
}

export type SnapshotDescriptor =
  | {
      readonly status: 'ready';
      readonly snapshot: { readonly hash: string; readonly rawBytes: number } | null;
    }
  | { readonly status: 'too_large'; readonly rawBytes: number }
  | { readonly status: 'unavailable' };

export interface SnapshotBytesInput extends SnapshotDescriptorInput {
  readonly hash: string;
}
export type SnapshotBytes =
  | { readonly status: 'ready'; readonly bytes: Uint8Array }
  | { readonly status: 'too_large'; readonly rawBytes: number }
  | { readonly status: 'unavailable' };

export interface ListTurnFilesInput extends ListChangedPathsInput {
  readonly turnId: string;
}

export interface TurnDiffStoreApi {
  getSnapshotDescriptor(input: SnapshotDescriptorInput): Promise<SnapshotDescriptor>;
  getSnapshotBytes(input: SnapshotBytesInput): Promise<SnapshotBytes>;
  allocateHeadProof(): Promise<number>;
  recordTurn(input: RecordTurnDiffInput): Promise<RecordTurnDiffResult>;
  listChangedPaths(input: ListChangedPathsInput): Promise<readonly string[]>;
  getEarliestOldSnapshot(input: SnapshotPathInput): Promise<TurnDiffSnapshot>;
  getTurnSnapshot(input: TurnSnapshotInput): Promise<TurnDiffSnapshotPair>;
  getLatestText(input: Omit<SnapshotPathInput, 'nowMs'>): Promise<LatestTurnDiffText>;
  listTurnFiles(input: ListTurnFilesInput): Promise<readonly TurnDiffFileSummary[]>;
  gc(nowMs?: number): Promise<TurnDiffGcResult>;
  stats(): Promise<TurnDiffStoreStats>;
  close(): Promise<void>;
}
