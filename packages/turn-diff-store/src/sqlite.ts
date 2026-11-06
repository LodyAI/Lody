import { SqliteTurnDiffStore } from './sqlite-store';
import type {
  LatestTurnDiffText,
  ListChangedPathsInput,
  ListTurnFilesInput,
  RecordTurnDiffInput,
  RecordTurnDiffResult,
  SnapshotPathInput,
  SnapshotDescriptorInput,
  SnapshotDescriptor,
  SnapshotBytesInput,
  SnapshotBytes,
  TurnDiffFileSummary,
  TurnDiffGcResult,
  TurnDiffSnapshot,
  TurnDiffSnapshotPair,
  TurnDiffStoreApi,
  TurnDiffStoreOptions,
  TurnDiffStoreStats,
  TurnSnapshotInput,
} from './types';

export interface InlineTurnDiffStoreOptions extends TurnDiffStoreOptions {
  /** Calibrated clock used for every retention read and GC decision. */
  readonly now: () => number;
}

/** Explicit inline backend for tests and embeddings that already own a worker thread. */
export class InlineTurnDiffStore implements TurnDiffStoreApi {
  private readonly store: SqliteTurnDiffStore;
  private readonly now: () => number;

  constructor(options: InlineTurnDiffStoreOptions) {
    const { now, ...storeOptions } = options;
    this.now = now;
    this.store = new SqliteTurnDiffStore(storeOptions);
  }

  async recordTurn(input: RecordTurnDiffInput): Promise<RecordTurnDiffResult> {
    const recordedAtMs = input.recordedAtMs ?? this.now();
    return this.store.recordTurn({
      ...input,
      capturedAtMs: input.capturedAtMs ?? recordedAtMs,
      recordedAtMs,
    });
  }

  async getSnapshotDescriptor(input: SnapshotDescriptorInput): Promise<SnapshotDescriptor> {
    return this.store.getSnapshotDescriptor({ ...input, nowMs: input.nowMs ?? this.now() });
  }

  async getSnapshotBytes(input: SnapshotBytesInput): Promise<SnapshotBytes> {
    return this.store.getSnapshotBytes({ ...input, nowMs: input.nowMs ?? this.now() });
  }

  async allocateHeadProof(): Promise<number> {
    return this.store.allocateHeadProof();
  }

  async listChangedPaths(input: ListChangedPathsInput): Promise<readonly string[]> {
    return this.store.listChangedPaths({ ...input, nowMs: input.nowMs ?? this.now() });
  }

  async getEarliestOldSnapshot(input: SnapshotPathInput): Promise<TurnDiffSnapshot> {
    return this.store.getEarliestOldSnapshot({ ...input, nowMs: input.nowMs ?? this.now() });
  }

  async getTurnSnapshot(input: TurnSnapshotInput): Promise<TurnDiffSnapshotPair> {
    return this.store.getTurnSnapshot({ ...input, nowMs: input.nowMs ?? this.now() });
  }

  async getLatestText(input: Omit<SnapshotPathInput, 'nowMs'>): Promise<LatestTurnDiffText> {
    return this.store.getLatestText(input);
  }

  async listTurnFiles(input: ListTurnFilesInput): Promise<readonly TurnDiffFileSummary[]> {
    return this.store.listTurnFiles({ ...input, nowMs: input.nowMs ?? this.now() });
  }

  async gc(nowMs?: number): Promise<TurnDiffGcResult> {
    return this.store.gc(nowMs ?? this.now());
  }

  async stats(): Promise<TurnDiffStoreStats> {
    return this.store.stats();
  }

  async close(): Promise<void> {
    this.store.close();
  }
}

export { SqliteTurnDiffStore } from './sqlite-store';
