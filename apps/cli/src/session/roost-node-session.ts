import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { readRoostHistoryPatches } from './roost-history-patches';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Effect, Semaphore } from 'effect';
import {
  planAgentHistoryMutation,
  type AgentHistoryTextAppend,
  type AgentHistoryMutationPath,
  inheritHistoryStreamText,
  type SessionPlanEntry,
  type SessionHistoryInput,
  type SessionGoalMessage,
  captureStoredHistory,
  prepareStoredHistoryCopy,
  matchesRollbackReceipt,
  prepareReplacement,
  HistoryEntryWriteSchema,
  HistoryWriteError,
  parseHistoryWrite,
  PermissionOutcomeSchema,
  isSessionHistoryStatusAwaitingStart,
} from '@lody/shared';
import {
  planHistoryAction as planDomainHistoryAction,
  historyActionTarget,
  applyMarkTurnSeen,
  applyOpenAssistantTurn,
  createAssistantTurn,
  markTurnSeenBlocked,
  type RoostHistoryChange,
  type RoostHistorySegment,
  type RoostSessionData,
  type SessionDataChangeListener,
  type SessionDirectoryRow,
  type SessionEntry,
  type SessionHistoryReader,
  type SessionHistoryDirectoryPage,
  type SessionEditableTailResult,
  type SessionHistoryCommands,
  type SessionObservation,
  type SessionSnapshotService,
  type SessionTurn,
  type SessionTurnRead,
  createRoostDirectoryRow,
  projectRoostSegments,
  selectTurnOutput,
  ROOST_CLEAR_FIELDS_KEY,
  readLatestTurn,
  type SessionInputAcceptanceResult,
} from '@lody/shared/session-data';
import {
  createImportCursor,
  hashHistoryEntryForVersion,
  planEditableTailReplacement,
  planHistoryImport,
  resolveImportHashVersion,
} from '@lody/shared/session-data';
import { isSessionHistoryPendingForDispatch } from '@lody/shared';
import {
  NodeLodyHistory,
  type ActiveBranchPageCursor,
  type ActiveBranchPageRead,
  toApplicationJson,
  type HistoryProjectedMessage,
  type HistoryBatchCommand,
} from '@loro-dev/roost/lody-history';
import { Identity, decodeJson } from '@loro-dev/roost';
import {
  RoostNativeClient,
  type Write,
  type IndexPut,
  type RoostNodeStream,
} from '@loro-dev/roost-node';
import type { SessionDocument } from '@/lib/loro/doc';
import type { SessionAgentWrites } from '@/lib/loro/session-agent-writes';
import { latestSessionModel } from '@/lib/loro/session-model-summary';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  createRoostSessionBackendFactory,
  type RoostSessionBackendServices,
} from './roost-session-backend';
import { adaptRoostProjectedMessage, encodeRoostContent } from './roost-history-port';
import { registerSessionBackendFactory } from './session-backend';
import { RoostHistoryGeneration } from './roost-history-generation';
import { RoostHistoryHead } from './roost-history-head';
import {
  RoostDispatchIndex,
  RoostDispatchIndexCorrupt,
  type RoostDispatchRow,
  type RoostDispatchUpdate,
} from './roost-dispatch-index';
import {
  dispatchEntry,
  type SessionDispatchEntry,
  type SessionDispatchSelection,
  type SessionDispatchSelector,
} from './session-dispatch-history';
import { createRoostHistoryChanges } from './roost-history-changes';
import {
  roostContentPatches,
  agentReceiptPut,
  stageRoostContent,
  coalesceAgentTextAppends,
  type TextAppendHints,
} from './roost-content-patches';
import {
  createRoostMessageState,
  planRoostMessageState,
  projectRoostMessageState,
  roostMessageStatePatches,
} from './roost-message-state';
import { reportRoostHistoryFailure } from './roost-history-diagnostics';
import { loadRoostOwnerSeedLegacy } from './roost-writer-identity';
import {
  projectLatestGoal,
  projectChangedGoal,
  goalProjectionPut,
  readGoalProjection,
  writeGoalProjection,
  type RoostGoalProjection,
} from './roost-goal-projection';

type RoostNativeOptions = {
  readonly dbPath?: string;
  readonly seed?: Uint8Array;
  readonly maxQueuedRequests?: number;
  readonly maxQueuedBytes?: number;
};

type OwnerLease = {
  readonly client: RoostNativeClient;
  readonly owner: Uint8Array;
  readonly projectionLanes: Semaphore.Semaphore;
  release(): Promise<void>;
};

const bytesHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

const defaultDatabase = (): string =>
  process.env.LODY_ROOST_DB_PATH?.trim() ||
  join(getLodyDataDir(undefined, homedir()), 'roost-history.sqlite3');

let ownerPool:
  | {
      key: string;
      client: RoostNativeClient;
      owner: Uint8Array;
      projectionLanes: Semaphore.Semaphore;
      refs: number;
      closePromise?: Promise<void>;
    }
  | undefined;

const acquireOwnerUnlocked = async (options: RoostNativeOptions): Promise<OwnerLease> => {
  const dbPath = resolve(options.dbPath ?? defaultDatabase());
  const seed = await loadRoostOwnerSeedLegacy(dbPath, options.seed);
  const owner = Identity.fromSeed(seed).owner();
  const key = `${dbPath}:${bytesHex(owner)}`;
  if (ownerPool?.key === key && !ownerPool.closePromise) {
    ownerPool.refs += 1;
    return {
      client: ownerPool.client,
      owner: ownerPool.owner.slice(),
      projectionLanes: ownerPool.projectionLanes,
      release: async () => releaseOwner(key),
    };
  }
  if (ownerPool) await releaseOwnerUnlocked(ownerPool.key, true);
  await mkdir(dirname(dbPath), { recursive: true });
  const client = new RoostNativeClient({
    dbPath,
    seed,
    allowedOwners: [owner],
    maxQueuedRequests: options.maxQueuedRequests ?? 32,
    maxQueuedBytes: options.maxQueuedBytes ?? 8 * 1024 * 1024,
  });
  void client.exited.then(({ code }) => {
    if (client.failure) {
      reportRoostHistoryFailure(client.failure, { stage: 'worker', exitCode: code });
    }
  });
  try {
    await client.ready;
    if (
      !client.capabilities.includes('commit-metadata-v1') ||
      !client.capabilities.includes('derived-indexes-v1') ||
      !client.capabilities.includes('receipt-checks-v1') ||
      !client.capabilities.includes('commit-observation-v1')
    )
      throw new Error(
        'Roost Native atomic publication support is required; update the CLI package'
      );
  } catch (error) {
    reportRoostHistoryFailure(error, { stage: 'initialize' });
    await client.close().catch(() => undefined);
    throw error;
  }
  const projectionLanes = Effect.runSync(
    Semaphore.make(Math.max(1, Math.min(8, Math.floor((options.maxQueuedRequests ?? 32) / 2))))
  );
  ownerPool = { key, client, owner, projectionLanes, refs: 1 };
  return {
    client,
    owner: owner.slice(),
    projectionLanes,
    release: async () => releaseOwner(key),
  };
};

let ownerTransitionSerial: Promise<void> = Promise.resolve();
const serializeOwnerTransition = <T>(operation: () => Promise<T>): Promise<T> => {
  const next = ownerTransitionSerial.then(operation);
  ownerTransitionSerial = next.then(
    () => undefined,
    () => undefined
  );
  return next;
};

const acquireOwner = (options: RoostNativeOptions): Promise<OwnerLease> => {
  return serializeOwnerTransition(() => acquireOwnerUnlocked(options));
};

const releaseOwnerUnlocked = async (key: string, force = false): Promise<void> => {
  if (!ownerPool || ownerPool.key !== key) return;
  if (!force) ownerPool.refs = Math.max(0, ownerPool.refs - 1);
  if (!force && ownerPool.refs > 0) return;
  const current = ownerPool;
  ownerPool = undefined;
  current.closePromise ??= current.client.close();
  try {
    await current.closePromise;
  } catch (error) {
    reportRoostHistoryFailure(error, { stage: 'close' });
    throw error;
  }
};

const releaseOwner = (key: string, force = false): Promise<void> =>
  serializeOwnerTransition(() => releaseOwnerUnlocked(key, force));

const clone = <T>(value: T): T => structuredClone(value);

const equal = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (typeof left === 'bigint' || typeof right === 'bigint') return left === right;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => equal(item, right[index]));
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
  return [...keys].every((key) => equal(leftRecord[key], rightRecord[key]));
};

const operationDigest = (value: unknown): string =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item) =>
        typeof item === 'bigint' ? `${item.toString()}n` : item
      )
    )
    .digest('hex');

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const identityKey = (identity: { businessId: string; segmentId: string }): string =>
  `${identity.businessId}\u0000${identity.segmentId}`;

const createNodeServicesForLease = async (
  sessionDoc: SessionDocument,
  lease: OwnerLease
): Promise<RoostSessionBackendServices> => {
  const historyGeneration = new RoostHistoryGeneration(
    lease.client,
    lease.owner,
    sessionDoc.sessionId
  );
  if (typeof historyGeneration.history.advanceActiveBranchDirectory !== 'function')
    throw new Error('Roost SDK lacks incremental directory support; install a matching SDK build');
  await historyGeneration.resolve();
  let historyHost = historyGeneration.host;
  let historyScope = historyGeneration.observationScope;
  let roostHistory = historyGeneration.history;
  await roostHistory.catchUpIndex();
  await roostHistory.recoverPendingBatches();

  const viewId = sessionDoc.sessionId;
  let disposed = false;
  let closing = false;
  let rows: RoostHistorySegment[] = [];
  let entries: SessionEntry[] = [];
  let directory: SessionDirectoryRow[] = [];
  let activeBranch: ActiveBranchPageRead | undefined;
  let windowHistory: NodeLodyHistory | undefined;
  let reloadPromise: Promise<RoostHistoryChange | undefined> | undefined;
  let loadedStartPosition = 0;
  let totalHistoryCount = 0;
  const branchCursors = new Map<string, ActiveBranchPageCursor>();
  let pageSequence = 0;
  const branchPageSize = 40;
  const projectedByIdentity = new Map<string, HistoryProjectedMessage>();
  const positionById = new Map<string, number>();
  const listeners = new Set<SessionDataChangeListener>();
  const checkpointObservers = new Set<() => void>();
  let pendingChange: RoostHistoryChange | undefined;
  let pendingModelSummary = false;
  let latestAssistantId: string | undefined;
  let latestModelTurnId: string | undefined;
  let syncModelSummary: (() => Promise<void>) | undefined;
  let fullEntriesCache: SessionEntry[] | undefined;
  let readGeneration = 0;
  let writeSerial: Promise<void> = Promise.resolve();
  let operationCursor: bigint | undefined;
  let knownCursor: bigint | undefined;
  let goalProjection: RoostGoalProjection | undefined;
  let goalCoveredStart = 0;
  let needsRefresh = false;
  const publication = new RoostHistoryHead(
    () => historyHost,
    () => historyScope
  );
  let refreshCommitSubscription = () => {};
  const dispatchIndexes = new WeakMap<RoostNodeStream, RoostDispatchIndex>();
  const dispatchIndex = () => {
    let index = dispatchIndexes.get(historyHost);
    if (!index) {
      index = new RoostDispatchIndex(historyHost);
      dispatchIndexes.set(historyHost, index);
    }
    return index;
  };
  const pendingDispatchUpdates = new Map<string, RoostDispatchUpdate>();
  let dispatchMembershipKnown = true;
  const rememberDispatch = (update: RoostDispatchUpdate) => {
    const previous = pendingDispatchUpdates.get(update.after.id);
    pendingDispatchUpdates.set(update.after.id, {
      ...update,
      before: previous ? previous.before : update.before,
      position: update.position ?? previous?.position,
      segments: update.segments ?? previous?.segments,
    });
  };
  const stateCache = new Map<string, Promise<HistoryProjectedMessage | undefined>>();
  const decodedContents = new WeakMap<HistoryProjectedMessage, unknown>();
  const permissionCache = new Map<string, Promise<Record<string, unknown> | undefined>>();

  const historyChanges = createRoostHistoryChanges(
    () => historyHost,
    () => historyScope
  );
  const pendingChangedIds = new Set<string>();
  let pendingStructuralFrom: number | undefined;
  const readRecord = async (identity: Parameters<NodeLodyHistory['lookup']>[0]) => {
    const found = await roostHistory.lookup(identity);
    if (found?.kind !== 'found') return undefined;
    const value = await roostHistory.read(found.turn.turnId);
    if (value.kind !== 'found') throw new Error('Roost state record is incomplete');
    return {
      ...identity,
      turnId: found.turn.turnId,
      nextSeq: found.turn.nextSeq,
      sealed: found.turn.sealed !== null,
      sealedHash: found.turn.sealed,
      parents: [],
      content: decodeJson(new TextEncoder().encode(value.turn.contentJson)),
    };
  };
  const stateIdentity = (primary: HistoryProjectedMessage) => ({
    kind: 'message' as const,
    businessId: primary.businessId,
    segmentId: `state:${bytesHex(primary.turnId)}`,
  });
  const readState = (primary: HistoryProjectedMessage, cache = true) => {
    const identity = stateIdentity(primary);
    if (!cache) return readRecord(identity);
    const key = identityKey(identity);
    let promise = stateCache.get(key);
    if (!promise) {
      promise = readRecord(identity);
      stateCache.set(key, promise);
      while (stateCache.size > 500) stateCache.delete(stateCache.keys().next().value!);
    }
    return promise;
  };
  const projectMessages = async (
    messages: readonly HistoryProjectedMessage[],
    decoded: readonly RoostHistorySegment[] = decodeMessages(messages),
    detach = true,
    cache = true
  ): Promise<SessionEntry[]> => {
    const projected = projectRoostSegments(decoded) as SessionEntry[];
    const primaryContent = new Map(
      decoded
        .filter((row) => row.segmentId === 'primary')
        .map((row) => [row.businessId, row.content])
    );
    const primaries = new Map(
      messages.filter((row) => row.segmentId === 'primary').map((row) => [row.businessId, row])
    );
    const result: SessionEntry[] = [];
    // Each lane has at most one native read in flight, regardless of the
    // page's number of permissions. Preserve row order while avoiding one
    // worker round trip at a time for every historical state lookup.
    const project = async (entry: SessionEntry): Promise<SessionEntry> => {
      const primary = primaries.get(entry.id);
      const state = primary ? await readState(primary, cache) : undefined;
      let turn =
        state && primary
          ? (projectRoostMessageState(
              primaryContent.get(entry.id),
              bytesHex(primary.turnId),
              decodedContent(state)
            ) as SessionEntry)
          : entry;
      if (turn.id !== entry.id) throw new Error('Roost state record identity mismatch');
      const items = [...(turn.items ?? [])];
      for (const [index, item] of items.entries()) {
        if (item.type !== 'tool_call' || !item.permissionRequest) continue;
        const requestId = item.permissionRequest.requestId;
        let promise = cache ? permissionCache.get(requestId) : undefined;
        if (!promise) {
          promise = readRecord({
            kind: 'permission_response',
            businessId: requestId,
            segmentId: 'response',
          }).then((response) =>
            response?.sealed
              ? (toApplicationJson(response.content) as Record<string, unknown>)
              : undefined
          );
          if (cache) {
            permissionCache.set(requestId, promise);
            while (permissionCache.size > 500)
              permissionCache.delete(permissionCache.keys().next().value!);
          }
        }
        const response = await promise;
        if (response?.assistantBusinessId === turn.id) {
          const outcome = parseHistoryWrite(PermissionOutcomeSchema, response.outcome);
          items[index] = { ...item, permissionRequest: { ...item.permissionRequest, outcome } };
        }
      }
      turn = { ...turn, items };
      return detach ? clone(turn) : turn;
    };
    for (let start = 0; start < projected.length; start += 8) {
      result.push(
        ...(await Promise.all(
          projected.slice(start, start + 8).map(async (entry) => {
            // Share permits across all sessions borrowing this Worker, leaving
            // queue capacity for foreground history commands and branch reads.
            await Effect.runPromise(Semaphore.take(lease.projectionLanes, 1));
            try {
              return await project(entry);
            } finally {
              Effect.runSync(Semaphore.release(lease.projectionLanes, 1));
            }
          })
        ))
      );
    }
    return result;
  };
  // Directory pages already carry bodies; retain a bounded cache for hydration.
  const pageEntries = new Map<string, { position: number; turn: SessionEntry }>();
  const pageIdsByPosition = new Map<number, string>();
  const pageBodyLimit = 500;

  const readFullBranch = () => roostHistory.readActiveBranch(viewId);
  const rememberGoalPage = async (
    source: NodeLodyHistory,
    host: typeof historyHost,
    cursor: bigint,
    projected: readonly SessionEntry[],
    start: number
  ): Promise<void> => {
    if (
      source !== roostHistory ||
      cursor !== knownCursor ||
      start > goalCoveredStart ||
      start + projected.length < goalCoveredStart
    )
      return;
    goalCoveredStart = start;
    if (goalProjection === undefined) {
      const latest = projectLatestGoal(projected, start);
      if (latest || start === 0) goalProjection = latest;
    }
    // During an owned write the caller still has to account for all mutations;
    // only persist once that command completes and publishes its final cursor.
    if (goalProjection !== undefined && operationCursor === undefined)
      await writeGoalProjection(host, cursor, goalProjection).catch(() => {});
  };
  const storeBranchCursor = (cursor: ActiveBranchPageCursor | null): string | null => {
    if (!cursor) return null;
    const token = `${cursor.revision}:${cursor.position}:${pageSequence++}:${randomBytes(6).toString('hex')}`;
    branchCursors.set(token, cursor);
    while (branchCursors.size > 128) {
      const oldest = branchCursors.keys().next().value;
      if (oldest === undefined) break;
      branchCursors.delete(oldest);
    }
    return token;
  };
  const currentBranch = (): ActiveBranchPageRead => {
    if (!activeBranch) throw new Error(`Roost active branch for ${viewId} is not initialized`);
    return activeBranch;
  };

  const recordChange = (change: RoostHistoryChange): void => {
    if (change.kind === 'changed') for (const id of change.businessIds) pendingChangedIds.add(id);
    else pendingStructuralFrom = Math.min(pendingStructuralFrom ?? change.from, change.from);
    if (!pendingChange) {
      pendingChange = change;
      return;
    }
    if (pendingChange.kind === 'structure' && change.kind === 'structure') {
      pendingChange = {
        kind: 'structure',
        from: Math.min(pendingChange.from, change.from),
        to: Math.max(pendingChange.to, change.to),
      };
      return;
    }
    if (pendingChange.kind === 'changed' && change.kind === 'changed') {
      pendingChange = {
        kind: 'changed',
        businessIds: [...new Set([...pendingChange.businessIds, ...change.businessIds])],
      };
      return;
    }
    pendingChange = { kind: 'structure', from: 0, to: totalHistoryCount };
  };

  const updateLatestSummaryTargets = (): void => {
    latestAssistantId = undefined;
    latestModelTurnId = undefined;
    for (let position = directory.length - 1; position >= 0; position -= 1) {
      const row = directory[position];
      if (!row?.turnId || row.state !== 'ready') continue;
      if (!latestAssistantId && row.scalars?.role === 'assistant') latestAssistantId = row.turnId;
      if (
        !latestModelTurnId &&
        row.scalars?.role === 'assistant' &&
        ((row.itemCount ?? 0) > 0 || (row.planCount ?? 0) > 0)
      ) {
        latestModelTurnId = row.turnId;
      }
    }
  };

  const rebuildLogicalProjection = (projected: SessionEntry[]): void => {
    entries = projected;
    directory = entries.map((entry, position) =>
      createRoostDirectoryRow(loadedStartPosition + position, entry)
    );
    positionById.clear();
    entries.forEach((entry, position) => positionById.set(entry.id, position));
    updateLatestSummaryTargets();
  };

  const rebuildSegmentIndexes = (messages: readonly HistoryProjectedMessage[]): void => {
    projectedByIdentity.clear();
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]!;
      projectedByIdentity.set(identityKey(message), message);
    }
  };

  const decodedContent = (message: HistoryProjectedMessage): unknown => {
    const cached = decodedContents.get(message);
    if (cached !== undefined) return cached;
    const key = identityKey(message);
    // Only the exact installed physical snapshot shares its validated decoded body.
    // SDK state records and uncached rows still cross the lossless JSON boundary.
    if (projectedByIdentity.get(key) === message) {
      const row = rows.find(
        (candidate) =>
          candidate.businessId === message.businessId && candidate.segmentId === message.segmentId
      );
      if (row) return row.content;
    }
    const content = toApplicationJson(message.content);
    decodedContents.set(message, content);
    return content;
  };

  const decodeMessages = (
    messages: readonly HistoryProjectedMessage[]
  ): readonly RoostHistorySegment[] =>
    messages.map((message) => {
      const known =
        windowHistory === roostHistory ? projectedByIdentity.get(identityKey(message)) : undefined;
      if (
        message.sealed &&
        known?.sealed &&
        message.sealedHash &&
        known.sealedHash &&
        message.nextSeq === known.nextSeq &&
        bytesHex(message.turnId) === bytesHex(known.turnId) &&
        bytesHex(message.sealedHash) === bytesHex(known.sealedHash) &&
        message.parents.length === known.parents.length &&
        message.parents.every(
          (parent, i) =>
            bytesHex(parent.id) === bytesHex(known.parents[i]!.id) &&
            bytesHex(parent.hash) === bytesHex(known.parents[i]!.hash)
        )
      ) {
        const row = rows.find((candidate) => identityKey(candidate) === identityKey(message));
        if (row) return row;
      }
      return adaptRoostProjectedMessage(message);
    });

  const changeBetween = (
    previous: readonly RoostHistorySegment[],
    next: readonly RoostHistorySegment[]
  ): RoostHistoryChange | undefined => {
    const previousIds = [...new Set(previous.map((row) => row.businessId))];
    const nextIds = [...new Set(next.map((row) => row.businessId))];
    if (
      previousIds.length !== nextIds.length ||
      previousIds.some((businessId, index) => businessId !== nextIds[index])
    ) {
      let from = 0;
      while (
        from < previousIds.length &&
        from < nextIds.length &&
        previousIds[from] === nextIds[from]
      )
        from += 1;
      return { kind: 'structure', from, to: Math.max(previousIds.length, nextIds.length) };
    }
    const oldByKey = new Map(previous.map((row) => [identityKey(row), row]));
    const changed = new Set<string>();
    for (const row of next) {
      const old = oldByKey.get(identityKey(row));
      if (
        !old ||
        old.nextSeq !== row.nextSeq ||
        old.sealed !== row.sealed ||
        !equal(old.content, row.content)
      )
        changed.add(row.businessId);
    }
    return changed.size ? { kind: 'changed', businessIds: [...changed] } : undefined;
  };

  const notifyHistoryChange = (change: RoostHistoryChange): void => {
    const logicalChange =
      change.kind === 'changed'
        ? { kind: 'changed' as const, ids: [...change.businessIds] }
        : change;
    for (const listener of listeners) {
      try {
        listener(logicalChange);
      } catch (error) {
        console.error(`Roost session history observer failed for ${viewId}`, error);
      }
    }
  };

  const projectBranchPage = async (
    branch: ActiveBranchPageRead,
    decoded = decodeMessages(branch.messages),
    cache = true
  ): Promise<SessionEntry[]> => {
    if (!branch.complete) {
      throw new Error(`Roost active branch for ${viewId} is incomplete`);
    }
    const projected = await projectMessages(branch.messages, decoded, cache, cache);
    const primaryIds = branch.messages
      .filter((message) => message.segmentId === 'primary')
      .map((message) => message.businessId);
    if (
      projected.length !== primaryIds.length ||
      new Set(primaryIds).size !== primaryIds.length ||
      !Number.isSafeInteger(branch.totalCount) ||
      !Number.isSafeInteger(branch.startPosition) ||
      branch.startPosition < 0 ||
      branch.startPosition + projected.length > branch.totalCount ||
      (projected.length === 0 && branch.totalCount !== 0) ||
      branch.hasMoreOlder !== branch.startPosition > 0 ||
      branch.hasMoreOlder !== (branch.cursor !== null) ||
      (branch.cursor && branch.cursor.position !== branch.startPosition - 1)
    ) {
      throw new Error(`Roost active branch page for ${viewId} has incomplete logical projection`);
    }
    return projected;
  };

  const directoryPageFromBranch = async (
    branch: ActiveBranchPageRead,
    prepared?: readonly SessionEntry[]
  ): Promise<SessionHistoryDirectoryPage> => {
    const projected = prepared ?? (await projectBranchPage(branch));
    return {
      startPosition: branch.startPosition,
      totalCount: branch.totalCount,
      rows: projected.map((entry, index) =>
        createRoostDirectoryRow(branch.startPosition + index, entry)
      ),
      hasMoreOlder: branch.hasMoreOlder,
      cursor: storeBranchCursor(branch.cursor),
    };
  };

  const installBranchWindow = (
    branch: ActiveBranchPageRead,
    projected: SessionEntry[],
    decoded: readonly RoostHistorySegment[],
    notify = false
  ): void => {
    const previous = rows;
    const previousStart = loadedStartPosition;
    activeBranch = branch;
    windowHistory = roostHistory;
    loadedStartPosition = branch.startPosition;
    totalHistoryCount = branch.totalCount;
    rows = decoded.map((row) => ({ ...row }));
    rebuildSegmentIndexes(branch.messages);
    rebuildLogicalProjection(projected);
    readGeneration += 1;
    pageEntries.clear();
    pageIdsByPosition.clear();
    fullEntriesCache = undefined;
    if (notify && previous.length > 0) {
      const change = changeBetween(previous, rows);
      if (change) {
        const adjusted =
          change.kind === 'structure'
            ? {
                kind: 'structure' as const,
                from:
                  previousStart === loadedStartPosition
                    ? loadedStartPosition + change.from
                    : Math.min(previousStart, loadedStartPosition),
                to: loadedStartPosition + change.to,
              }
            : change;
        recordChange(adjusted);
        notifyHistoryChange(adjusted);
      }
    }
  };

  const performBranchReload = async (): Promise<RoostHistoryChange | undefined> => {
    if (operationCursor !== undefined) dispatchMembershipKnown = false;
    const preservedGoal = operationCursor === undefined ? undefined : goalProjection;
    if (await historyGeneration.resolve()) {
      branchCursors.clear();
    }
    roostHistory = historyGeneration.history;
    historyHost = historyGeneration.host;
    historyScope = historyGeneration.observationScope;
    refreshCommitSubscription();
    stateCache.clear();
    permissionCache.clear();
    readGeneration += 1;
    pageEntries.clear();
    pageIdsByPosition.clear();
    fullEntriesCache = undefined;
    const previous = rows;
    const previousEntries = entries;
    const previousStart = loadedStartPosition;
    const cursor = await roostHistory.observedEventCursor();
    const publicationFence = await roostHistory.publicationFence(cursor);
    await publication.read();
    const nextBranch = await roostHistory.readActiveBranchPage(viewId, {
      latest: true,
      limit: branchPageSize,
    });
    if (disposed) throw new Error('Roost session backend is disposed');
    const nextRows = decodeMessages(nextBranch.messages);
    const projected = await projectBranchPage(nextBranch, nextRows);
    let change =
      previous.length === 0 && nextRows.length === 0
        ? undefined
        : changeBetween(previous, nextRows);
    if (change?.kind !== 'structure') {
      const previousById = new Map(previousEntries.map((entry) => [entry.id, entry]));
      const changed = new Set(change?.businessIds ?? []);
      for (const entry of projected) {
        if (!equal(previousById.get(entry.id), entry)) changed.add(entry.id);
      }
      if (changed.size) change = { kind: 'changed', businessIds: [...changed] };
    }
    installBranchWindow(nextBranch, projected, nextRows);
    knownCursor = cursor;
    if (operationCursor === undefined)
      await publication.publish(
        cursor,
        totalHistoryCount,
        { kind: 'structure', from: 0, to: totalHistoryCount },
        publicationFence
      );
    else if (!publication.current()) await publication.read();
    goalCoveredStart = totalHistoryCount;
    goalProjection =
      preservedGoal === undefined
        ? await readGoalProjection(historyHost, cursor, totalHistoryCount).catch(() => undefined)
        : preservedGoal;
    await rememberGoalPage(roostHistory, historyHost, cursor, projected, loadedStartPosition);
    if (change?.kind === 'structure') {
      const movedStart = previousStart !== loadedStartPosition;
      const from = movedStart
        ? Math.min(previousStart, loadedStartPosition)
        : loadedStartPosition + change.from;
      change = {
        kind: 'structure',
        from,
        to: loadedStartPosition + change.to,
      };
    }
    if (change) {
      notifyHistoryChange(change);
      pendingModelSummary = true;
    }
    return change;
  };

  const reloadBranch = async (options: { readonly publish?: boolean } = {}) => {
    const next =
      reloadPromise ??
      (async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await performBranchReload();
          } catch (error) {
            // Only projection/publication is retried. The original history action
            // is never replayed by this repair path.
            if (
              attempt >= 2 ||
              !(error instanceof Error) ||
              !('code' in error) ||
              error.code !== 'stale'
            )
              throw error;
          }
        }
      })();
    reloadPromise = next;
    try {
      const change = await next;
      if (change && options.publish) recordChange(change);
      return change;
    } finally {
      if (reloadPromise === next) reloadPromise = undefined;
    }
  };

  const refreshProjectedMessage = async (
    turnId: Uint8Array,
    mutation?: Awaited<ReturnType<typeof roostHistory.acceptToView>>
  ): Promise<void> => {
    const generation = readGeneration;
    const branch = currentBranch();
    if (mutation) {
      const advance = roostHistory.advanceActiveBranchDirectory(branch, mutation, branchPageSize);
      if (advance) {
        const { message, retainedFrom, through: _through, ...directoryAdvance } = advance;
        const segment = adaptRoostProjectedMessage(message);
        const projected = await projectMessages([message], [segment]);
        if (projected.length === 1 && generation === readGeneration && currentBranch() === branch) {
          const dropped = advance.startPosition - loadedStartPosition;
          installBranchWindow(
            { ...directoryAdvance, messages: [...branch.messages.slice(retainedFrom), message] },
            [...entries.slice(dropped), ...projected],
            [...rows.slice(retainedFrom), segment]
          );
          rememberDispatch({
            after: dispatchEntry(projected[0]!),
            position: advance.totalCount - 1,
            segments: [{ turnId: bytesHex(message.turnId), segmentId: message.segmentId }],
          });
          recordChange({ kind: 'structure', from: advance.totalCount - 1, to: advance.totalCount });
          pendingModelSummary = true;
          return;
        }
      }
    }
    const known = branch.messages.find((row) =>
      Buffer.from(row.turnId).equals(Buffer.from(turnId))
    );
    const position = known ? positionById.get(known.businessId) : undefined;
    // This primary already belongs to the window. Its edit/seal does not add a
    // member. Publication still reloads if the event interval includes other work.
    if (!mutation && known?.segmentId === 'primary' && !known.sealed && position !== undefined) {
      const [fresh] = await roostHistory.readProjectedMessagesById([turnId]);
      if (disposed) throw new Error('Roost session backend is disposed');
      if (!fresh || identityKey(fresh) !== identityKey(known)) {
        throw new Error(`Roost changed message ${known.businessId} is unavailable`);
      }
      if (generation === readGeneration && activeBranch === branch) {
        const segment = adaptRoostProjectedMessage(fresh);
        const [entry] = await projectMessages([fresh]);
        if (!entry) throw new Error(`Roost changed message ${known.businessId} has no projection`);
        activeBranch = {
          ...branch,
          messages: branch.messages.map((row) => (row === known ? fresh : row)),
        };
        rows = rows.map((row) => (identityKey(row) === identityKey(fresh) ? segment : row));
        projectedByIdentity.set(identityKey(fresh), fresh);
        entries[position] = clone(entry);
        directory[position] = createRoostDirectoryRow(loadedStartPosition + position, entry);
        const cached = pageEntries.get(fresh.businessId);
        if (cached) pageIdsByPosition.delete(cached.position);
        pageEntries.delete(fresh.businessId);
        fullEntriesCache = undefined;
        readGeneration += 1;
        updateLatestSummaryTargets();
        pendingModelSummary = true;
        recordChange({ kind: 'changed', businessIds: [fresh.businessId] });
        return;
      }
    }
    const businessId =
      mutation?.newHead.businessId ??
      [...projectedByIdentity.values()].find((row) =>
        Buffer.from(row.turnId).equals(Buffer.from(turnId))
      )?.businessId;
    // Re-read the bounded latest window after membership or uncertain changes. This keeps a
    // sealed successor for an older business id from being appended to the
    // current renderer window as if it were a new logical turn, and keeps the
    // owner window bounded when new turns are appended.
    const change = await reloadBranch({ publish: true });
    if (businessId && !positionById.has(businessId) && change?.kind !== 'structure') {
      const contentChange = { kind: 'changed' as const, businessIds: [businessId] };
      recordChange(contentChange);
      notifyHistoryChange(contentChange);
    }
  };

  await reloadBranch();

  let watchedStream: string | undefined;
  let unsubscribeCommits = () => {};
  let pendingCommitHint:
    | { stream: string; cursor: bigint | null; indexChange: boolean }
    | undefined;
  let commitRefreshQueued = false;
  const queueCommitRefresh = () => {
    if (commitRefreshQueued || !pendingCommitHint || closing || disposed) return;
    commitRefreshQueued = true;
    const next = writeSerial.then(async () => {
      const hint = pendingCommitHint;
      pendingCommitHint = undefined;
      if (!hint || disposed || closing || watchedStream !== hint.stream) return;
      const generationChanged = hint.indexChange && (await historyGeneration.resolve());
      const before = publication.current();
      if (
        !generationChanged &&
        hint.cursor !== null &&
        before &&
        BigInt(before.cursor) >= hint.cursor &&
        !needsRefresh
      )
        return;
      await reloadBranch();
      needsRefresh = false;
      const after = publication.current();
      // A window diff cannot invalidate an older loaded page. One certified
      // publication can supply its complete hint; a coalesced/foreign interval
      // conservatively resets membership and bodies without reading old pages.
      const completeHint =
        before &&
        after?.scope === before.scope &&
        after.historyRevision === before.historyRevision + 1
          ? after.change
          : undefined;
      notifyHistoryChange(completeHint ?? { kind: 'structure', from: 0, to: totalHistoryCount });
      for (const wake of checkpointObservers) wake();
      if (pendingModelSummary) {
        await syncModelSummary?.();
        pendingModelSummary = false;
      }
    });
    const settled = next.catch((error) => {
      needsRefresh = true;
      for (const wake of checkpointObservers) wake();
      console.error(`Roost session history refresh failed for ${viewId}`, error);
    });
    writeSerial = settled;
    void settled.then(() => {
      commitRefreshQueued = false;
      if (!closing && !disposed) queueCommitRefresh();
    });
  };
  refreshCommitSubscription = () => {
    if (closing || disposed) return;
    const stream = historyGeneration.observationStream;
    if (watchedStream === stream) return;
    unsubscribeCommits();
    pendingCommitHint = undefined;
    watchedStream = stream;
    unsubscribeCommits = lease.client.onChanges(
      stream,
      (cursor, indexChange) => {
        if (disposed || closing || watchedStream !== stream) return;
        if (!pendingCommitHint) pendingCommitHint = { stream, cursor, indexChange };
        else {
          pendingCommitHint.indexChange ||= indexChange;
          pendingCommitHint.cursor =
            pendingCommitHint.cursor === null || cursor === null
              ? null
              : pendingCommitHint.cursor > cursor
                ? pendingCommitHint.cursor
                : cursor;
        }
        queueCommitRefresh();
      },
      { indexKeys: historyGeneration.observationIndexKeys }
    );
  };

  const readyTurn = (turn: SessionEntry): SessionTurnRead => ({
    state: 'ready',
    turn: clone(turn) as SessionTurn,
  });
  const staleRead = () =>
    Object.assign(new Error(`Roost active branch for ${viewId} changed during a read`), {
      code: 'stale',
    });
  const publishedNativeCursor = async (): Promise<bigint> => {
    const cursor = await roostHistory.observedEventCursor();
    const published = await publication.read();
    if (
      published?.cursor !== cursor.toString() ||
      knownCursor !== cursor ||
      published.historyCount !== totalHistoryCount
    ) {
      if (operationCursor === undefined) {
        needsRefresh = true;
        recordChange({ kind: 'structure', from: 0, to: totalHistoryCount });
      }
      throw staleRead();
    }
    return cursor;
  };
  const readStable = async <T>(read: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      await historyGeneration.resolve();
      if (needsRefresh || reloadPromise || windowHistory !== historyGeneration.history) {
        await reloadBranch({ publish: true });
        needsRefresh = false;
      }
      const generation = readGeneration;
      try {
        const result = await read();
        if (disposed) throw new Error('Roost session backend is disposed');
        if (generation !== readGeneration) throw staleRead();
        return result;
      } catch (error) {
        const stale =
          generation !== readGeneration ||
          (error instanceof Error && 'code' in error && error.code === 'stale');
        if (stale) dispatchIndex().forget();
        if (disposed || !stale || attempt >= 2) throw error;
      }
    }
  };
  const readCompleteEntries = (): Promise<SessionEntry[]> =>
    readStable(async () => {
      if (fullEntriesCache) return fullEntriesCache.map((entry) => clone(entry));
      const generation = readGeneration;
      const full = await readFullBranch();
      if (!full.complete) throw new Error(`Roost active branch for ${viewId} is incomplete`);
      const projected = await projectMessages(full.messages);
      if (generation === readGeneration) fullEntriesCache = projected.map((entry) => clone(entry));
      return projected.map((entry) => clone(entry));
    });
  const readLatestGoal = (): Promise<SessionGoalMessage | null> =>
    readStable(async () => {
      const source = roostHistory;
      const host = historyHost;
      const generation = readGeneration;
      const cursor = await source.observedEventCursor();
      // Reuse an idle owner's projection at the freshly observed cursor;
      // otherwise inspect the persisted projection at that cursor.
      let latest =
        operationCursor === undefined && cursor === knownCursor ? goalProjection : undefined;
      if (latest === undefined)
        latest = await readGoalProjection(host, cursor, totalHistoryCount).catch(() => undefined);
      if (latest === undefined) {
        let branch = await source.readActiveBranchPage(viewId, {
          latest: true,
          limit: branchPageSize,
        });
        const revision = branch.state.revision;
        const count = branch.totalCount;
        let newerStart = count;
        for (;;) {
          if (closing || disposed) throw new Error('Roost session backend is disposed');
          // Keep scanned pages transient; detach the selected goal on return.
          const projected = await projectBranchPage(branch, decodeMessages(branch.messages), false);
          if (branch.state.revision !== revision || branch.totalCount !== count) throw staleRead();
          if (branch.startPosition + projected.length !== newerStart)
            throw new Error(`Roost active branch pages for ${viewId} are not contiguous`);
          latest = projectLatestGoal(projected, branch.startPosition);
          if (latest || !branch.cursor) break;
          newerStart = branch.startPosition;
          branch = await source.readActiveBranchPage(viewId, {
            before: branch.cursor,
            limit: branchPageSize,
          });
        }
      }
      const through = await source.observedEventCursor();
      await historyGeneration.resolve();
      if (
        cursor !== through ||
        source !== historyGeneration.history ||
        host !== historyGeneration.host ||
        generation !== readGeneration
      ) {
        needsRefresh = true;
        throw staleRead();
      }
      if (operationCursor === undefined && cursor === knownCursor) {
        goalProjection = latest;
        goalCoveredStart = latest?.position ?? 0;
      }
      return latest ? clone(latest.goal) : null;
    });
  const rememberPageEntries = (start: number, projected: readonly SessionEntry[]): void => {
    for (const [offset, turn] of projected.entries()) {
      const position = start + offset;
      const prior = pageEntries.get(turn.id);
      if (prior) pageIdsByPosition.delete(prior.position);
      pageEntries.delete(turn.id);
      pageEntries.set(turn.id, { position, turn });
      pageIdsByPosition.set(position, turn.id);
    }
    while (pageEntries.size > pageBodyLimit) {
      const oldest = pageEntries.keys().next().value;
      if (oldest === undefined) break;
      const prior = pageEntries.get(oldest);
      if (prior) pageIdsByPosition.delete(prior.position);
      pageEntries.delete(oldest);
    }
  };
  const readIndexedEntries = async (
    source: NodeLodyHistory,
    dispatchRows: readonly RoostDispatchRow[]
  ): Promise<SessionEntry[]> => {
    const physical = dispatchRows.flatMap((row) =>
      row.segments.map((segment) => ({ ...segment, businessId: row.entry.id }))
    );
    const messages: HistoryProjectedMessage[] = [];
    for (let start = 0; start < physical.length; start += 500) {
      const ids = physical
        .slice(start, start + 500)
        .map((segment) => Uint8Array.from(Buffer.from(segment.turnId, 'hex')));
      messages.push(...(await source.readProjectedMessagesById(ids)));
    }
    const byId = new Map(messages.map((message) => [bytesHex(message.turnId), message]));
    const ordered = physical.map((segment) => byId.get(segment.turnId));
    if (
      ordered.some(
        (message, i) =>
          !message ||
          message.businessId !== physical[i]?.businessId ||
          message.segmentId !== physical[i]?.segmentId
      )
    )
      throw new Error('Roost indexed history is incomplete');
    const projected = await projectMessages(ordered as HistoryProjectedMessage[]);
    if (
      projected.length !== dispatchRows.length ||
      projected.some((entry, i) => entry.id !== dispatchRows[i]?.entry.id)
    )
      throw new Error('Roost indexed logical history is incomplete');
    return projected;
  };
  const readPage = async (input: Parameters<typeof roostHistory.readActiveBranchPage>[1]) => {
    const generation = readGeneration;
    const source = roostHistory;
    const host = historyHost;
    const cursor = await source.observedEventCursor();
    const branch = await roostHistory.readActiveBranchPage(viewId, input);
    if (generation !== readGeneration || disposed) throw staleRead();
    const projected = await projectBranchPage(branch);
    if (cursor === (await source.observedEventCursor()))
      await rememberGoalPage(source, host, cursor, projected, branch.startPosition);
    if (input?.latest && branch.startPosition + projected.length !== branch.totalCount) {
      throw new Error(`Roost latest page for ${viewId} does not reach the active head`);
    }
    if (branch.state.revision === currentBranch().state.revision) {
      rememberPageEntries(branch.startPosition, projected);
    }
    return { branch, projected };
  };
  const cachedEntryAt = (position: number): SessionEntry | undefined => {
    if (position >= loadedStartPosition && position < loadedStartPosition + entries.length) {
      return entries[position - loadedStartPosition];
    }
    const id = pageIdsByPosition.get(position);
    return id ? pageEntries.get(id)?.turn : undefined;
  };
  const scanPages = async (
    visit: (page: Awaited<ReturnType<typeof readPage>>) => boolean
  ): Promise<void> => {
    let page = await readPage({ latest: true, limit: branchPageSize });
    const revision = page.branch.state.revision;
    const totalCount = page.branch.totalCount;
    while (!visit(page) && page.branch.cursor) {
      const newerStart = page.branch.startPosition;
      page = await readPage({ before: page.branch.cursor, limit: branchPageSize });
      if (page.branch.state.revision !== revision || page.branch.totalCount !== totalCount) {
        throw staleRead();
      }
      if (page.branch.startPosition + page.projected.length !== newerStart) {
        throw new Error(`Roost active branch pages for ${viewId} are not contiguous`);
      }
    }
  };
  const readRangeEntries = (from: number, to: number): Promise<SessionEntry[]> =>
    readStable(async () => {
      const start = Math.max(0, Math.min(from, totalHistoryCount));
      const end = Math.max(start, Math.min(to, totalHistoryCount));
      const cached: SessionEntry[] = [];
      for (let position = start; position < end; position += 1) {
        const entry = cachedEntryAt(position);
        if (!entry) break;
        cached.push(entry);
      }
      if (cached.length === end - start) return cached;
      const source = roostHistory;
      const host = historyHost;
      const generation = readGeneration;
      const cursor = await source.observedEventCursor();
      const index = dispatchIndex();
      const checkpoint = await index.checkpoint(cursor, totalHistoryCount);
      if (checkpoint) {
        try {
          const projected: SessionEntry[] = [];
          for (let position = start; position < end; position += 500) {
            const indexedRows = await index.range(
              checkpoint,
              position,
              Math.min(position + 500, end)
            );
            projected.push(...(await readIndexedEntries(source, indexedRows)));
          }
          await index.validate(checkpoint);
          if (cursor !== (await source.observedEventCursor())) {
            needsRefresh = true;
            throw staleRead();
          }
          // Generation replacement may be index-only, with no event-cursor change.
          await historyGeneration.resolve();
          if (
            source !== historyGeneration.history ||
            host !== historyGeneration.host ||
            generation !== readGeneration ||
            disposed
          ) {
            needsRefresh = true;
            throw staleRead();
          }
          rememberPageEntries(start, projected);
          return projected;
        } catch (error) {
          if (
            !(error instanceof z.ZodError) &&
            !(error instanceof SyntaxError) &&
            !(error instanceof RoostDispatchIndexCorrupt)
          )
            throw error;
          index.forget();
          console.error(`Roost position projection is unavailable for ${viewId}`, error);
        }
      }
      const selected = new Map<number, SessionEntry>();
      await scanPages(({ branch, projected }) => {
        for (const [offset, entry] of projected.entries()) {
          const position = branch.startPosition + offset;
          if (position >= start && position < end) selected.set(position, entry);
        }
        return branch.startPosition <= start;
      });
      return [...selected].sort(([left], [right]) => left - right).map(([, entry]) => entry);
    });
  const readLatestDirectoryPage = (limit: number): Promise<SessionHistoryDirectoryPage> =>
    readStable(async () => {
      if (limit === branchPageSize) return directoryPageFromBranch(currentBranch(), entries);
      const page = await readPage({ latest: true, limit });
      return directoryPageFromBranch(page.branch, page.projected);
    });
  const history: SessionHistoryReader = {
    waitForChanges: async (checkpoint, waitMs, signal) => {
      if (closing || disposed || signal?.aborted) throw new Error('History observer closed');
      let wake!: () => void;
      const changed = new Promise<void>((observed) => {
        wake = observed;
      });
      checkpointObservers.add(wake);
      const timer = setTimeout(wake, Math.min(15_000, Math.max(0, waitMs)));
      signal?.addEventListener('abort', wake, { once: true });
      try {
        if ((await history.getCheckpoint!()) === checkpoint) await changed;
        if (closing || disposed || signal?.aborted) throw new Error('History observer closed');
      } finally {
        clearTimeout(timer);
        checkpointObservers.delete(wake);
        signal?.removeEventListener('abort', wake);
      }
    },
    getPublication: () =>
      readStable(async () => {
        const cursor = await publishedNativeCursor();
        const head = publication.current()!;
        return {
          checkpoint: await historyChanges.checkpoint(cursor),
          historyRevision: head.historyRevision,
          historyCount: head.historyCount,
          historyChange:
            head.change?.kind === 'changed'
              ? { kind: 'changed' as const, ids: [...head.change.businessIds] }
              : head.change,
        };
      }),
    getCheckpoint: () =>
      readStable(async () => historyChanges.checkpoint(await publishedNativeCursor())),
    readChanges: (checkpoint, options) =>
      readStable(async () => {
        const through = await publishedNativeCursor();
        const changes = await historyChanges.read(checkpoint, through);
        if (changes.state !== 'ready' || !options?.withPatches) return changes;
        for (const row of currentBranch().messages) {
          if (
            row.segmentId === 'primary' &&
            !row.sealed &&
            changes.ids.includes(row.businessId) &&
            (await readState(row))
          )
            return changes;
        }
        const patches = await readRoostHistoryPatches(
          historyHost,
          currentBranch().messages,
          changes,
          checkpoint,
          through
        );
        return patches ? { ...changes, patches } : changes;
      }),
    count: () => readStable(async () => totalHistoryCount),
    readAt: (position) =>
      readStable(async () => {
        if (position < 0 || position >= totalHistoryCount) return { state: 'missing' };
        const [turn] = await readRangeEntries(position, position + 1);
        return turn ? readyTurn(turn) : { state: 'missing' };
      }),
    readTurn: (turnId) =>
      readStable(async () => {
        const position = positionById.get(turnId);
        const turn = position === undefined ? pageEntries.get(turnId)?.turn : entries[position];
        if (turn) return readyTurn(turn);
        const cursor = await roostHistory.observedEventCursor();
        const index = dispatchIndex();
        const checkpoint = await index.checkpoint(cursor, totalHistoryCount);
        if (checkpoint) {
          const row = await index.row(turnId, checkpoint);
          let projected: SessionEntry | undefined;
          if (row) {
            [projected] = await readIndexedEntries(roostHistory, [row]);
            if (!projected || projected.id !== turnId)
              throw new Error('Roost indexed dispatch turn is unavailable');
          }
          await index.validate(checkpoint);
          if (cursor !== (await roostHistory.observedEventCursor())) {
            needsRefresh = true;
            throw staleRead();
          }
          return projected ? readyTurn(projected) : { state: 'missing' };
        }
        if (
          !(await roostHistory.lookup({
            kind: 'message',
            businessId: turnId,
            segmentId: 'primary',
          }))
        ) {
          return { state: 'missing' };
        }
        let found: SessionEntry | undefined;
        await scanPages(({ projected }) => {
          found = projected.find((entry) => entry.id === turnId);
          return found !== undefined;
        });
        return found ? readyTurn(found) : { state: 'missing' };
      }),
    readRange: async (from, to) => (await readRangeEntries(from, to)).map(readyTurn),
    readDirectory: (from, to) =>
      readStable(async () => {
        const start = Math.max(0, Math.min(from, totalHistoryCount));
        return (await readRangeEntries(from, to)).map((entry, index) =>
          createRoostDirectoryRow(start + index, entry)
        );
      }),
    readLatestDirectoryPage,
    readOlderDirectoryPage: (cursor, limit) =>
      readStable(async () => {
        const decoded = branchCursors.get(cursor);
        if (!decoded) throw new Error('Roost history page cursor is stale or unknown');
        const page = await readPage({ before: decoded, limit });
        return directoryPageFromBranch(page.branch, page.projected);
      }),
    readAll: async () => (await readCompleteEntries()).map((entry) => clone(entry)),
    readTurnOutput: async (userTurnId) => {
      const complete = await readCompleteEntries();
      const completeDirectory = complete.map((entry, position) =>
        createRoostDirectoryRow(position, entry)
      );
      return selectTurnOutput(
        complete.length,
        userTurnId,
        (position) => completeDirectory[position]?.scalars,
        (position) => {
          const entry = complete[position];
          return entry ? clone(entry) : undefined;
        }
      );
    },
    observe(listener): SessionObservation {
      if (disposed) {
        return {
          initial: Promise.reject(new Error('Roost session backend is disposed')),
          unsubscribe: () => {},
        };
      }
      listeners.add(listener);
      const initialPage = readLatestDirectoryPage(branchPageSize);
      let active = true;
      return {
        initial: initialPage.then((page) => page.rows.map((row) => clone(row))),
        initialPage,
        unsubscribe: () => {
          if (!active) return;
          active = false;
          listeners.delete(listener);
        },
      };
    },
  };

  const rebuildDispatchIndex = async (index: RoostDispatchIndex, cursor: bigint) => {
    const count = totalHistoryCount;
    const source = roostHistory;
    const host = historyHost;
    const retainedState = new Set(stateCache.keys());
    const retainedPermissions = new Set(permissionCache.keys());
    const pages = async function* (): AsyncGenerator<readonly RoostDispatchRow[]> {
      let page = await source.readActiveBranchPage(viewId, { latest: true, limit: branchPageSize });
      const revision = page.state.revision;
      let end = count;
      const seen = new Set<string>();
      for (;;) {
        if (closing || disposed) throw new Error('Roost session backend is disposed');
        if (!page.complete || page.totalCount !== count || page.state.revision !== revision)
          throw staleRead();
        const projected = await projectBranchPage(page);
        if (page.startPosition + projected.length !== end) throw staleRead();
        const selected = projected.map((entry, offset): RoostDispatchRow => {
          if (seen.has(entry.id)) throw staleRead();
          seen.add(entry.id);
          return {
            position: page.startPosition + offset,
            entry: dispatchEntry(entry),
            segments: page.messages
              .filter((message) => message.businessId === entry.id)
              .map((message) => ({
                turnId: bytesHex(message.turnId),
                segmentId: message.segmentId,
              })),
          };
        });
        yield selected;
        // Repair reads may visit every old page, but do not retain their bodies.
        for (const key of stateCache.keys()) if (!retainedState.has(key)) stateCache.delete(key);
        for (const key of permissionCache.keys())
          if (!retainedPermissions.has(key)) permissionCache.delete(key);
        end = page.startPosition;
        if (end === 0) break;
        if (!page.cursor) throw staleRead();
        page = await source.readActiveBranchPage(viewId, {
          before: page.cursor,
          limit: branchPageSize,
        });
      }
    };
    await index.rebuild(cursor, count, pages(), async () => {
      if (
        source !== roostHistory ||
        host !== historyHost ||
        cursor !== (await source.observedEventCursor())
      ) {
        needsRefresh = true;
        throw staleRead();
      }
    });
  };

  const readDispatch = (
    includeTurnIds: readonly string[],
    select?: SessionDispatchSelector
  ): Promise<SessionDispatchSelection> => {
    if (closing || disposed) return Promise.reject(new Error('Roost session backend is disposed'));
    const requested = [...includeTurnIds];
    // A repair owns the same queue as commands. No writer can advance half of
    // the projection locally while its complete checkpoint is being installed.
    const next = writeSerial.then(() =>
      readStable(async () => {
        const cursor = await roostHistory.observedEventCursor();
        if (knownCursor !== cursor) await reloadBranch({ publish: true });
        const index = dispatchIndex();
        let checkpoint = await index.checkpoint(cursor, totalHistoryCount);
        if (!checkpoint) {
          await rebuildDispatchIndex(index, cursor);
          checkpoint = await index.checkpoint(cursor, totalHistoryCount);
        }
        if (!checkpoint) throw staleRead();
        let result: SessionDispatchEntry[];
        try {
          result = await index.read(checkpoint, requested);
        } catch (error) {
          if (
            !(error instanceof z.ZodError) &&
            !(error instanceof SyntaxError) &&
            !(error instanceof RoostDispatchIndexCorrupt)
          ) {
            index.forget();
            throw error;
          }
          await rebuildDispatchIndex(index, cursor);
          const repaired = await index.checkpoint(cursor, totalHistoryCount);
          if (!repaired) throw staleRead();
          result = await index.read(repaired, requested);
        }
        const turnId = select?.(result);
        const turn = turnId === undefined ? undefined : await history.readTurn(turnId);
        if (cursor !== (await roostHistory.observedEventCursor())) {
          needsRefresh = true;
          throw staleRead();
        }
        return { history: result, turnId, turn };
      })
    );
    writeSerial = next.then(
      () => {},
      () => {}
    );
    return next;
  };

  if (totalHistoryCount === 0) {
    const cursor = await roostHistory.observedEventCursor();
    if (!(await dispatchIndex().checkpoint(cursor, 0)))
      await rebuildDispatchIndex(dispatchIndex(), cursor);
  }

  const { createRoostSessionData } = await import('@lody/shared/session-data');
  syncModelSummary = async () => {
    const position = latestModelTurnId ? positionById.get(latestModelTurnId) : undefined;
    const cached = position === undefined ? undefined : entries[position];
    const read = cached
      ? { state: 'ready' as const, turn: cached }
      : latestModelTurnId
        ? await history.readTurn(latestModelTurnId)
        : { state: 'missing' as const };
    const turn = read.state === 'ready' ? [read.turn] : [];
    await sessionDoc.setLastModel(clone(latestSessionModel(turn)));
  };
  await syncModelSummary();

  const pendingSeen = new Map<string, Promise<void>>();

  let committedGoal:
    | { host: RoostNodeStream; cursor: bigint; latest: RoostGoalProjection }
    | undefined;
  const publishCursor = async (
    commandStartCursor: bigint,
    verifyGoalCursor?: (cursor: bigint) => Promise<boolean>,
    metadataCovered?: (cursor: bigint) => boolean
  ): Promise<void> => {
    const settled = historyGeneration.settledWriteCursor();
    const cursor =
      settled !== undefined && publication.current()?.cursor === settled.toString()
        ? settled
        : await roostHistory.observedEventCursor();
    const owned = verifyGoalCursor && (await verifyGoalCursor(cursor).catch(() => false));
    if (verifyGoalCursor && !owned) {
      // Do not label an externally changed window as current merely because
      // its event cursor was observed while publishing our own command.
      needsRefresh = true;
      goalProjection = undefined;
      await reloadBranch({ publish: true });
    }
    const dispatch = dispatchIndex();
    const dispatchBase = dispatch.current();
    if (
      owned &&
      dispatchMembershipKnown &&
      dispatchBase &&
      BigInt(dispatchBase.header.cursor) >= commandStartCursor &&
      BigInt(dispatchBase.header.cursor) < cursor &&
      (pendingStructuralFrom === undefined || pendingStructuralFrom >= dispatchBase.header.count)
    ) {
      try {
        const plan = await dispatch.plan(dispatchBase, cursor, totalHistoryCount, [
          ...pendingDispatchUpdates.values(),
        ]);
        const added = plan.changed.filter((row) => row.position >= dispatchBase.header.count);
        if (totalHistoryCount !== dispatchBase.header.count + added.length) throw staleRead();
        await dispatch.commit(plan);
      } catch (error) {
        // History remains authoritative. An old cursor cannot authorize this
        // cache; the next dispatch read performs a fenced bounded-page rebuild.
        dispatch.forget();
        console.error(`Roost dispatch projection needs repair for ${viewId}`, error);
      }
    }
    if (goalProjection !== undefined) {
      if (
        owned &&
        !(
          committedGoal?.host === historyHost &&
          committedGoal.cursor === cursor &&
          equal(committedGoal.latest, goalProjection)
        )
      ) {
        await writeGoalProjection(historyHost, cursor, goalProjection).catch(() => {
          goalProjection = undefined;
          needsRefresh = true;
        });
      } else if (!owned) {
        goalProjection = undefined;
      }
    }
    const change = pendingChange;
    if (!owned || !metadataCovered?.(cursor))
      await historyChanges.record(
        commandStartCursor,
        cursor,
        pendingStructuralFrom === undefined
          ? undefined
          : { kind: 'structure', from: pendingStructuralFrom, to: totalHistoryCount },
        Boolean(owned),
        [...pendingChangedIds]
      );
    if (
      publication.current()?.cursor !== cursor.toString() ||
      publication.current()?.historyCount !== totalHistoryCount
    )
      await publication.publish(
        cursor,
        totalHistoryCount,
        change,
        await roostHistory.publicationFence(cursor)
      );
    knownCursor = cursor;
    for (const wake of checkpointObservers) wake();
    if (pendingChange === change) {
      pendingChange = undefined;
      pendingChangedIds.clear();
      pendingStructuralFrom = undefined;
    }
    if (change) notifyHistoryChange(change);
    if (pendingModelSummary) {
      await syncModelSummary?.();
      pendingModelSummary = false;
    }
  };

  const withWrites = async (
    operationId: string,
    operation: () => Promise<boolean | void>,
    // Only receipt-backed immutable commands may recover partial durable work.
    idempotent?: { optimistic: boolean }
  ): Promise<void> => {
    if (closing || disposed) throw new Error('Roost session backend is disposed');
    const next = writeSerial.then(async () => {
      for (let attempt = 0; ; attempt += 1) {
        let evidence: ReturnType<RoostHistoryGeneration['trackWrites']> | undefined;
        let operationCompleted = false;
        try {
          pendingDispatchUpdates.clear();
          const warm = Boolean(
            idempotent?.optimistic &&
            !needsRefresh &&
            !reloadPromise &&
            windowHistory === historyGeneration.history &&
            knownCursor !== undefined &&
            publication.current()?.cursor === knownCursor.toString()
          );
          if (!warm) await historyGeneration.resolve();
          if (needsRefresh || reloadPromise || windowHistory !== historyGeneration.history) {
            await reloadBranch({ publish: true });
            needsRefresh = false;
          }
          let cursor = warm ? knownCursor! : await roostHistory.observedEventCursor();
          if (knownCursor !== undefined && knownCursor !== cursor) {
            await reloadBranch({ publish: true });
            cursor = await roostHistory.observedEventCursor();
          }
          operationCursor = cursor;
          dispatchMembershipKnown = true;
          await dispatchIndex().checkpoint(cursor, totalHistoryCount);
          evidence = historyGeneration.trackWrites(cursor);
          goalProjection =
            totalHistoryCount === 0
              ? null
              : committedGoal?.host === historyHost && committedGoal.cursor === cursor
                ? clone(committedGoal.latest)
                : await readGoalProjection(historyHost, cursor, totalHistoryCount).catch(
                    () => undefined
                  );
          const changed = await operation();
          operationCompleted = true;
          if (changed !== false || pendingChange || pendingModelSummary) {
            for (let publicationAttempt = 0; ; publicationAttempt++) {
              try {
                await publishCursor(cursor, evidence.verify, evidence.metadataCovered);
                break;
              } catch (error) {
                if (
                  !(error instanceof Error) ||
                  !('code' in error) ||
                  error.code !== 'stale' ||
                  publicationAttempt >= 2
                )
                  throw error;
                // The action is already applied. Only repair its observation;
                // rerunning an append here would duplicate durable content.
                needsRefresh = true;
                goalProjection = undefined;
                await reloadBranch({ publish: true });
              }
            }
          }
          return;
        } catch (failure) {
          const committed = operationCompleted || (!idempotent && evidence?.hasCommitted());
          const error =
            committed && failure instanceof Error && 'code' in failure && failure.code === 'stale'
              ? Object.assign(
                  new Error('Roost history observation could not safely retry after durable work', {
                    cause: failure,
                  }),
                  { code: operationCompleted ? 'publication_stale' : 'write_stale' }
                )
              : failure;
          committedGoal = undefined;
          dispatchIndex().forget();
          operationCursor = undefined;
          needsRefresh = true;
          const stale = error instanceof Error && 'code' in error && error.code === 'stale';
          if (idempotent) idempotent.optimistic = false;
          if (!stale || attempt >= 2) {
            reportRoostHistoryFailure(error, {
              stage: 'write',
              sessionId: viewId,
              operation: operationId.split(':')[0],
            });
            throw error;
          }
          await reloadBranch({ publish: true });
          needsRefresh = false;
        } finally {
          evidence?.stop();
          operationCursor = undefined;
          pendingDispatchUpdates.clear();
        }
      }
    });
    writeSerial = next.catch(() => {});
    await next;
  };

  const headRow = async (branch: ActiveBranchPageRead) => {
    const head = branch.state.head;
    if (!head) return undefined;
    const cached = projectedByIdentity.get(identityKey(head));
    if (cached) return cached;
    // A late successor may be the physical head of an older logical turn
    // outside the display window. It is still the next append's sealed parent.
    const read = await roostHistory.lookup(head);
    if (read?.kind !== 'found') throw new Error(`Roost active head for ${viewId} is incomplete`);
    return {
      ...head,
      turnId: read.turn.turnId,
      nextSeq: read.turn.nextSeq,
      sealed: read.turn.sealed !== null,
      sealedHash: read.turn.sealed,
    };
  };

  const ensureHeadSealed = async (): Promise<ActiveBranchPageRead> => {
    let branch = currentBranch();
    const row = await headRow(branch);
    if (row && !row.sealed) {
      await roostHistory.finish(row.turnId, row.nextSeq);
      await refreshProjectedMessage(row.turnId);
      branch = currentBranch();
    }
    return branch;
  };

  const parentForHead = async (
    branch: ActiveBranchPageRead
  ): Promise<{ id: Uint8Array; hash: Uint8Array }[]> => {
    const row = await headRow(branch);
    if (!row) return [];
    if (!row.sealedHash)
      throw new Error(`Roost active head ${row.businessId}/${row.segmentId} is not sealed`);
    return [{ id: row.turnId.slice(), hash: row.sealedHash.slice() }];
  };

  const finishIfNeeded = async (turnId: Uint8Array): Promise<void> => {
    const result = await historyHost.readTurnHeader(turnId);
    const turn =
      result.kind === 'found'
        ? result.turn
        : result.kind === 'incomplete'
          ? result.prefix
          : undefined;
    if (turn && !turn.sealed) {
      await roostHistory.finish(turnId, turn.nextSeq);
      await refreshProjectedMessage(turnId);
    }
  };

  const prepareTurn = (
    before: SessionHistoryInput | undefined,
    after: SessionHistoryInput
  ): SessionHistoryInput => {
    if (Object.hasOwn(after, ROOST_CLEAR_FIELDS_KEY))
      throw new HistoryWriteError([{ path: [ROOST_CLEAR_FIELDS_KEY], code: 'reserved_field' }]);
    if (before && before.id !== after.id)
      throw new HistoryWriteError([{ path: ['id'], code: 'invalid_input' }]);
    return (
      before ? prepareReplacement(before, after) : parseHistoryWrite(HistoryEntryWriteSchema, after)
    ) as SessionHistoryInput;
  };

  const rememberGoal = (entry: SessionHistoryInput, position: number | undefined): void => {
    const next = projectChangedGoal(goalProjection, entry, position, totalHistoryCount);
    goalProjection = next.latest;
    if (next.invalidated) goalCoveredStart = totalHistoryCount;
  };

  const planTurnWrite = async (
    before: SessionHistoryInput,
    after: SessionHistoryInput
  ): Promise<HistoryBatchCommand[]> => {
    if (equal(before, after)) return [];
    const primary =
      currentBranch().messages.find(
        (row) => row.businessId === after.id && row.segmentId === 'primary'
      ) ?? (await readRecord({ kind: 'message', businessId: after.id, segmentId: 'primary' }));
    if (!primary) throw new Error(`Roost turn ${after.id} not found`);
    const state = await readState(primary);
    if (state || primary.sealed) {
      const identity = stateIdentity(primary);
      const content = encodeRoostContent(
        createRoostMessageState(toApplicationJson(primary.content), bytesHex(primary.turnId), after)
      );
      return [
        state
          ? {
              type: 'setContent',
              identity,
              expectedNextSeq: state.nextSeq,
              content,
            }
          : {
              type: 'accept',
              identity,
              parents: primary.sealedHash ? [{ id: primary.turnId, hash: primary.sealedHash }] : [],
              content,
            },
      ];
    }
    const identity = { kind: 'message' as const, businessId: after.id, segmentId: 'primary' };
    return [
      {
        type: 'setContent',
        identity,
        expectedNextSeq: primary.nextSeq,
        content: encodeRoostContent(after),
      },
      ...(after.finished === true
        ? [{ type: 'finish' as const, identity, expectedNextSeq: primary.nextSeq + 1n }]
        : []),
    ];
  };

  // A content/state transaction does not change branch membership. Refresh only
  // affected primary bodies; older hydrated bodies are invalidated on demand.
  const refreshTurnProjections = async (
    changed: readonly string[],
    staged?: ReadonlyMap<
      string,
      {
        message: HistoryProjectedMessage;
        row: RoostHistorySegment;
        entry?: SessionEntry;
        state?: HistoryProjectedMessage;
      }
    >
  ): Promise<void> => {
    if (!changed.length) return;
    const ids = new Set(changed);
    for (const key of stateCache.keys()) {
      if (ids.has(key.slice(0, key.indexOf('\u0000')))) stateCache.delete(key);
    }
    // Exact local commit evidence covers the preflight overlay lookup too,
    // including its absence. Unknown/foreign intervals never supply `staged`.
    for (const value of staged?.values() ?? [])
      stateCache.set(identityKey(stateIdentity(value.message)), Promise.resolve(value.state));
    while (stateCache.size > 500) stateCache.delete(stateCache.keys().next().value!);
    for (const id of ids) {
      const cached = pageEntries.get(id);
      if (cached) pageIdsByPosition.delete(cached.position);
      pageEntries.delete(id);
    }
    fullEntriesCache = undefined;
    const branch = currentBranch();
    const retainedRows = new Map(branch.messages.map((message, index) => [message, rows[index]]));
    const primaryIds = branch.messages
      .filter((row) => row.segmentId === 'primary' && ids.has(row.businessId))
      .map((row) => row.turnId);
    const fresh = staged
      ? primaryIds.map((id) => staged.get(bytesHex(id))!.message)
      : await roostHistory.readProjectedMessagesById(primaryIds);
    if (fresh.length !== primaryIds.length || fresh.some((row) => !row || !ids.has(row.businessId)))
      throw new Error('Roost changed history is incomplete');
    const byPhysicalId = new Map(fresh.map((row) => [bytesHex(row.turnId), row]));
    const messages = branch.messages.map((row) => byPhysicalId.get(bytesHex(row.turnId)) ?? row);
    const changedMessages = messages.filter((row) => ids.has(row.businessId));
    const decoded = changedMessages.map(
      (message) => staged?.get(bytesHex(message.turnId))?.row ?? adaptRoostProjectedMessage(message)
    );
    // Keep the existing logical projection (including canonical field order and
    // overlays), without detaching these already private path copies again.
    const projected = await projectMessages(changedMessages, decoded, !staged);
    for (const entry of projected) {
      const position = positionById.get(entry.id);
      if (position === undefined) throw new Error('Roost changed history has no position');
      const physical = changedMessages.find((message) => message.businessId === entry.id);
      const source = physical ? staged?.get(bytesHex(physical.turnId))?.entry : undefined;
      for (const [index, item] of (entry.items ?? []).entries())
        inheritHistoryStreamText(source?.items?.[index], item);
      entries[position] = staged ? entry : clone(entry);
      directory[position] = createRoostDirectoryRow(loadedStartPosition + position, entry);
    }
    activeBranch = { ...branch, messages };
    rows = messages.map(
      (message) =>
        retainedRows.get(message) ??
        staged?.get(bytesHex(message.turnId))?.row ??
        adaptRoostProjectedMessage(message)
    );
    rebuildSegmentIndexes(messages);
    readGeneration += 1;
    updateLatestSummaryTargets();
    pendingModelSummary = true;
  };

  const commitTurnChanges = async (
    before: readonly SessionHistoryInput[],
    next: readonly SessionHistoryInput[],
    operationId: string,
    extra: readonly HistoryBatchCommand[] = [],
    textAppends?: readonly AgentHistoryTextAppend[],
    changes?: readonly AgentHistoryMutationPath[]
  ): Promise<boolean> => {
    const oldById = new Map(before.map((entry) => [entry.id, entry]));
    // Preflight every authored change before creating a receipt or editing a turn.
    const prepared = next.map((entry) => prepareTurn(oldById.get(entry.id), entry));
    const positions = new Map(
      prepared.map((entry) => {
        const position = positionById.get(entry.id);
        return [
          entry.id,
          position === undefined
            ? pageEntries.get(entry.id)?.position
            : loadedStartPosition + position,
        ];
      })
    );
    // Existing published turns can be patched atomically through the public
    // Native API. Compact per-item receipts share that transaction, so retry
    // recovery needs no duplicate content or SDK snapshot batch Turns.
    const patchWrites: Write[] = [];
    const patchReceipts: IndexPut[] = [];
    const patchIds: string[] = [];
    const patchTargets = new Map<
      string,
      {
        primary: HistoryProjectedMessage;
        target: HistoryProjectedMessage;
        state: boolean;
        appends?: TextAppendHints;
      }
    >();
    let canPatch = true;
    for (const command of extra) {
      const content = command.type === 'accept' ? toApplicationJson(command.content) : undefined;
      if (
        command.type !== 'accept' ||
        command.identity.kind !== 'publication' ||
        command.parents.length ||
        !record(content) ||
        typeof content.digest !== 'string'
      ) {
        canPatch = false;
        break;
      }
      patchReceipts.push(agentReceiptPut(command.identity, content.digest));
    }
    if (canPatch)
      for (const entry of prepared) {
        const old = oldById.get(entry.id);
        if (!old) throw new Error('A structural history change requires a generation');
        if (equal(old, entry)) continue;
        const primary =
          currentBranch().messages.find(
            (row) => row.businessId === entry.id && row.segmentId === 'primary'
          ) ?? (await readRecord({ kind: 'message', businessId: entry.id, segmentId: 'primary' }));
        if (!primary) throw new Error(`Roost turn ${entry.id} not found`);
        const state = await readState(primary);
        const target = state ?? primary;
        if (
          target.sealed ||
          (!state &&
            currentBranch().messages.some(
              (row) => row.businessId === entry.id && row.segmentId !== 'primary'
            ))
        ) {
          canPatch = false;
          break;
        }
        const fieldChanges = changes?.filter((change) => change.turnId === entry.id);
        const appends = textAppends ? coalesceAgentTextAppends(textAppends, entry.id) : undefined;
        const statePlan = state
          ? planRoostMessageState(
              decodedContent(primary),
              bytesHex(primary.turnId),
              decodedContent(state),
              old,
              entry,
              appends,
              fieldChanges
            )
          : undefined;
        const content = statePlan?.content ?? entry;
        const hints = state ? statePlan?.appends : appends;
        const ops = state
          ? roostMessageStatePatches(decodedContent(target), content, hints)
          : roostContentPatches(decodedContent(target), content, hints, fieldChanges);
        patchTargets.set(bytesHex(target.turnId), {
          primary,
          target,
          state: !!state,
          appends: hints,
        });
        if (ops.length) {
          patchWrites.push({
            kind: 'edit',
            turnId: target.turnId,
            expectedNextSeq: target.nextSeq,
            ops,
          });
          if (!state && entry.finished === true)
            patchWrites.push({
              kind: 'seal',
              turnId: target.turnId,
              // Each native content operation consumes one sequence slot.
              expectedNextSeq: target.nextSeq + BigInt(ops.length),
            });
          patchIds.push(entry.id);
        }
      }
    if (canPatch && patchWrites.length <= 64) {
      if (!patchWrites.length && !patchReceipts.length) return false;
      const branch = currentBranch();
      const generation = readGeneration;
      const staged = new Map<
        string,
        {
          message: HistoryProjectedMessage;
          row: RoostHistorySegment;
          entry?: SessionEntry;
          state?: HistoryProjectedMessage;
        }
      >();
      const seals: { key: string; turnId: Uint8Array; nextSeq: bigint }[] = [];
      let stagedWrites = 0;
      for (const write of patchWrites) {
        if (write.kind === 'seal') {
          const found = [...staged].find(
            ([, value]) =>
              bytesHex((value.state ?? value.message).turnId) === bytesHex(write.turnId)
          );
          if (!found) break;
          const [key, value] = found,
            target = value.state ?? value.message;
          if (target.nextSeq !== write.expectedNextSeq) break;
          const sealed = {
            ...target,
            nextSeq: target.nextSeq + 1n,
            sealed: true,
            sealedHash: null,
          };
          const content = decodedContents.get(target);
          if (content !== undefined) decodedContents.set(sealed, content);
          staged.set(
            key,
            value.state
              ? { ...value, state: sealed }
              : {
                  ...value,
                  message: sealed,
                  row: { ...value.row, nextSeq: sealed.nextSeq, sealed: true },
                }
          );
          seals.push({ key, turnId: write.turnId, nextSeq: sealed.nextSeq });
          stagedWrites++;
          continue;
        }
        if (write.kind !== 'edit') break;
        const plan = patchTargets.get(bytesHex(write.turnId));
        if (!plan) break;
        const index = branch.messages.findIndex(
          (message) => bytesHex(message.turnId) === bytesHex(plan.primary.turnId)
        );
        const message = branch.messages[index],
          row = rows[index];
        if (
          !message ||
          !row ||
          plan.target.sealed ||
          plan.target.nextSeq !== write.expectedNextSeq ||
          (!plan.state &&
            (message.segmentId !== 'primary' ||
              branch.messages.some(
                (other) => other.businessId === message.businessId && other !== message
              )))
        )
          break;
        const content = stageRoostContent(plan.target.content, write.ops, plan.appends, 'sdk');
        const decoded = plan.state
          ? row.content
          : stageRoostContent(row.content, write.ops, plan.appends);
        if (content === undefined || decoded === undefined) break;
        const target = {
          ...plan.target,
          content,
          nextSeq: plan.target.nextSeq + BigInt(write.ops.length),
        };
        const decodedTarget = plan.state
          ? stageRoostContent(decodedContent(plan.target), write.ops, plan.appends)
          : decoded;
        if (decodedTarget === undefined) break;
        decodedContents.set(target, decodedTarget);
        staged.set(bytesHex(message.turnId), {
          message: plan.state ? message : target,
          row: plan.state ? row : { ...row, content: decoded, nextSeq: target.nextSeq },
          entry: prepared.find((entry) => entry.id === message.businessId) as
            | SessionEntry
            | undefined,
          ...(plan.state ? { state: target } : {}),
        });
        stagedWrites++;
      }
      let nextGoal = goalProjection;
      for (const entry of prepared)
        nextGoal = projectChangedGoal(
          nextGoal,
          entry,
          positions.get(entry.id),
          totalHistoryCount
        ).latest;
      const stagedGoal = clone(nextGoal);
      const commitHost = historyGeneration.host;
      const through =
        operationCursor === undefined
          ? undefined
          : operationCursor +
            patchWrites.reduce(
              (count, write) => count + (write.kind === 'edit' ? BigInt(write.ops.length) : 1n),
              0n
            );
      const dispatch = dispatchIndex();
      const dispatchBase =
        operationCursor === undefined
          ? undefined
          : await dispatch.checkpoint(operationCursor, totalHistoryCount);
      const dispatchUpdates = prepared.map((entry) => ({
        before: oldById.get(entry.id),
        after: dispatchEntry(entry),
        position: positions.get(entry.id),
      }));
      const dispatchPlan =
        dispatchBase && through !== undefined
          ? await dispatch.plan(dispatchBase, through, totalHistoryCount, dispatchUpdates)
          : undefined;
      const dispatchPuts = dispatchPlan ? dispatch.derivedPuts(dispatchPlan) : undefined;
      const publicationChange =
        pendingChange?.kind === 'structure'
          ? pendingChange
          : {
              kind: 'changed' as const,
              businessIds: [...new Set([...(pendingChange?.businessIds ?? []), ...patchIds])],
            };
      const headPlan =
        through === undefined
          ? undefined
          : publication.plan(
              through,
              totalHistoryCount,
              publicationChange.kind === 'changed' && !publicationChange.businessIds.length
                ? undefined
                : publicationChange
            );
      const commit = await historyGeneration
        .commitPatches(
          patchWrites,
          patchReceipts,
          operationCursor,
          patchIds,
          [
            ...(stagedGoal !== undefined && through !== undefined
              ? [goalProjectionPut(through, stagedGoal)]
              : []),
            ...(dispatchPuts ?? []),
            ...(headPlan ? [headPlan.put] : []),
          ],
          [
            ...(dispatchPlan && dispatchPuts ? [dispatch.expected(dispatchPlan)] : []),
            ...(headPlan ? [headPlan.expected] : []),
          ],
          extra.flatMap((command) => (command.type === 'accept' ? [command.identity] : []))
        )
        .catch((error) => {
          if (
            patchReceipts.length &&
            error instanceof Error &&
            'code' in error &&
            error.code === 'conflict'
          )
            throw Object.assign(new Error('Agent operation identity conflict', { cause: error }), {
              code: 'conflict',
            });
          throw error;
        });
      // Native returns an atomic no-op when any batch item was committed before.
      // Recover/filter receipts before replanning; never install the staged delta.
      if (commit.replayed?.some(Boolean)) throw staleRead();
      if (
        headPlan &&
        commit.derivedIndexesApplied &&
        commit.before === operationCursor &&
        commit.through === through
      )
        publication.accept(headPlan);
      if (
        dispatchPlan &&
        dispatchPuts &&
        commit.derivedIndexesApplied &&
        commit.before === operationCursor &&
        commit.through === through
      )
        dispatch.accept(dispatchPlan);
      if (
        stagedGoal !== undefined &&
        commit.derivedIndexesApplied &&
        commit.before === operationCursor &&
        commit.through === through &&
        through !== undefined
      )
        committedGoal = { host: commitHost, cursor: through, latest: stagedGoal };
      let stagedReady =
        commit.metadataAttached &&
        commit.before === operationCursor &&
        currentBranch() === branch &&
        readGeneration === generation &&
        stagedWrites === patchWrites.length &&
        (![...staged.values()].some((value) => value.state) || commit.derivedIndexesApplied);
      if (stagedReady)
        for (const seal of seals) {
          const header = await historyHost.readTurnHeader(seal.turnId);
          if (
            header.kind !== 'found' ||
            !header.turn.sealed ||
            header.turn.nextSeq !== seal.nextSeq
          ) {
            stagedReady = false;
            break;
          }
          const value = staged.get(seal.key);
          if (!value) {
            stagedReady = false;
            break;
          }
          const sealed = {
            ...(value.state ?? value.message),
            sealedHash: header.turn.sealed.slice(),
          };
          staged.set(
            seal.key,
            value.state ? { ...value, state: sealed } : { ...value, message: sealed }
          );
        }
      await refreshTurnProjections(
        patchIds,
        stagedReady && currentBranch() === branch && readGeneration === generation
          ? staged
          : undefined
      );
      for (const update of dispatchUpdates) rememberDispatch(update);
      for (const entry of prepared) rememberGoal(entry, positions.get(entry.id));
      if (patchIds.length) recordChange({ kind: 'changed', businessIds: patchIds });
      if (patchIds.length) pendingModelSummary = true;
      return patchIds.length > 0;
    }
    const commands: HistoryBatchCommand[] = [...extra];
    const changed: string[] = [];
    for (const entry of prepared) {
      const old = oldById.get(entry.id);
      if (!old) throw new Error('A structural history change requires a generation');
      const writes = await planTurnWrite(old, entry);
      if (writes.length) {
        commands.push(...writes);
        changed.push(entry.id);
      }
    }
    if (!commands.length) return false;
    if (commands.length > 64) {
      const replacements = new Map(prepared.map((entry) => [entry.id, entry]));
      const nextHistory = (await readAll()).map((entry) => replacements.get(entry.id) ?? entry);
      await historyGeneration.replace(nextHistory, operationId, operationCursor, {
        commands: extra,
      });
      await reloadBranch({ publish: true });
      goalProjection = projectLatestGoal(nextHistory);
    } else {
      await roostHistory.commitHistoryBatch(
        `${operationId}:${randomBytes(8).toString('hex')}`,
        commands,
        { recovery: 'local' }
      );
      await refreshTurnProjections(changed);
      for (const entry of prepared)
        rememberDispatch({
          before: oldById.get(entry.id),
          after: dispatchEntry(entry),
          position: positions.get(entry.id),
        });
      for (const entry of prepared) rememberGoal(entry, positions.get(entry.id));
    }
    if (changed.length) recordChange({ kind: 'changed', businessIds: changed });
    pendingModelSummary = true;
    return true;
  };

  const updateTurn = async (
    before: SessionHistoryInput | undefined,
    after: SessionHistoryInput,
    operationId: string
  ): Promise<boolean> => {
    const prepared = prepareTurn(before, after);
    if (before) return commitTurnChanges([before], [prepared], operationId);
    const existing = await history.readTurn(prepared.id);
    if (existing.state === 'ready') {
      if (equal(existing.turn, prepared)) return false;
      throw new HistoryWriteError([{ path: ['id'], code: 'duplicate_id' }]);
    }
    const archived = await roostHistory.lookup({
      kind: 'message',
      businessId: prepared.id,
      segmentId: 'primary',
    });
    if (archived) {
      // SDK identities survive an internal branch replacement. Reusing a
      // removed business id is still allowed by the shared history contract;
      // stage only this uncommon collision through a fresh storage generation.
      const current = await readAll();
      const sameId = current.find((entry) => entry.id === prepared.id);
      if (sameId) {
        if (equal(sameId, prepared)) return false;
        throw new HistoryWriteError([{ path: ['id'], code: 'duplicate_id' }]);
      }
      const next = [...current, prepared];
      await historyGeneration.replace(next, operationId, operationCursor);
      await reloadBranch({ publish: true });
      goalProjection = projectLatestGoal(next);
      return true;
    }
    let branch = await ensureHeadSealed();
    const accepted = await roostHistory.acceptToView({
      viewId,
      expectedRevision: branch.state.revision,
      expectedHead: branch.state.head,
      operationId,
      input: {
        kind: 'message',
        businessId: prepared.id,
        segmentId: 'primary',
        parents: await parentForHead(branch),
        content: encodeRoostContent(prepared),
      },
    });
    await refreshProjectedMessage(accepted.turnId, accepted);
    if (prepared.finished === true) await finishIfNeeded(accepted.turnId);
    rememberGoal(prepared, totalHistoryCount - 1);
    return accepted.created;
  };

  const readAll = async (): Promise<SessionHistoryInput[]> => {
    const all = (await history.readAll()) as SessionHistoryInput[];
    goalProjection = projectLatestGoal(all);
    return all;
  };

  const readEditableWindow = async () => {
    const branch = currentBranch();
    let selected = [...entries];
    let start = loadedStartPosition;
    let cursor = branch.cursor;
    // Include the preceding user identity as well as the provider boundary.
    // Work grows with the editable suffix, rather than the retained prefix.
    while (cursor && selected.filter((entry) => entry.role === 'user').length < 2) {
      const page = await readPage({ before: cursor, limit: branchPageSize });
      if (
        page.branch.totalCount !== branch.totalCount ||
        page.branch.state.revision !== branch.state.revision ||
        page.branch.startPosition + page.projected.length !== start
      )
        throw staleRead();
      selected = [...page.projected, ...selected];
      start = page.branch.startPosition;
      cursor = page.branch.cursor;
    }
    return { selected, start };
  };

  const replaceActiveHistory = async (
    next: readonly SessionHistoryInput[],
    operationId: string,
    extra: readonly HistoryBatchCommand[] = [],
    options: { storedCopy?: boolean } = {}
  ): Promise<boolean> => {
    const current = await readAll();
    const byId = new Map(current.map((entry) => [entry.id, entry]));
    const ids = new Set<string>();
    const prepared = next.map((entry) => {
      if (ids.has(entry.id))
        throw new HistoryWriteError([{ path: ['history'], code: 'duplicate_id' }]);
      ids.add(entry.id);
      return options.storedCopy ? entry : prepareTurn(byId.get(entry.id), entry);
    });
    if (equal(current, prepared) && !extra.length) return false;
    if (
      current.length === prepared.length &&
      current.every((entry, index) => entry.id === prepared[index]?.id) &&
      prepared.filter((entry, index) => !equal(entry, current[index])).length * 2 + extra.length <=
        64
    ) {
      return commitTurnChanges(current, prepared, operationId, extra);
    }
    if (
      !options.storedCopy &&
      !extra.length &&
      prepared.length === current.length + 1 &&
      current.every((entry, index) => equal(entry, prepared[index]))
    ) {
      const entry = prepared.at(-1)!;
      if (
        !(await roostHistory.lookup({
          kind: 'message',
          businessId: entry.id,
          segmentId: 'primary',
        }))
      )
        return updateTurn(undefined, entry, operationId);
    }
    await historyGeneration.replace(prepared, operationId, operationCursor, { commands: extra });
    await reloadBranch({ publish: true });
    goalProjection = projectLatestGoal(prepared);
    recordChange({ kind: 'structure', from: 0, to: Math.max(current.length, prepared.length) });
    return true;
  };

  // Borrow only while withWrites owns the serialized operation. Public reads detach.
  const readPrivateTurn = async (turnId: string) => {
    const position = positionById.get(turnId);
    const cached = position === undefined ? pageEntries.get(turnId)?.turn : entries[position];
    return cached ? { state: 'ready' as const, turn: cached } : history.readTurn(turnId);
  };

  const commands: SessionHistoryCommands = {
    async applyHistoryAction(action) {
      let matched = false;
      await withWrites(`action:${operationDigest(action)}`, async () => {
        const target = historyActionTarget(action);
        const selected = target ? await readPrivateTurn(target) : undefined;
        const before = target
          ? selected?.state === 'ready'
            ? [selected.turn as SessionHistoryInput]
            : []
          : await readAll();
        const result = planDomainHistoryAction(before as never, action);
        matched = result.matched;
        const turns = result.turns as unknown as SessionHistoryInput[];
        return target
          ? commitTurnChanges(
              before,
              turns,
              `action:${operationDigest(action)}`,
              [],
              undefined,
              result.changes
            )
          : replaceActiveHistory(turns, `action:${operationDigest(action)}`);
      });
      return { matched };
    },
    async appendTurn(turn) {
      await withWrites(`append:${turn.id}`, () =>
        updateTurn(undefined, turn as SessionHistoryInput, `append:${turn.id}`)
      );
    },
    async replaceTurn(turnId, turn) {
      if (turn.id !== turnId) throw new Error(`Cannot change Roost turn id ${turnId}`);
      await withWrites(`replace:${turnId}`, async () => {
        const read = await readPrivateTurn(turnId);
        const before = read.state === 'ready' ? (read.turn as SessionHistoryInput) : undefined;
        if (!before) throw new Error(`Roost turn ${turnId} not found`);
        await updateTurn(before, turn as SessionHistoryInput, `replace:${turnId}`);
      });
    },
    async respondPermission(requestId, outcome, options) {
      const validated = parseHistoryWrite(PermissionOutcomeSchema, outcome);
      let matched = false;
      await withWrites(`permission:${requestId}`, async () => {
        let targetId = options?.turnId;
        if (!targetId) {
          targetId = (await readAll()).find(
            (entry) =>
              entry.role === 'assistant' &&
              entry.items?.some(
                (item) =>
                  item.type === 'tool_call' && item.permissionRequest?.requestId === requestId
              )
          )?.id;
        }
        const read = targetId ? await readPrivateTurn(targetId) : { state: 'missing' as const };
        if (read.state !== 'ready' || read.turn.role !== 'assistant') return false;
        const request = read.turn.items?.find(
          (item) =>
            record(item) &&
            item.type === 'tool_call' &&
            record(item.permissionRequest) &&
            item.permissionRequest.requestId === requestId
        );
        if (
          !record(request) ||
          !record(request.permissionRequest) ||
          request.permissionRequest.outcome !== undefined
        )
          return false;
        await roostHistory.commitHistoryBatch(
          `permission:${operationDigest([requestId, validated])}`,
          [
            {
              type: 'permission',
              requestId,
              assistantBusinessId: read.turn.id,
              outcome: encodeRoostContent(validated),
              parents: [],
            },
          ],
          { recovery: 'local' }
        );
        permissionCache.delete(requestId);
        await refreshTurnProjections([read.turn.id]);
        recordChange({ kind: 'changed', businessIds: [read.turn.id] });
        matched = true;
        return true;
      });
      return matched;
    },
    async replaceEditableTail(input): Promise<SessionEditableTailResult> {
      const operationId = `fork:${input.expectedUserTurnId}:${operationDigest(input.replacement)}`;
      let result: SessionEditableTailResult | undefined;
      let writeAttempted = false;
      try {
        await withWrites(operationId, async () => {
          const window =
            goalProjection === undefined
              ? { selected: await readAll(), start: 0 }
              : await readEditableWindow();
          const before = window.selected;
          const plan = planEditableTailReplacement(before as never, {
            ...input,
            fallbackGoal: goalProjection?.goal ?? input.fallbackGoal,
          });
          const localStart = plan.turns.length - 1;
          const start = window.start + localStart;
          const removed = before.slice(localStart);
          const replacement = prepareTurn(undefined, input.replacement as SessionHistoryInput);
          const previousHead = currentBranch().state.head;
          const primary = await roostHistory.lookup({
            kind: 'message',
            businessId: input.expectedUserTurnId,
            segmentId: 'primary',
          });
          const header =
            primary?.kind === 'found'
              ? await historyHost.readTurnHeader(primary.turn.turnId)
              : undefined;
          const parents = header?.kind === 'found' ? header.turn.parents : undefined;
          const reusePrefix =
            replacement.id !== input.expectedUserTurnId &&
            parents !== undefined &&
            parents.length === (start === 0 ? 0 : 1);
          const expectedCursor = operationCursor;
          if (expectedCursor === undefined) throw new Error('Roost write cursor is unavailable');
          writeAttempted = true;
          if (reusePrefix) {
            const branch = currentBranch();
            const accepted = await historyGeneration.fork(
              {
                viewId,
                expectedRevision: branch.state.revision,
                expectedHead: branch.state.head,
                operationId,
                baseTurn: parents[0]?.id ?? null,
                supersedes: removed.map((entry) => ({
                  kind: 'message',
                  businessId: entry.id,
                  segmentId: 'primary',
                })),
                input: {
                  kind: 'message',
                  businessId: replacement.id,
                  segmentId: 'primary',
                  parents,
                  content: encodeRoostContent(replacement),
                },
              },
              expectedCursor
            );
            roostHistory = historyGeneration.history;
            historyHost = historyGeneration.host;
            historyScope = historyGeneration.observationScope;
            if (replacement.finished === true) await finishIfNeeded(accepted.turnId);
            await reloadBranch({ publish: true });
            if (goalProjection && goalProjection.position >= start) goalProjection = undefined;
            rememberGoal(replacement, start);
          } else {
            const full = window.start === 0 ? before : await readAll();
            await replaceActiveHistory([...full.slice(0, start), replacement], operationId);
          }
          let rolledBack = false;
          result = {
            status: 'accepted',
            ...(plan.previousUserTurnId ? { previousUserTurnId: plan.previousUserTurnId } : {}),
            rollback: async () => {
              if (rolledBack) return;
              await withWrites(`${operationId}:rollback`, async () => {
                const current = await readAll();
                const index = current.findIndex((entry) => entry.id === replacement.id);
                if (
                  index !== start ||
                  !matchesRollbackReceipt(removed, [replacement], current.slice(index, index + 1))
                )
                  throw new HistoryWriteError([{ path: ['history'], code: 'rollback_conflict' }]);
                if (reusePrefix && current.length === index + 1) {
                  const branch = currentBranch();
                  const rollbackCursor = operationCursor;
                  if (rollbackCursor === undefined)
                    throw new Error('Roost write cursor is unavailable');
                  await historyGeneration.restore(
                    {
                      viewId,
                      expectedRevision: branch.state.revision,
                      expectedHead: branch.state.head,
                      restoreHead: previousHead,
                      operationId: `${operationId}:rollback`,
                    },
                    rollbackCursor
                  );
                  await reloadBranch({ publish: true });
                  goalProjection = projectLatestGoal([...current.slice(0, index), ...removed]);
                } else {
                  await replaceActiveHistory(
                    [...current.slice(0, index), ...removed, ...current.slice(index + 1)],
                    `${operationId}:rollback`,
                    [],
                    { storedCopy: true }
                  );
                }
                rolledBack = true;
                return true;
              });
            },
          };
          return true;
        });
        return (
          result ?? {
            status: 'indeterminate',
            cause: new Error('Roost tail replacement returned no result'),
          }
        );
      } catch (error) {
        if (writeAttempted) return { status: 'indeterminate', cause: error };
        if (error instanceof HistoryWriteError)
          return { status: 'rejected', reason: { code: 'invalid_input', issues: error.issues } };
        if (
          error instanceof Error &&
          'code' in error &&
          (error.code === 'active_goal' ||
            error.code === 'stale_boundary' ||
            error.code === 'invalid_input')
        )
          return { status: 'rejected', reason: { code: error.code } };
        return { status: 'indeterminate', cause: error };
      }
    },
    async applyHistoryImport(input) {
      let appended = 0;
      let writeAttempted = false;
      try {
        await withWrites(`history-import:${input.replay.replayDigest}`, async () => {
          const cursor =
            historyGeneration.externalHistoryCursor ??
            (await sessionDoc.getExternalHistoryCursor());
          const current = await readAll();
          const external = 'externalHistory' in input ? input.externalHistory : undefined;
          const hashVersion = external
            ? resolveImportHashVersion(external, cursor)
            : input.replay.hashVersion;
          const plan = planHistoryImport(
            input,
            current,
            cursor,
            current.map((entry) => hashHistoryEntryForVersion(entry, hashVersion)),
            current.some(isSessionHistoryPendingForDispatch)
          );
          const previous = new Map(current.map((entry) => [entry.id, entry]));
          const prepared = plan.turns.map((entry) =>
            prepareTurn(previous.get(entry.id), entry as SessionHistoryInput)
          );
          const nextCursor = createImportCursor(
            input.replay.turnHashes,
            prepared,
            input.replay.hashVersion
          );
          writeAttempted = true;
          await historyGeneration.replace(
            prepared,
            `history-import:${input.replay.replayDigest}`,
            operationCursor,
            { externalHistoryCursor: nextCursor }
          );
          appended = plan.appended;
          await reloadBranch({ publish: true });
          await sessionDoc.setExternalHistoryCursor(nextCursor);
          recordChange({
            kind: 'structure',
            from: 0,
            to: Math.max(current.length, prepared.length),
          });
          return true;
        });
        return { status: 'accepted', appended };
      } catch (error) {
        if (writeAttempted) return { status: 'indeterminate', cause: error };
        if (error instanceof HistoryWriteError)
          return { status: 'rejected', reason: { code: 'invalid_input', issues: error.issues } };
        if (
          error instanceof Error &&
          'code' in error &&
          typeof error.code === 'string' &&
          error.code !== 'stale'
        )
          return { status: 'rejected', reason: { code: error.code } };
        return { status: 'indeterminate', cause: error };
      }
    },
  };

  const snapshots: SessionSnapshotService = {
    capture: async () => captureStoredHistory(await readAll()),
    async copyFrom(snapshot, selection) {
      const operationId = `copy:${operationDigest(selection)}`;
      await withWrites(operationId, async () => {
        const current = await readAll();
        const values = prepareStoredHistoryCopy(
          snapshot,
          selection as SessionHistoryInput[],
          current
        );
        return replaceActiveHistory([...values, ...current], operationId, [], { storedCopy: true });
      });
    },
  };

  const agentWrites: SessionAgentWrites = {
    async setTurnField(turnId, key, change) {
      await withWrites(`field:${turnId}:${String(key)}`, async () => {
        const read = await readPrivateTurn(turnId);
        const before = read.state === 'ready' ? (read.turn as SessionHistoryInput) : undefined;
        if (!before) throw new Error(`Roost turn ${turnId} not found`);
        const next = { ...before } as Record<string, unknown>;
        if (change.kind === 'clear') delete next[key];
        else next[key] = clone(change.value);
        await updateTurn(before, next as SessionHistoryInput, `field:${turnId}:${String(key)}`);
      });
    },
    markTurnSeen(turnId) {
      const promise = withWrites(`seen:${turnId}`, async () => {
        const read = await readPrivateTurn(turnId);
        const before = read.state === 'ready' ? (read.turn as SessionHistoryInput) : undefined;
        if (!before || markTurnSeenBlocked(before as never)) return;
        const next = { ...before } as Record<string, unknown>;
        applyMarkTurnSeen(next);
        await updateTurn(before, next as SessionHistoryInput, `seen:${turnId}`);
      });
      pendingSeen.set(turnId, promise);
      void promise.then(
        () => pendingSeen.delete(turnId),
        (error) => {
          pendingSeen.delete(turnId);
          console.error(`Roost mark seen failed for ${viewId}/${turnId}`, error);
        }
      );
      return true;
    },
    async openAssistantTurn(input) {
      await withWrites(`open:${input.turnId}`, async () => {
        const read = await readPrivateTurn(input.turnId);
        const before = read.state === 'ready' ? (read.turn as SessionHistoryInput) : undefined;
        if (!before) {
          await updateTurn(
            undefined,
            createAssistantTurn(input) as SessionHistoryInput,
            `open:${input.turnId}`
          );
          return;
        }
        if (before.role !== 'assistant')
          throw new Error(`Roost turn ${input.turnId} is not assistant`);
        const next = { ...before } as Record<string, unknown>;
        applyOpenAssistantTurn(next, input);
        await updateTurn(before, next as SessionHistoryInput, `open:${input.turnId}`);
      });
    },
    async applyAgentBatch(input) {
      const notifications = input.notifications ?? [];
      const contents = input.contents ?? [];
      if (!notifications.length && !contents.length) return;
      const events = [
        ...notifications.map((value) => ({ kind: 'notification' as const, value })),
        ...contents.map((value) => ({ kind: 'content' as const, value })),
      ];
      if (
        input.operationIds &&
        (input.operationIds.length !== events.length ||
          new Set(input.operationIds).size !== events.length)
      )
        throw new HistoryWriteError([{ path: ['operationIds'], code: 'invalid_input' }]);
      const identified = events.map((event, index) => ({
        ...event,
        id: input.operationIds?.[index] ?? randomBytes(16).toString('hex'),
        digest: operationDigest([event, input.targetAssistantEntryId, input.model]),
      }));
      const operationId = `agent:${operationDigest(identified.map((event) => event.id))}`;
      const idempotent = {
        optimistic: Boolean(
          input.targetAssistantEntryId &&
          (positionById.has(input.targetAssistantEntryId) ||
            pageEntries.has(input.targetAssistantEntryId))
        ),
      };
      await withWrites(
        operationId,
        async () => {
          // Each small chunk owns its output and per-item receipts in one native
          // transaction. A retry can safely overlap an earlier committed chunk.
          let anyChanged = false;
          for (let offset = 0; offset < identified.length; offset += 30) {
            const pending: typeof identified = [];
            const receipts: HistoryBatchCommand[] = [];
            let recovered = false;
            for (const event of identified.slice(offset, offset + 30)) {
              const identity = {
                kind: 'publication' as const,
                businessId: viewId,
                segmentId: `agent:${operationDigest(event.id)}`,
              };
              const prior = idempotent.optimistic
                ? undefined
                : await historyGeneration.lookupOperation(identity);
              if (prior !== undefined) {
                if (!record(prior) || prior.digest !== event.digest)
                  throw new Error('Agent operation identity conflict');
                recovered = true;
                continue;
              }
              pending.push(event);
              receipts.push({
                type: 'accept',
                identity,
                parents: [],
                content: encodeRoostContent({ digest: event.digest }),
              });
            }
            if (recovered) {
              await reloadBranch({ publish: true });
              anyChanged = true;
            }
            if (!pending.length) continue;
            const position = input.targetAssistantEntryId
              ? positionById.get(input.targetAssistantEntryId)
              : undefined;
            const cached =
              position !== undefined
                ? entries[position]
                : input.targetAssistantEntryId
                  ? pageEntries.get(input.targetAssistantEntryId)?.turn
                  : undefined;
            const selected = cached
              ? { state: 'ready' as const, turn: cached }
              : input.targetAssistantEntryId
                ? await readPrivateTurn(input.targetAssistantEntryId)
                : undefined;
            const before = input.targetAssistantEntryId
              ? selected?.state === 'ready' && selected.turn.role === 'assistant'
                ? [selected.turn as SessionHistoryInput]
                : []
              : await readAll();
            const planned = planAgentHistoryMutation(before, pending, input.model, {
              ...(input.createId ? { createId: input.createId } : {}),
              ...(input.now ? { now: input.now } : {}),
              ...(input.targetAssistantEntryId
                ? { targetAssistantEntryId: input.targetAssistantEntryId }
                : {}),
            });
            const next = planned.history;
            if (
              next.length === before.length &&
              next.every((entry, index) => entry.id === before[index]?.id)
            ) {
              await commitTurnChanges(
                before,
                next,
                operationId,
                receipts,
                planned.textAppends,
                planned.changes
              );
            } else {
              const all = await readAll();
              const changed = new Map(next.map((entry) => [entry.id, entry]));
              const combined = all.map((entry) => changed.get(entry.id) ?? entry);
              for (const entry of next)
                if (!all.some((old) => old.id === entry.id)) combined.push(entry);
              await replaceActiveHistory(combined, operationId, receipts);
            }
            anyChanged = true;
            // An applied SDK checkpoint certifies this command's exact interval.
            // Later commits arrive through the independent Native wake channel.
            operationCursor =
              historyGeneration.settledWriteCursor() ?? (await roostHistory.observedEventCursor());
          }
          return anyChanged;
        },
        idempotent
      );
    },
  };

  const inputIdentity = (entry: SessionTurn) => {
    const prepared = prepareTurn(undefined, entry as SessionHistoryInput);
    if (prepared.role !== 'user' || !prepared.userId?.trim()) {
      throw new HistoryWriteError([{ path: ['role'], code: 'invalid_user_input' }]);
    }
    return {
      viewId,
      operationId: `input:${prepared.id}`,
      input: {
        kind: 'message' as const,
        businessId: prepared.id,
        segmentId: 'primary',
        content: encodeRoostContent(prepared),
      },
    };
  };
  const inputIsActive = async (turnId: string): Promise<boolean> => {
    const read = await history.readTurn(turnId);
    if (read.state === 'ready') return true;
    if (read.state === 'missing') return false;
    throw new Error('Accepted Roost input history is not readable');
  };
  const acceptInput = async (
    entry: SessionTurn,
    dispatch = false
  ): Promise<SessionInputAcceptanceResult> => {
    const identity = inputIdentity(entry);
    await withWrites(
      identity.operationId,
      async () => {
        // Receipt identity is checked before authoring trusted human provenance.
        const prior = await historyGeneration.lookupInputAcceptance(identity);
        let created = false;
        if (dispatch && prior) {
          const current = await readPrivateTurn(entry.id);
          if (
            current.state === 'missing' ||
            (current.state === 'ready' && !isSessionHistoryStatusAwaitingStart(current.turn.status))
          )
            return false;
          if (current.state !== 'ready')
            throw new Error('Accepted Roost input history is not readable');
        }
        if (dispatch) {
          const userId = entry.userId?.trim();
          if (!userId)
            throw new HistoryWriteError([{ path: ['userId'], code: 'invalid_user_input' }]);
          const existing = (await sessionDoc.getDocState())?.humanInputReceipts?.[entry.id];
          if (existing && existing.userId !== userId)
            throw new HistoryWriteError([{ path: ['userId'], code: 'input_identity_conflict' }]);
          sessionDoc.recordHumanInputReceipt(entry.id, userId);
        }
        if (!prior) {
          const branch = await ensureHeadSealed();
          const accepted = await roostHistory.acceptInputToView({
            ...identity,
            expectedRevision: branch.state.revision,
            expectedHead: branch.state.head,
            input: { ...identity.input, parents: await parentForHead(branch) },
          });
          created = accepted.created;
          await refreshProjectedMessage(accepted.turnId, accepted);
          if (entry.finished === true) await finishIfNeeded(accepted.turnId);
        }
        if (dispatch) {
          const current = await readPrivateTurn(entry.id);
          if (current.state !== 'ready' && current.state !== 'missing')
            throw new Error('Accepted Roost input history is not readable');
          if (
            current.state === 'ready' &&
            isSessionHistoryStatusAwaitingStart(current.turn.status)
          ) {
            const latest = await readLatestTurn(history, 'user');
            const meta = await sessionDoc.getMetaState();
            if (
              meta &&
              !meta.isArchived &&
              meta.lastMissingHistoryUserMsgId !== entry.id &&
              meta.lastHandledUserMsgId !== entry.id
            ) {
              // The existing writer queue orders this check and activation with
              // every competing accept. A recovered older input cannot move it back.
              if (latest?.id === entry.id && meta.latestUserMsgId !== entry.id)
                await sessionDoc.publishUserTurnActivation(entry.id);
            }
          }
        }
        return created;
      },
      { optimistic: false }
    );
    return { status: 'accepted', turnId: entry.id, active: await inputIsActive(entry.id) };
  };
  const inputAcceptance: import('@lody/shared/session-data').SessionInputAcceptance = {
    async lookup(entry) {
      const identity = inputIdentity(entry);
      await writeSerial;
      await historyGeneration.resolve();
      const prior = await historyGeneration.lookupInputAcceptance(identity);
      return prior
        ? {
            status: 'accepted',
            turnId: entry.id,
            active: await inputIsActive(entry.id),
          }
        : { status: 'unobserved' };
    },
    accept: (entry) => acceptInput(entry),
    acceptAndDispatch: (entry) => acceptInput(entry, true),
  };

  const sessionData: RoostSessionData = createRoostSessionData({
    inputAcceptance,
    sessionId: sessionDoc.sessionId,
    history,
    commands,
    snapshots,
    dispose: () => undefined,
  });

  const flushHistoryWrites = async (): Promise<void> => {
    await writeSerial;
    await Promise.all([...pendingSeen.values()]);
    if (needsRefresh || pendingChange || pendingModelSummary) {
      // Recover the projection of an already committed mutation, never replay
      // the failed action. RPC reads bind it to the durable Native publication.
      await withWrites(`projection-recovery:${randomBytes(8).toString('hex')}`, async () => false);
    }
  };

  // Admission follows registration. Its fresh bootstrap hint checks the gap
  // after the private initial load; no consumer checkpoint has been exposed yet.
  refreshCommitSubscription();
  return {
    sessionData,
    readLatestGoal,
    readDispatchHistory: async (ids) => (await readDispatch(ids)).history,
    readDispatchSelection: readDispatch,
    agentWrites,
    setPlan: async (planEntries: readonly SessionPlanEntry[]) => {
      if (!latestAssistantId) return;
      await agentWrites.setTurnField(latestAssistantId, 'plan', {
        kind: 'set',
        value: planEntries,
      });
    },
    initialize: async () => undefined,
    flushLocalWrites: flushHistoryWrites,
    // This owner is local SQLite today. The backend-level barrier combines
    // this local durability with the Loro control-plane sync barrier; it does
    // not claim that Roost history has reached a remote service.
    waitUntilSynced: async () => {
      await flushHistoryWrites();
      return true;
    },
    dispose: async () => {
      closing = true;
      for (const wake of checkpointObservers) wake();
      unsubscribeCommits();
      try {
        await Promise.allSettled([...pendingSeen.values()]);
        await writeSerial;
      } finally {
        disposed = true;
        branchCursors.clear();
        pageEntries.clear();
        pageIdsByPosition.clear();
        await lease.release();
      }
    },
  } satisfies RoostSessionBackendServices;
};

const createNodeServices = async (
  sessionDoc: SessionDocument,
  ownerOptions: RoostNativeOptions = {}
) => {
  let lease: OwnerLease | undefined;
  try {
    if (sessionDoc.handle?.doc.getByPath('roostHistoryCursor/cursor') !== undefined)
      throw new Error('Unsupported Roost control publication format; create a new test session');
    lease = await acquireOwner(ownerOptions);
    return await createNodeServicesForLease(sessionDoc, lease);
  } catch (error) {
    reportRoostHistoryFailure(error, { stage: 'initialize', sessionId: sessionDoc.sessionId });
    await lease?.release().catch(() => undefined);
    throw error;
  }
};

let installed = false;

/** Install the local Node owner adapter once for the daemon process. */
export function installRoostNodeSessionBackend(options: RoostNativeOptions = {}): void {
  if (installed) return;
  registerSessionBackendFactory(
    'roost',
    createRoostSessionBackendFactory((sessionDoc) => createNodeServices(sessionDoc, options))
  );
  installed = true;
}

export type { RoostNativeOptions };
