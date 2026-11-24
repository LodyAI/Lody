import { Worker } from 'node:worker_threads';

import type {
  TurnDiffWorkerKind,
  TurnDiffWorkerRequest,
  TurnDiffWorkerRequestBody,
  TurnDiffWorkerResponse,
  TurnDiffWorkerResult,
} from './protocol';
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
  TurnDiffGcResult,
  TurnDiffFileSummary,
  TurnDiffSnapshot,
  TurnDiffSnapshotPair,
  TurnDiffStoreApi,
  TurnDiffStoreOptions,
  TurnDiffStoreStats,
  TurnSnapshotInput,
} from './types';

export interface TurnDiffStoreClientOptions extends TurnDiffStoreOptions {
  readonly workerUrl: URL | string;
  /** Calibrated clock used for every retention read and GC decision. */
  readonly now: () => number;
  readonly workerExecArgv?: readonly string[];
  readonly onBackgroundGc?: (result: TurnDiffGcResult) => void;
  readonly onBackgroundError?: (error: Error) => void;
}

interface PendingRequest {
  readonly worker: Worker;
  readonly kind: TurnDiffWorkerKind;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
}

export class TurnDiffStore implements TurnDiffStoreApi {
  private readonly storeOptions: TurnDiffStoreOptions;
  private readonly workerUrl: URL | string;
  private readonly now: () => number;
  private readonly workerExecArgv: readonly string[] | undefined;
  private readonly onBackgroundGc: ((result: TurnDiffGcResult) => void) | undefined;
  private readonly onBackgroundError: ((error: Error) => void) | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private worker: Worker | undefined;
  private workerReady: Promise<void> | undefined;
  private nextId = 1;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private activeRequests = 0;
  private readonly idleWaiters: (() => void)[] = [];

  constructor(options: TurnDiffStoreClientOptions) {
    this.storeOptions = {
      dbPath: options.dbPath,
      ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
      ...(options.retentionDays === undefined ? {} : { retentionDays: options.retentionDays }),
      ...(options.maxStorageBytes === undefined
        ? {}
        : { maxStorageBytes: options.maxStorageBytes }),
      ...(options.gcTargetBytes === undefined ? {} : { gcTargetBytes: options.gcTargetBytes }),
      ...(options.compression === undefined ? {} : { compression: options.compression }),
    };
    this.workerUrl = options.workerUrl;
    this.now = options.now;
    this.workerExecArgv = options.workerExecArgv;
    this.onBackgroundGc = options.onBackgroundGc;
    this.onBackgroundError = options.onBackgroundError;
  }

  async recordTurn(input: RecordTurnDiffInput): Promise<RecordTurnDiffResult> {
    const recordedAtMs = input.recordedAtMs ?? this.now();
    return await this.request({
      kind: 'record',
      input: {
        ...input,
        capturedAtMs: input.capturedAtMs ?? recordedAtMs,
        recordedAtMs,
      },
    });
  }

  async getSnapshotDescriptor(input: SnapshotDescriptorInput): Promise<SnapshotDescriptor> {
    return await this.request({
      kind: 'snapshot-descriptor',
      input: { ...input, nowMs: input.nowMs ?? this.now() },
    });
  }

  async getSnapshotBytes(input: SnapshotBytesInput): Promise<SnapshotBytes> {
    return await this.request({
      kind: 'snapshot-bytes',
      input: { ...input, nowMs: input.nowMs ?? this.now() },
    });
  }

  async allocateHeadProof(): Promise<number> {
    return await this.request({ kind: 'allocate-head-proof' });
  }

  async listChangedPaths(input: ListChangedPathsInput): Promise<readonly string[]> {
    return await this.request({
      kind: 'list-changed-paths',
      input: { ...input, nowMs: input.nowMs ?? this.now() },
    });
  }

  async getEarliestOldSnapshot(input: SnapshotPathInput): Promise<TurnDiffSnapshot> {
    return await this.request({
      kind: 'earliest-old',
      input: { ...input, nowMs: input.nowMs ?? this.now() },
    });
  }

  async getTurnSnapshot(input: TurnSnapshotInput): Promise<TurnDiffSnapshotPair> {
    return await this.request({
      kind: 'turn-snapshot',
      input: { ...input, nowMs: input.nowMs ?? this.now() },
    });
  }

  async getLatestText(input: Omit<SnapshotPathInput, 'nowMs'>): Promise<LatestTurnDiffText> {
    return await this.request({ kind: 'latest-text', input });
  }

  async listTurnFiles(input: ListTurnFilesInput): Promise<readonly TurnDiffFileSummary[]> {
    return await this.request({
      kind: 'list-turn-files',
      input: { ...input, nowMs: input.nowMs ?? this.now() },
    });
  }

  async gc(nowMs?: number): Promise<TurnDiffGcResult> {
    return await this.request({ kind: 'gc', nowMs: nowMs ?? this.now() });
  }

  async stats(): Promise<TurnDiffStoreStats> {
    return await this.request({ kind: 'stats' });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeAfterRequestsFinish();
    return this.closePromise;
  }

  private async closeAfterRequestsFinish(): Promise<void> {
    await this.waitForIdle();
    const worker = this.worker;
    if (!worker) return;
    try {
      await this.send(worker, { kind: 'close' });
    } finally {
      await worker.terminate();
      this.worker = undefined;
      this.workerReady = undefined;
    }
  }

  private async request<Kind extends TurnDiffWorkerKind>(
    request: TurnDiffWorkerRequestBody<Kind>
  ): Promise<TurnDiffWorkerResult<Kind>> {
    this.assertOpen();
    this.activeRequests += 1;
    try {
      const worker = await this.ensureWorker();
      return await this.send(worker, request);
    } finally {
      this.activeRequests -= 1;
      if (this.activeRequests === 0) {
        for (const resolve of this.idleWaiters.splice(0)) resolve();
      }
    }
  }

  private async ensureWorker(): Promise<Worker> {
    if (this.worker && this.workerReady) {
      await this.workerReady;
      return this.worker;
    }
    const worker = new Worker(this.workerUrl, {
      ...(this.workerExecArgv === undefined ? {} : { execArgv: [...this.workerExecArgv] }),
    });
    this.worker = worker;
    this.attachWorker(worker);
    this.workerReady = this.send(worker, {
      kind: 'init',
      options: this.storeOptions,
      nowMs: this.now(),
    }).then(() => undefined);
    try {
      await this.workerReady;
      return worker;
    } catch (error) {
      this.worker = undefined;
      this.workerReady = undefined;
      await worker.terminate();
      throw error;
    }
  }

  private attachWorker(worker: Worker): void {
    worker.on('message', (response: TurnDiffWorkerResponse) => {
      if ('backgroundGc' in response) {
        this.onBackgroundGc?.(response.backgroundGc);
        return;
      }
      if ('backgroundError' in response) {
        this.onBackgroundError?.(new Error(response.backgroundError));
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.kind !== pending.kind) {
        pending.reject(
          new Error(
            `Turn-diff worker response kind mismatch: expected ${pending.kind}, received ${response.kind}.`
          )
        );
      } else if ('error' in response) pending.reject(new Error(response.error));
      else pending.resolve(response.result);
    });
    worker.on('error', (error) => this.handleWorkerFailure(worker, error));
    worker.on('exit', (code) => {
      if (!this.closed || this.hasPendingRequest(worker)) {
        this.handleWorkerFailure(
          worker,
          new Error(`Turn-diff store worker exited unexpectedly with code ${code}.`)
        );
      } else if (this.worker === worker) {
        this.worker = undefined;
        this.workerReady = undefined;
      }
    });
  }

  private handleWorkerFailure(worker: Worker, error: Error): void {
    if (this.worker === worker) {
      this.worker = undefined;
      this.workerReady = undefined;
    }
    for (const [id, pending] of this.pending) {
      if (pending.worker !== worker) continue;
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private async send<Kind extends TurnDiffWorkerKind>(
    worker: Worker,
    request: TurnDiffWorkerRequestBody<Kind>
  ): Promise<TurnDiffWorkerResult<Kind>> {
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { worker, kind: request.kind, resolve, reject });
    });
    try {
      worker.postMessage({ ...request, id } as TurnDiffWorkerRequest<Kind>);
    } catch (error) {
      this.pending.delete(id);
      throw asError(error);
    }
    return (await promise) as TurnDiffWorkerResult<Kind>;
  }

  private async waitForIdle(): Promise<void> {
    if (this.activeRequests === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private hasPendingRequest(worker: Worker): boolean {
    for (const pending of this.pending.values()) {
      if (pending.worker === worker) return true;
    }
    return false;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Turn-diff store is closed.');
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
