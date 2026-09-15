import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  TurnDiffStore,
  type LatestTurnDiffText,
  type TurnDiffStoreOptions,
  type TurnDiffStoreStats,
} from '@lody/turn-diff-store';
import { getServerNow, type FileDiff, type SessionId, type WorkspaceId } from '@lody/shared';

import { getLogger } from '@/utils/logger';

import { mapWithConcurrency } from '../bounded-concurrency';
import { computeTurnEvidenceAsync } from './diff-line-count-pool';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

const DEFAULT_RETENTION_DAYS = 100;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 365;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKER_FILENAME = path.join(MODULE_DIR, 'turn-diff-store-worker.js');
const SOURCE_WORKER_FILENAME = path.join(MODULE_DIR, 'turn-diff-store-worker-entry.mjs');

export type CodeCollabV2DiffStoreEvent = {
  readonly path: string;
  readonly oldText: string | null;
  readonly newText: string | null;
};

export type CodeCollabV2DiffStoreRecordInput = {
  readonly workspaceRoot: string;
  readonly ownerSessionId: SessionId;
  readonly turnId: string;
  readonly events: readonly CodeCollabV2DiffStoreEvent[];
  readonly capturedAtMs?: number;
  readonly recordedAtMs?: number;
  readonly orderKey?: string;
};

export type CodeCollabV2DiffStoreSnapshot =
  | { readonly status: 'ready'; readonly text: string | null }
  | { readonly status: 'too_large'; readonly rawBytes: number }
  | { readonly status: 'unavailable' };

export type CodeCollabV2DiffStoreTurnSnapshot =
  | { readonly status: 'ready'; readonly oldText: string | null; readonly newText: string | null }
  | { readonly status: 'too_large'; readonly rawBytes: number }
  | { readonly status: 'unavailable' };

export class CodeCollabV2DiffStore {
  private readonly store: TurnDiffStore;
  private readonly now: () => number;
  private readonly logger = getLogger('code-collab');

  constructor(
    readonly workspaceId: WorkspaceId | string,
    options: {
      readonly dbPath?: string;
      readonly retentionDays?: number;
      readonly maxStorageBytes?: number;
      readonly gcTargetBytes?: number;
      readonly workerUrl?: URL | string;
      readonly workerExecArgv?: readonly string[];
      readonly now?: () => number;
    } = {}
  ) {
    const dbPath = options.dbPath ?? getCodeCollabV2DiffStoreDbPath(workspaceId.toString());
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const storeOptions: TurnDiffStoreOptions = {
      dbPath,
      retentionDays: normalizeRetentionDays(options.retentionDays),
      ...(options.maxStorageBytes === undefined
        ? {}
        : { maxStorageBytes: options.maxStorageBytes }),
      ...(options.gcTargetBytes === undefined ? {} : { gcTargetBytes: options.gcTargetBytes }),
    };
    const worker = resolveWorkerOptions(options);
    this.now = options.now ?? getServerNow;
    this.store = new TurnDiffStore({
      ...storeOptions,
      ...worker,
      now: this.now,
      onBackgroundGc: (result) => {
        const message = `[code-collab] turn-diff background GC completed deletedTurns=${
          result.deletedTurns
        } deletedSnapshots=${result.deletedSnapshots} deletedChunks=${
          result.deletedChunks
        } beforeBytes=${result.before.total} afterBytes=${result.after.total} blockedByLiveData=${
          result.blockedByLiveData
        }`;
        if (result.blockedByLiveData) this.logger.warn(message);
        else this.logger.info(message);
      },
      onBackgroundError: (error) => {
        this.logger.error(`[code-collab] turn-diff background GC failed: ${error.message}`);
      },
    });
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  async recordTurnDiffs(input: CodeCollabV2DiffStoreRecordInput): Promise<FileDiff[]> {
    const startedAtMs = Date.now();
    const recordedAtMs = input.recordedAtMs ?? this.now();
    const capturedAtMs = input.capturedAtMs ?? recordedAtMs;
    const aggregated = aggregateDiffStoreEvents(input.workspaceRoot, input.events);
    if (aggregated.length === 0) return [];
    // One durable token per persistence attempt orders current-state proofs even
    // when an older multi-file turn finishes compression after a newer turn.
    const headProof = await this.store.allocateHeadProof();

    const analysisStartedAtMs = Date.now();
    const analyses = await mapWithConcurrency(aggregated, 2, async (event) => {
      const analysis = await computeTurnEvidenceAsync(
        event.oldText,
        event.newText,
        path.resolve(input.workspaceRoot, event.path)
      );
      return {
        ...analysis,
        headProof: analysis.newIsCurrent ? headProof : null,
      };
    });
    const analysisMs = Date.now() - analysisStartedAtMs;
    const result = await this.store.recordTurn({
      ownerId: input.ownerSessionId,
      turnId: input.turnId,
      capturedAtMs,
      recordedAtMs,
      ...(input.orderKey === undefined ? {} : { orderKey: input.orderKey }),
      events: aggregated.map((event, index) => {
        const analysis = analyses[index];
        if (!analysis) throw new Error(`Missing turn analysis for turn-diff path ${event.path}.`);
        return {
          path: event.path,
          oldText: event.oldText,
          newText: event.newText,
          newIsCurrent: analysis.newIsCurrent,
          headProof: analysis.headProof,
          add: analysis.lineCounts[0],
          del: analysis.lineCounts[1],
        };
      }),
    });
    const fileDiff = result.files.map((file) => ({
      filePath: file.path,
      add: file.add,
      del: file.del,
    }));
    this.logger.info(
      `[code-collab] diff store recordTurnDiffs completed ownerSessionId=${
        input.ownerSessionId
      } turnId=${input.turnId} inputEvents=${input.events.length} aggregatedEvents=${
        aggregated.length
      } fileDiffs=${fileDiff.length} totalTextBytes=${sumEventTextBytes(
        aggregated
      )} durationMs=${Date.now() - startedAtMs} analysisMs=${analysisMs} storeMs=${result.metrics.totalMs.toFixed(
        1
      )} encodeMs=${result.metrics.encodeMs.toFixed(
        1
      )} chunkingMs=${result.metrics.chunkingMs.toFixed(1)} hashingMs=${result.metrics.hashingMs.toFixed(
        1
      )} compressionMs=${result.metrics.compressionMs.toFixed(
        1
      )} transactionMs=${result.metrics.transactionMs.toFixed(1)} newChunks=${
        result.metrics.newChunks
      } reusedChunks=${result.metrics.reusedChunks} gcScheduled=${result.gcScheduled}`
    );
    return fileDiff;
  }

  async listChangedPaths(input: {
    readonly ownerSessionId: SessionId;
    readonly nowMs?: number;
  }): Promise<readonly string[]> {
    return await this.store.listChangedPaths({
      ownerId: input.ownerSessionId,
      ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
    });
  }

  async getEarliestOldSnapshot(input: {
    readonly ownerSessionId: SessionId;
    readonly path: string;
    readonly nowMs?: number;
    readonly maxRawBytes?: number;
  }): Promise<CodeCollabV2DiffStoreSnapshot> {
    return await this.store.getEarliestOldSnapshot({
      ownerId: input.ownerSessionId,
      path: input.path,
      ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
      ...(input.maxRawBytes === undefined ? {} : { maxRawBytes: input.maxRawBytes }),
    });
  }

  async getTurnDiffSnapshot(input: {
    readonly ownerSessionId: SessionId;
    readonly turnId: string;
    readonly path: string;
    readonly nowMs?: number;
    readonly maxRawBytes?: number;
  }): Promise<CodeCollabV2DiffStoreTurnSnapshot> {
    return await this.store.getTurnSnapshot({
      ownerId: input.ownerSessionId,
      turnId: input.turnId,
      path: input.path,
      ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
      ...(input.maxRawBytes === undefined ? {} : { maxRawBytes: input.maxRawBytes }),
    });
  }

  async getLatestText(input: {
    readonly ownerSessionId: SessionId;
    readonly path: string;
    readonly maxRawBytes?: number;
  }): Promise<LatestTurnDiffText> {
    return await this.store.getLatestText({
      ownerId: input.ownerSessionId,
      path: input.path,
      ...(input.maxRawBytes === undefined ? {} : { maxRawBytes: input.maxRawBytes }),
    });
  }

  async listTurnFileDiffs(input: {
    readonly ownerSessionId: SessionId;
    readonly turnId: string;
    readonly nowMs?: number;
  }): Promise<FileDiff[]> {
    const files = await this.store.listTurnFiles({
      ownerId: input.ownerSessionId,
      turnId: input.turnId,
      ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
    });
    return files.map((file) => ({ filePath: file.path, add: file.add, del: file.del }));
  }

  async gc(nowMs?: number): Promise<void> {
    await this.store.gc(nowMs);
  }

  async stats(): Promise<TurnDiffStoreStats> {
    return await this.store.stats();
  }
}

function resolveWorkerOptions(options: {
  readonly workerUrl?: URL | string;
  readonly workerExecArgv?: readonly string[];
}): { readonly workerUrl: URL | string; readonly workerExecArgv?: readonly string[] } {
  if (options.workerUrl !== undefined) {
    return {
      workerUrl: options.workerUrl,
      ...(options.workerExecArgv === undefined ? {} : { workerExecArgv: options.workerExecArgv }),
    };
  }
  if (existsSync(WORKER_FILENAME)) {
    return { workerUrl: pathToFileURL(WORKER_FILENAME) };
  }
  if (process.env.VITEST && existsSync(SOURCE_WORKER_FILENAME)) {
    return { workerUrl: pathToFileURL(SOURCE_WORKER_FILENAME) };
  }
  throw new Error(
    `Code Collab turn-diff worker is missing from the CLI bundle: ${WORKER_FILENAME}`
  );
}

export function getCodeCollabV2DiffStoreDbPath(workspaceId: string): string {
  return path.join(
    getLodyDataDir(),
    'code-collab-v2',
    safeWorkspaceSegment(workspaceId),
    'diff-store.sqlite3'
  );
}

function aggregateDiffStoreEvents(
  workspaceRoot: string,
  events: readonly CodeCollabV2DiffStoreEvent[]
): readonly CodeCollabV2DiffStoreEvent[] {
  const root = path.resolve(workspaceRoot);
  const byPath = new Map<string, CodeCollabV2DiffStoreEvent>();
  for (const event of events) {
    const normalizedPath = normalizeEvidencePath(root, event.path);
    if (!normalizedPath) continue;
    const existing = byPath.get(normalizedPath);
    byPath.set(normalizedPath, {
      path: normalizedPath,
      oldText: existing === undefined ? event.oldText : existing.oldText,
      newText: event.newText,
    });
  }
  return [...byPath.values()];
}

function sumEventTextBytes(events: readonly CodeCollabV2DiffStoreEvent[]): number {
  let total = 0;
  for (const event of events) {
    total += event.oldText === null ? 0 : Buffer.byteLength(event.oldText, 'utf8');
    total += event.newText === null ? 0 : Buffer.byteLength(event.newText, 'utf8');
  }
  return total;
}

function normalizeEvidencePath(workspaceRoot: string, evidencePath: string): string | null {
  if (evidencePath.includes('\0')) return null;
  const realWorkspaceRoot = realpathOrSelf(workspaceRoot);
  const absolutePath = path.isAbsolute(evidencePath)
    ? path.resolve(evidencePath)
    : path.resolve(workspaceRoot, evidencePath);
  const realAbsolutePath = realpathOrSelf(absolutePath);
  for (const candidatePath of uniqueStrings([absolutePath, realAbsolutePath])) {
    for (const candidateRoot of uniqueStrings([workspaceRoot, realWorkspaceRoot])) {
      const relative = path.relative(candidateRoot, candidatePath).replace(/\\/g, '/');
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
      return path.posix.normalize(relative.normalize('NFC'));
    }
  }
  return null;
}

function realpathOrSelf(inputPath: string): string {
  try {
    return realpathSync.native(inputPath);
  } catch {
    const parent = path.dirname(inputPath);
    if (parent !== inputPath) {
      const realParent = realpathOrSelf(parent);
      if (realParent !== parent) return path.join(realParent, path.basename(inputPath));
    }
    return inputPath;
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function normalizeRetentionDays(value: number | undefined): number {
  const env = Number.parseInt(process.env.LODY_CODE_COLLAB_DIFF_RETENTION_DAYS ?? '', 10);
  const candidate = value ?? (Number.isFinite(env) ? env : DEFAULT_RETENTION_DAYS);
  if (!Number.isFinite(candidate)) return DEFAULT_RETENTION_DAYS;
  return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.trunc(candidate)));
}

function safeWorkspaceSegment(workspaceId: string): string {
  const safe = workspaceId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'workspace';
  const hash = createHash('sha256').update(workspaceId).digest('hex').slice(0, 12);
  return `${safe}-${hash}`;
}
