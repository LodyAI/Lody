import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { readRoostHistoryPatches } from './roost-history-patches';
import { readRoostSelectedEntries, roostTranscriptShape } from './roost-selected-fields';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Effect, Semaphore } from 'effect';
import {
  planAgentHistoryMutation,
  targetLocalHistoryTargets,
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
  createReplayPromptBuilder,
  type SessionHistoryInspectionQuery,
  type SessionHistoryReadResponse,
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
  selectHistoryActionRows,
  selectAgentHistoryRows,
  type HistoryQueryRow,
  selectTranscriptHistoryPositions,
  ROOST_CLEAR_FIELDS_KEY,
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
  inspectHistoryEntry,
  type RoostDispatchRow,
  type RoostDispatchUpdate,
  type RoostDispatchCheckpoint,
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
  if (
    !historyHost.fieldReads ||
    !historyHost.exclusiveBatches ||
    typeof historyGeneration.history.readActiveBranchMembers !== 'function' ||
    typeof historyGeneration.history.replaceActiveBranchMembers !== 'function'
  )
    throw new Error(
      'Roost selective history requires matching field-reads-v1 and exclusive-batch-v1 SDK/Native builds'
    );
  let historyScope = historyGeneration.observationScope;
  let roostHistory = historyGeneration.history;
  await roostHistory.catchUpIndex();
  await roostHistory.recoverPendingBatches();

  const viewId = sessionDoc.sessionId;
  let disposed = false;
  let closing = false;
  let loadedSegments: RoostHistorySegment[] = [];
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
      const row = loadedSegments.find(
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
        const row = loadedSegments.find(
          (candidate) => identityKey(candidate) === identityKey(message)
        );
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
    const previous = loadedSegments;
    const previousStart = loadedStartPosition;
    activeBranch = branch;
    windowHistory = roostHistory;
    loadedStartPosition = branch.startPosition;
    totalHistoryCount = branch.totalCount;
    loadedSegments = decoded.map((row) => ({ ...row }));
    rebuildSegmentIndexes(branch.messages);
    rebuildLogicalProjection(projected);
    readGeneration += 1;
    pageEntries.clear();
    pageIdsByPosition.clear();
    fullEntriesCache = undefined;
    if (notify && previous.length > 0) {
      const change = changeBetween(previous, loadedSegments);
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
    const previous = loadedSegments;
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
            [...loadedSegments.slice(retainedFrom), segment]
          );
          rememberDispatch({
            after: dispatchEntry(projected[0]!),
            inspection: inspectHistoryEntry(projected[0]!),
            position: advance.totalCount - 1,
            segments: [
              {
                turnId: bytesHex(message.turnId),
                segmentId: message.segmentId,
                ...(message.physicalSegmentId
                  ? { physicalSegmentId: message.physicalSegmentId }
                  : {}),
              },
            ],
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
        loadedSegments = loadedSegments.map((row) =>
          identityKey(row) === identityKey(fresh) ? segment : row
        );
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
  const readCertifiedGoal = async (cursor: bigint, count: number) => {
    let latest =
      operationCursor === undefined && cursor === knownCursor ? goalProjection : undefined;
    if (latest === undefined)
      latest = await readGoalProjection(historyHost, cursor, count).catch(() => undefined);
    return latest;
  };
  const readGoalAtInspection: InspectionQuery<SessionGoalMessage | null> = async (
    index,
    checkpoint,
    source
  ) => {
    const cursor = BigInt(checkpoint.header.cursor);
    let latest = await readCertifiedGoal(cursor, checkpoint.header.count);
    if (latest === undefined) {
      latest = null;
      for (let end = checkpoint.header.count; end > 0; end -= 500) {
        const rows = await index.range(checkpoint, Math.max(0, end - 500), end);
        for (let position = rows.length - 1; position >= 0; position--) {
          const row = rows[position]!;
          if (!projectLatestGoal([{ id: row.entry.id, items: index.inspection(row).goals }]))
            continue;
          const complete = await readIndexedEntries(source, [row]);
          latest = projectLatestGoal(complete, row.position);
          if (latest) break;
        }
        if (latest) break;
      }
    }
    if (operationCursor === undefined && cursor === knownCursor) {
      goalProjection = latest;
      goalCoveredStart = latest?.position ?? 0;
    }
    return latest ? clone(latest.goal) : null;
  };
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
    dispatchRows: readonly {
      entry: Pick<SessionDispatchEntry, 'id'>;
      segments: RoostDispatchRow['segments'];
    }[]
  ): Promise<SessionEntry[]> => {
    const physical = dispatchRows.flatMap((row) =>
      row.segments.map((segment) => ({ ...segment, businessId: row.entry.id }))
    );
    const messages = await source.readActiveBranchMessages(
      viewId,
      dispatchRows.map((row) => row.entry.id)
    );
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
  const readMetadataPage = async (
    input: Parameters<NodeLodyHistory['readActiveBranchMembers']>[1]
  ) => {
    const source = roostHistory,
      host = historyHost,
      generation = readGeneration;
    const cursor = await source.observedEventCursor();
    const page = await source.readActiveBranchMembers(viewId, input);
    if (!page.complete) throw new Error('Roost active branch directory is incomplete');
    const selected = await readRoostSelectedEntries(host, source, page.members);
    await historyGeneration.resolve();
    if (
      source !== historyGeneration.history ||
      host !== historyGeneration.host ||
      generation !== readGeneration ||
      cursor !== (await source.observedEventCursor())
    ) {
      needsRefresh = true;
      throw staleRead();
    }
    return directoryPageFromBranch({ ...page, messages: [] }, selected);
  };
  const readLatestDirectoryPage = (limit: number): Promise<SessionHistoryDirectoryPage> =>
    onOwner(() =>
      readStable(async () =>
        limit === branchPageSize
          ? directoryPageFromBranch(currentBranch(), entries)
          : readMetadataPage({ latest: true, limit })
      )
    );
  const readBodyRange = (from: number, to: number): Promise<SessionEntry[]> =>
    onOwner(() =>
      readStable(async () => {
        const source = roostHistory,
          host = historyHost,
          generation = readGeneration;
        const cursor = await source.observedEventCursor();
        const start = Math.max(0, Math.min(from, totalHistoryCount)),
          end = Math.max(start, Math.min(to, totalHistoryCount));
        const index = dispatchIndex(),
          checkpoint = await index.checkpoint(cursor, totalHistoryCount);
        const result: SessionEntry[] = [];
        if (
          cursor === knownCursor &&
          start >= loadedStartPosition &&
          end <= loadedStartPosition + entries.length
        ) {
          return entries
            .slice(start - loadedStartPosition, end - loadedStartPosition)
            .map((entry) => clone(entry));
        }
        let useIndex = Boolean(checkpoint);
        for (let position = start; position < end; position += 500) {
          const stop = Math.min(end, position + 500);
          let selected: SessionEntry[] | undefined;
          if (useIndex && checkpoint)
            try {
              selected = await readIndexedEntries(
                source,
                await index.range(checkpoint, position, stop)
              );
            } catch (error) {
              if (
                !(error instanceof z.ZodError) &&
                !(error instanceof SyntaxError) &&
                !(error instanceof RoostDispatchIndexCorrupt)
              )
                throw error;
              index.forget();
              useIndex = false;
            }
          if (!selected) {
            const page = await source.readActiveBranchPage(viewId, {
              from: position,
              limit: stop - position,
            });
            if (page.totalCount !== totalHistoryCount) {
              needsRefresh = true;
              throw staleRead();
            }
            if (!page.complete || page.startPosition !== position)
              throw new Error('Roost requested history range is incomplete');
            selected = await projectBranchPage(page, decodeMessages(page.messages), false);
            if (selected.length !== stop - position)
              throw new Error('Roost requested history range is incomplete');
          }
          result.push(...selected);
        }
        if (useIndex && checkpoint) await index.validate(checkpoint);
        await historyGeneration.resolve();
        if (
          source !== historyGeneration.history ||
          host !== historyGeneration.host ||
          generation !== readGeneration ||
          cursor !== (await source.observedEventCursor())
        ) {
          needsRefresh = true;
          throw staleRead();
        }
        rememberPageEntries(start, result);
        return result;
      })
    );
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
    readAt: async (position) => {
      const [entry] = await readBodyRange(position, position + 1);
      return entry ? readyTurn(entry) : { state: 'missing' };
    },
    readTurn: (turnId) =>
      readStable(async () => {
        const source = roostHistory,
          host = historyHost,
          generation = readGeneration;
        const cursor = await source.observedEventCursor();
        const position = positionById.get(turnId);
        const cached = position === undefined ? pageEntries.get(turnId)?.turn : entries[position];
        if (cached && cursor === knownCursor) return readyTurn(cached);
        const messages = await source.readActiveBranchMessages(viewId, [turnId]);
        const [entry] = await projectMessages(messages);
        await historyGeneration.resolve();
        if (
          source !== historyGeneration.history ||
          host !== historyGeneration.host ||
          generation !== readGeneration ||
          cursor !== (await source.observedEventCursor())
        ) {
          needsRefresh = true;
          throw staleRead();
        }
        return entry ? readyTurn(entry) : { state: 'missing' as const };
      }),
    readRange: async (from, to) => (await readBodyRange(from, to)).map(readyTurn),
    readDirectory: (from, to) =>
      inspectHistory(async (index, checkpoint) => {
        const start = Math.max(0, Math.min(from, checkpoint.header.count));
        const end = Math.max(start, Math.min(to, checkpoint.header.count));
        const result: SessionDirectoryRow[] = [];
        for (let position = start; position < end; position += 500) {
          for (const row of await index.range(
            checkpoint,
            position,
            Math.min(end, position + 500)
          )) {
            const fields = index.inspection(row);
            result.push({
              metadataVersion: 1,
              position: row.position,
              state: 'ready',
              turnId: row.entry.id,
              scalars: fields.scalars,
              ...(row.entry.role === 'user' ? { inputConfig: fields.inputConfig } : {}),
              ...(fields.itemCount !== undefined ? { itemCount: fields.itemCount } : {}),
              ...(fields.planCount !== undefined ? { planCount: fields.planCount } : {}),
              ...(fields.userId !== undefined ? { userId: fields.userId } : {}),
              ...(fields.scheduleRun !== undefined ? { scheduleRun: fields.scheduleRun } : {}),
            });
          }
        }
        return result;
      }),
    readLatestDirectoryPage,
    readOlderDirectoryPage: (cursor, limit) =>
      onOwner(() =>
        readStable(async () => {
          const decoded = branchCursors.get(cursor);
          if (!decoded) throw new Error('Roost history page cursor is stale or unknown');
          return readMetadataPage({ before: decoded, limit });
        })
      ),
    readAll: async () => (await readCompleteEntries()).map((entry) => clone(entry)),
    readTurnOutput: (userTurnId) =>
      inspectHistory(async (index, checkpoint, source) => {
        const user = await index.row(userTurnId, checkpoint);
        if (!user || user.entry.role !== 'user') return [];
        const selected = [
          user,
          ...(await index.owners(checkpoint, 'output', userTurnId, user.position + 1, 1)),
          ...(user.entry.status === 'failed'
            ? await index.owners(checkpoint, 'system', '', user.position + 1)
            : []),
        ].sort((left, right) => left.position - right.position);
        const bodies = new Map(
          (
            await readIndexedEntries(
              source,
              selected.filter((row) => row !== user)
            )
          ).map((entry) => [entry.id, entry])
        );
        return selectTurnOutput(
          selected.length,
          userTurnId,
          (position) => index.inspection(selected[position]!).scalars,
          (position) => bodies.get(selected[position]!.entry.id)
        );
      }),
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
    const generation = readGeneration;
    const pages = async function* (): AsyncGenerator<readonly RoostDispatchRow[]> {
      let page = await source.readActiveBranchMembers(viewId, {
        latest: true,
        limit: branchPageSize,
      });
      const revision = page.state.revision;
      let end = count;
      const seen = new Set<string>();
      for (;;) {
        if (closing || disposed) throw new Error('Roost session backend is disposed');
        if (!page.complete || page.totalCount !== count || page.state.revision !== revision)
          throw staleRead();
        const projected = await readRoostSelectedEntries(host, source, page.members);
        if (page.startPosition + projected.length !== end) throw staleRead();
        const selected = projected.map((entry, offset): RoostDispatchRow => {
          if (seen.has(entry.id)) throw staleRead();
          seen.add(entry.id);
          return {
            position: page.startPosition + offset,
            entry: dispatchEntry(entry),
            inspection: inspectHistoryEntry(entry),
            segments: page.members
              .filter((message) => message.businessId === entry.id)
              .map((message) => ({
                turnId: bytesHex(message.turnId),
                segmentId: message.segmentId,
                ...(message.physicalSegmentId
                  ? { physicalSegmentId: message.physicalSegmentId }
                  : {}),
              })),
          };
        });
        yield selected;
        end = page.startPosition;
        if (end === 0) break;
        if (!page.cursor) throw staleRead();
        page = await source.readActiveBranchMembers(viewId, {
          before: page.cursor,
          limit: branchPageSize,
        });
      }
    };
    await index.rebuild(cursor, count, pages(), async () => {
      await historyGeneration.resolve();
      if (
        source !== historyGeneration.history ||
        host !== historyGeneration.host ||
        generation !== readGeneration ||
        cursor !== (await source.observedEventCursor())
      ) {
        needsRefresh = true;
        throw staleRead();
      }
    });
  };

  const inspectionCheckpoint = async (index: RoostDispatchIndex, cursor: bigint) => {
    let checkpoint = await index.checkpoint(cursor, totalHistoryCount);
    if (checkpoint?.header.inspectionVersion !== 1) {
      await rebuildDispatchIndex(index, cursor);
      checkpoint = await index.checkpoint(cursor, totalHistoryCount);
    }
    if (!checkpoint || checkpoint.header.inspectionVersion !== 1) throw staleRead();
    return checkpoint;
  };
  const validateInspection = async (
    index: RoostDispatchIndex,
    checkpoint: RoostDispatchCheckpoint,
    source: NodeLodyHistory,
    host: RoostNodeStream,
    generation: number
  ) => {
    await index.validate(checkpoint);
    await historyGeneration.resolve();
    if (
      source !== historyGeneration.history ||
      host !== historyGeneration.host ||
      generation !== readGeneration ||
      checkpoint.header.cursor !== (await source.observedEventCursor()).toString()
    ) {
      needsRefresh = true;
      throw staleRead();
    }
  };
  type InspectionQuery<T> = (
    index: RoostDispatchIndex,
    checkpoint: RoostDispatchCheckpoint,
    source: NodeLodyHistory
  ) => Promise<T>;
  const inspectAtCursor = async <T>(cursor: bigint, query: InspectionQuery<T>): Promise<T> => {
    if (knownCursor !== cursor) await reloadBranch({ publish: true });
    const source = roostHistory,
      host = historyHost,
      generation = readGeneration;
    const index = dispatchIndex();
    let checkpoint = await inspectionCheckpoint(index, cursor);
    let result: T;
    try {
      result = await query(index, checkpoint, source);
    } catch (error) {
      if (
        !(error instanceof z.ZodError) &&
        !(error instanceof SyntaxError) &&
        !(error instanceof RoostDispatchIndexCorrupt)
      )
        throw error;
      await rebuildDispatchIndex(index, cursor);
      checkpoint = await inspectionCheckpoint(index, cursor);
      result = await query(index, checkpoint, source);
    }
    await validateInspection(index, checkpoint, source, host, generation);
    return result;
  };
  const onOwner = <T>(query: () => Promise<T>): Promise<T> => {
    const next = writeSerial.then(query);
    writeSerial = next.then(
      () => {},
      () => {}
    );
    return next;
  };
  const inspectHistory = <T>(query: InspectionQuery<T>): Promise<T> =>
    onOwner(() =>
      readStable(async () => inspectAtCursor(await roostHistory.observedEventCursor(), query))
    );
  const inspectionRows = async (
    index: RoostDispatchIndex,
    checkpoint: RoostDispatchCheckpoint,
    options?: { from?: number; to?: number }
  ) => {
    const from = Math.max(0, Math.min(options?.from ?? 0, checkpoint.header.count));
    const end = Math.max(
      from,
      Math.min(options?.to ?? checkpoint.header.count, checkpoint.header.count)
    );
    const rows: RoostDispatchRow[] = [];
    for (let start = from; start < end; start += 500)
      rows.push(...(await index.range(checkpoint, start, Math.min(end, start + 500))));
    return rows;
  };
  const inspectionToken = (rows: readonly HistoryQueryRow[]) =>
    createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  const readGoalDirect = async () => {
    const cursor = await roostHistory.observedEventCursor();
    if (cursor !== knownCursor) {
      needsRefresh = true;
      throw staleRead();
    }
    const latest = await readCertifiedGoal(cursor, totalHistoryCount);
    if (latest === undefined) return inspectAtCursor(cursor, readGoalAtInspection);
    goalProjection = latest;
    goalCoveredStart = latest?.position ?? 0;
    return latest ? clone(latest.goal) : null;
  };
  const foldMemberHistory = async <T>(
    source: NodeLodyHistory,
    create: () => T,
    visit: (state: T, entry: SessionHistoryInput) => void,
    excludeTurnId?: string
  ): Promise<T> => {
    const count = totalHistoryCount,
      revision = currentBranch().state.revision;
    const state = create();
    for (let from = 0; from < count; from += 500) {
      if (closing || disposed) throw new Error('Roost session backend is disposed');
      const page = await source.readActiveBranchMembers(viewId, { from, limit: 500 });
      if (
        !page.complete ||
        page.startPosition !== from ||
        page.totalCount !== count ||
        page.state.revision !== revision
      ) {
        needsRefresh = true;
        throw staleRead();
      }
      const grouped = new Map<string, RoostDispatchRow['segments']>();
      for (const member of page.members) {
        let segments = grouped.get(member.businessId);
        if (!segments) {
          segments = [];
          grouped.set(member.businessId, segments);
        }
        segments.push({
          turnId: bytesHex(member.turnId),
          segmentId: member.segmentId,
          ...(member.physicalSegmentId ? { physicalSegmentId: member.physicalSegmentId } : {}),
        });
      }
      if (grouped.size !== Math.min(500, count - from)) throw staleRead();
      for (const [id, segments] of grouped) {
        if (closing || disposed) throw new Error('Roost session backend is disposed');
        if (id === excludeTurnId) continue;
        const [entry] = await readIndexedEntries(source, [{ entry: { id }, segments }]);
        if (closing || disposed) throw new Error('Roost session backend is disposed');
        if (!entry) throw new Error('Roost replay member is unavailable');
        visit(state, entry as SessionHistoryInput);
      }
    }
    return state;
  };
  const readReplayFromMembers = async (source: NodeLodyHistory, excludeTurnId?: string) =>
    (
      await foldMemberHistory(
        source,
        () => createReplayPromptBuilder({ excludeTurnId }),
        (builder, entry) => builder.add(entry),
        excludeTurnId
      )
    ).finish();
  const readObservedHistory = <T>(read: () => Promise<T>) =>
    onOwner(() =>
      readStable(async () => {
        const source = roostHistory,
          host = historyHost,
          generation = readGeneration,
          cursor = await source.observedEventCursor();
        if (cursor !== knownCursor) {
          needsRefresh = true;
          throw staleRead();
        }
        const result = await read();
        await historyGeneration.resolve();
        if (
          source !== historyGeneration.history ||
          host !== historyGeneration.host ||
          generation !== readGeneration ||
          cursor !== (await source.observedEventCursor())
        ) {
          needsRefresh = true;
          throw staleRead();
        }
        return result;
      })
    );
  const readLatestGoal = () => readObservedHistory(readGoalDirect);
  const readLatestUserId = () =>
    inspectHistory(async (index, checkpoint) => {
      for (let end = checkpoint.header.count; end > 0; end -= 500) {
        const rows = await index.range(checkpoint, Math.max(0, end - 500), end);
        for (let position = rows.length - 1; position >= 0; position--) {
          const row = rows[position]!;
          if (row.entry.role !== 'user') continue;
          const userId = index.inspection(row).userId;
          if (userId?.trim()) return userId;
        }
      }
      return undefined;
    });

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
          checkpoint = repaired;
          result = await index.read(repaired, requested);
        }
        const turnId = select?.(result);
        const selected = turnId === undefined ? undefined : await index.row(turnId, checkpoint);
        const [body] = selected ? await readIndexedEntries(roostHistory, [selected]) : [];
        const turn =
          turnId === undefined ? undefined : body ? readyTurn(body) : { state: 'missing' as const };
        await index.validate(checkpoint);
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
        ? operationCursor !== undefined
          ? await readPrivateTurn(latestModelTurnId)
          : await history.readTurn(latestModelTurnId)
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
      ) ??
      (await roostHistory.readActiveBranchMessages(viewId, [after.id])).find(
        (row) => row.segmentId === 'primary'
      );
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
    const identity = {
      kind: 'message' as const,
      businessId: after.id,
      segmentId: primary.physicalSegmentId ?? 'primary',
    };
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
    const retainedRows = new Map(
      branch.messages.map((message, index) => [message, loadedSegments[index]])
    );
    const primaryIds = branch.messages
      .filter((row) => row.segmentId === 'primary' && ids.has(row.businessId))
      .map((row) => row.turnId);
    const fresh = staged
      ? primaryIds.map((id) => staged.get(bytesHex(id))!.message)
      : (
          await roostHistory.readActiveBranchMessages(viewId, [
            ...new Set(
              branch.messages
                .filter((row) => row.segmentId === 'primary' && ids.has(row.businessId))
                .map((row) => row.businessId)
            ),
          ])
        ).filter((row) => primaryIds.some((id) => bytesHex(id) === bytesHex(row.turnId)));
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
    loadedSegments = messages.map(
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

  const querySnapshot = (cursor = operationCursor!) =>
    inspectAtCursor(cursor, async (index, checkpoint) => {
      const rows: RoostDispatchRow[] = [];
      for (let from = 0; from < checkpoint.header.count; from += 500)
        rows.push(
          ...(await index.range(checkpoint, from, Math.min(checkpoint.header.count, from + 500)))
        );
      return {
        cursor,
        rows,
        query: rows.map((row) => index.inspection(row).query as HistoryQueryRow),
      };
    });
  const historyQueryRows = async (
    rows: readonly RoostDispatchRow[],
    index: RoostDispatchIndex,
    source: NodeLodyHistory,
    visibility?: boolean
  ): Promise<HistoryQueryRow[]> => {
    if (!visibility) return rows.map((row) => index.inspection(row).query as HistoryQueryRow);
    const checkpoint = index.current();
    if (!checkpoint) throw staleRead();
    const cached = await index
      .readTranscriptItems(checkpoint, rows)
      .catch(() => rows.map(() => undefined));
    const missing = rows.filter((_row, position) => cached[position] === undefined);
    const refreshed = new Map<string, HistoryQueryRow>();
    for (let from = 0; from < missing.length; from += 40) {
      const page = missing.slice(from, from + 40);
      const members = page.flatMap((row) =>
        row.segments.map((segment) => ({
          ...segment,
          businessId: row.entry.id,
          turnId: Buffer.from(segment.turnId, 'hex'),
        }))
      );
      const selected = await readRoostSelectedEntries(
        historyHost,
        source,
        members,
        roostTranscriptShape
      );
      for (const entry of selected)
        refreshed.set(entry.id, inspectHistoryEntry(entry, true).query as HistoryQueryRow);
    }
    await index
      .rememberTranscriptItems(
        checkpoint,
        [...refreshed].map(([id, row]) => ({ id, items: row.items ?? [] }))
      )
      .catch(() => {});
    return rows.map((row, position) => {
      const query = refreshed.get(row.entry.id);
      if (query) return query;
      const items = cached[position];
      if (!items) throw staleRead();
      return { ...index.inspection(row).query, items } as HistoryQueryRow;
    });
  };
  type QuerySnapshot = Awaited<ReturnType<typeof querySnapshot>>;
  const commitSparseHistory = async (
    snapshot: QuerySnapshot,
    next: readonly SessionHistoryInput[],
    bodies: ReadonlyMap<string, SessionHistoryInput>,
    operationId: string,
    extra: readonly HistoryBatchCommand[] = [],
    storedCopy = false
  ): Promise<boolean> => {
    const branch = currentBranch();
    const observationScope = historyGeneration.observationScope;
    if (snapshot.cursor !== operationCursor) throw staleRead();
    const preparedById = new Map<string, SessionHistoryInput>();
    const membershipOperation = `${operationId}:membership:${operationDigest([branch.state.revision.toString(), branch.state.head])}`;
    const oldById = new Map(
      snapshot.rows.map((row, index) => [row.entry.id, { row, query: snapshot.query[index]! }])
    );
    const ids = new Set<string>();
    const members: Parameters<NodeLodyHistory['replaceActiveBranchMembers']>[0]['members'] = [];
    const messages: NonNullable<
      Parameters<NodeLodyHistory['replaceActiveBranchMembers']>[0]['messages']
    > = [];
    for (const entry of next) {
      if (ids.has(entry.id))
        throw new HistoryWriteError([{ path: ['history'], code: 'duplicate_id' }]);
      ids.add(entry.id);
      const old = oldById.get(entry.id);
      const before = bodies.get(entry.id);
      if (old && equal(before ?? old.query, entry)) {
        members.push(
          ...old.row.segments.map((segment) => ({
            identity: {
              kind: 'message' as const,
              businessId: entry.id,
              segmentId: segment.physicalSegmentId ?? segment.segmentId,
            },
            segmentId: segment.segmentId,
          }))
        );
        continue;
      }
      if (old && !before)
        throw new HistoryWriteError([{ path: ['history'], code: 'unselected_change' }]);
      const prepared = storedCopy ? entry : prepareTurn(before, entry);
      const identity = {
        kind: 'message' as const,
        businessId: entry.id,
        segmentId: `primary:${operationDigest([membershipOperation, prepared])}`,
      };
      preparedById.set(entry.id, prepared);
      messages.push({ identity, content: encodeRoostContent(prepared) });
      members.push({ identity, segmentId: 'primary' });
    }
    if (
      !messages.length &&
      !extra.length &&
      snapshot.rows.length === next.length &&
      snapshot.rows.every((row, i) => row.entry.id === next[i]?.id)
    )
      return false;
    const receipts = extra.map((command) => {
      if (command.type !== 'accept') throw new Error('Unsupported sparse history receipt');
      return command;
    });
    const activation = await historyGeneration.replaceMembers(
      {
        viewId,
        expectedRevision: branch.state.revision,
        expectedHead: branch.state.head,
        operationId: membershipOperation,
        expectedEventCursor: operationCursor!,
        members,
        messages,
        receipts,
      },
      operationCursor!
    );
    const certifiedCursor = historyGeneration.exclusiveWriteCursor();
    await reloadBranch({ publish: true });
    if (
      activation.created &&
      observationScope === historyGeneration.observationScope &&
      certifiedCursor !== undefined &&
      knownCursor === certifiedCursor &&
      currentBranch().state.revision === activation.revision &&
      equal(currentBranch().state.head, activation.newHead)
    ) {
      const index = dispatchIndex(),
        source = roostHistory,
        host = historyHost,
        generation = readGeneration;
      const replacementMembers = new Map(
        messages.map((message) => [message.identity.businessId, message.identity])
      );
      const pages = async function* (): AsyncGenerator<readonly RoostDispatchRow[]> {
        for (let from = 0; from < next.length; from += 32) {
          const rows: RoostDispatchRow[] = [];
          for (let position = from; position < Math.min(next.length, from + 32); position++) {
            const entry = next[position];
            if (!entry) throw staleRead();
            const prepared = preparedById.get(entry.id);
            if (!prepared) {
              const old = oldById.get(entry.id);
              if (!old?.row.inspection) throw staleRead();
              rows.push({ ...old.row, position });
              continue;
            }
            const identity = replacementMembers.get(entry.id);
            if (!identity) throw staleRead();
            const member = await source.lookupMember(identity);
            if (!member) throw staleRead();
            rows.push({
              position,
              entry: dispatchEntry(prepared),
              inspection: inspectHistoryEntry(prepared as SessionEntry),
              segments: [
                {
                  turnId: bytesHex(member.turnId),
                  segmentId: 'primary',
                  physicalSegmentId: identity.segmentId,
                },
              ],
            });
          }
          yield rows;
        }
      };
      try {
        await index.rebuild(certifiedCursor, next.length, pages(), async () => {
          await historyGeneration.resolve();
          if (
            source !== historyGeneration.history ||
            host !== historyGeneration.host ||
            generation !== readGeneration ||
            certifiedCursor !== (await source.observedEventCursor())
          ) {
            needsRefresh = true;
            throw staleRead();
          }
        });
      } catch (error) {
        index.forget();
        console.error(`Roost dispatch projection needs repair for ${viewId}`, error);
      }
    }
    goalProjection = undefined;
    goalCoveredStart = totalHistoryCount;
    recordChange({ kind: 'structure', from: 0, to: Math.max(snapshot.rows.length, next.length) });
    pendingModelSummary = true;
    return true;
  };

  const commitTurnChanges = async (
    before: readonly SessionHistoryInput[],
    nextTurns: readonly SessionHistoryInput[],
    operationId: string,
    extra: readonly HistoryBatchCommand[] = [],
    textAppends?: readonly AgentHistoryTextAppend[],
    changes?: readonly AgentHistoryMutationPath[]
  ): Promise<boolean> => {
    const oldById = new Map(before.map((entry) => [entry.id, entry]));
    // Preflight every authored change before creating a receipt or editing a turn.
    const prepared = nextTurns.map((entry) => prepareTurn(oldById.get(entry.id), entry));
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
          ) ??
          (await roostHistory.readActiveBranchMessages(viewId, [entry.id])).find(
            (row) => row.segmentId === 'primary'
          );
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
          row = loadedSegments[index];
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
        inspection: inspectHistoryEntry(entry),
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
      const snapshot = await querySnapshot();
      const replacements = new Map(prepared.map((entry) => [entry.id, entry]));
      const next = snapshot.query.map(
        (row) => replacements.get(row.id as string) ?? (row as SessionHistoryInput)
      );
      await commitSparseHistory(snapshot, next, oldById, operationId, extra);
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
          inspection: inspectHistoryEntry(entry),
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
    const existing = await readPrivateTurn(prepared.id);
    if (existing.state === 'ready') {
      if (equal(existing.turn, prepared)) return false;
      throw new HistoryWriteError([{ path: ['id'], code: 'duplicate_id' }]);
    }
    const archived = await roostHistory.lookupMember({
      kind: 'message',
      businessId: prepared.id,
      segmentId: 'primary',
    });
    if (archived) {
      const snapshot = await querySnapshot();
      return commitSparseHistory(
        snapshot,
        [...(snapshot.query as SessionHistoryInput[]), prepared],
        new Map(),
        operationId
      );
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
    if (cached) return { state: 'ready' as const, turn: cached };
    return inspectAtCursor(
      await roostHistory.observedEventCursor(),
      async (index, checkpoint, source) => {
        const row = await index.row(turnId, checkpoint);
        const [entry] = row ? await readIndexedEntries(source, [row]) : [];
        return entry ? { state: 'ready' as const, turn: entry } : { state: 'missing' as const };
      }
    );
  };

  const commands: SessionHistoryCommands = {
    async applyHistoryAction(action) {
      let matched = false;
      await withWrites(`action:${operationDigest(action)}`, async () => {
        if (action.kind === 'permission-request') {
          const before = await inspectAtCursor(
            operationCursor!,
            async (index, checkpoint, source) => {
              const owners = await index.owners(
                checkpoint,
                'tool',
                action.request.toolCall.toolCallId
              );
              const selected = owners.filter((row) => {
                const scalars = index.inspection(row).scalars;
                return scalars.finished !== true && typeof scalars.endedAt !== 'number';
              });
              if (!owners.length && totalHistoryCount) {
                const [last] = await index.range(
                  checkpoint,
                  totalHistoryCount - 1,
                  totalHistoryCount
                );
                const scalars = index.inspection(last!).scalars;
                if (
                  scalars.role === 'assistant' &&
                  scalars.finished !== true &&
                  typeof scalars.endedAt !== 'number'
                )
                  selected.push(last!);
              }
              return readIndexedEntries(source, selected);
            }
          );
          if (!before.length) return false;
          const result = planDomainHistoryAction(before as never, action);
          matched = result.matched;
          return commitTurnChanges(
            before,
            result.turns as SessionHistoryInput[],
            `action:${operationDigest(action)}`,
            [],
            undefined,
            result.changes
          );
        }
        const target = historyActionTarget(action);
        if (target !== undefined) {
          const selected = await readPrivateTurn(target);
          const before = selected.state === 'ready' ? [selected.turn as SessionHistoryInput] : [];
          const result = planDomainHistoryAction(before as never, action);
          matched = result.matched;
          return commitTurnChanges(
            before,
            result.turns as SessionHistoryInput[],
            `action:${operationDigest(action)}`,
            [],
            undefined,
            result.changes
          );
        }
        const snapshot = await querySnapshot();
        const selected = selectHistoryActionRows(snapshot.query, action);
        const bodyRows = selected.map((index) => snapshot.rows[index]!);
        const bodies = new Map(
          (await readIndexedEntries(roostHistory, bodyRows)).map((entry) => [
            entry.id,
            entry as SessionHistoryInput,
          ])
        );
        const before = snapshot.query.map(
          (row) => bodies.get(row.id as string) ?? (row as SessionHistoryInput)
        );
        const result = planDomainHistoryAction(before as never, action);
        matched = result.matched;
        const next = result.turns as SessionHistoryInput[];
        if (next.length === before.length && next.every((entry, i) => entry.id === before[i]?.id)) {
          const changed = next.flatMap((entry, i) => (equal(entry, before[i]) ? [] : [entry]));
          for (const entry of changed)
            if (!bodies.has(entry.id))
              throw new HistoryWriteError([{ path: ['history'], code: 'unselected_change' }]);
          return commitTurnChanges(
            changed.map((entry) => bodies.get(entry.id)!),
            changed,
            `action:${operationDigest(action)}`,
            [],
            undefined,
            result.changes
          );
        }
        return commitSparseHistory(snapshot, next, bodies, `action:${operationDigest(action)}`);
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
        const turn = await inspectAtCursor(operationCursor!, async (index, checkpoint, source) => {
          const row = options?.turnId
            ? await index.row(options.turnId, checkpoint)
            : (await index.owners(checkpoint, 'permission', requestId, 0, 1))[0];
          return (await readIndexedEntries(source, row ? [row] : []))[0];
        });
        if (!turn || turn.role !== 'assistant') return false;
        const request = turn.items?.find(
          (item) => item.type === 'tool_call' && item.permissionRequest?.requestId === requestId
        );
        if (
          !request ||
          request.type !== 'tool_call' ||
          !request.permissionRequest ||
          request.permissionRequest.outcome !== undefined
        )
          return false;
        await roostHistory.commitHistoryBatch(
          `permission:${operationDigest([requestId, validated])}`,
          [
            {
              type: 'permission',
              requestId,
              assistantBusinessId: turn.id,
              outcome: encodeRoostContent(validated),
              parents: [],
            },
          ],
          { recovery: 'local' }
        );
        permissionCache.delete(requestId);
        await refreshTurnProjections([turn.id]);
        recordChange({ kind: 'changed', businessIds: [turn.id] });
        matched = true;
        return true;
      });
      return matched;
    },
    async replaceEditableTail(input): Promise<SessionEditableTailResult> {
      const operationId = `fork:${input.expectedUserTurnId}:${operationDigest(input.replacement)}`;
      let result: SessionEditableTailResult | undefined,
        writeAttempted = false;
      try {
        await withWrites(operationId, async () => {
          const snapshot = await querySnapshot();
          const boundary = planEditableTailReplacement(snapshot.query as never, input);
          const selected = snapshot.rows.slice(boundary.turns.length - 1);
          const bodies = new Map(
            (await readIndexedEntries(roostHistory, selected)).map((entry) => [
              entry.id,
              entry as SessionHistoryInput,
            ])
          );
          const before = snapshot.query.map(
            (row) => bodies.get(row.id as string) ?? (row as SessionHistoryInput)
          );
          const plan = planEditableTailReplacement(before as never, input);
          const next = plan.turns as SessionHistoryInput[];
          if (new Set(next.map((entry) => entry.id)).size !== next.length)
            throw new HistoryWriteError([{ path: ['history'], code: 'duplicate_id' }]);
          const start = next.length - 1;
          const removed = before.slice(start).map((entry) => clone(entry));
          const beforeIds = snapshot.query.map((row) => ({ id: row.id }));
          const afterIds = next.map((entry) => entry.id);
          const replacement = prepareTurn(undefined, input.replacement as SessionHistoryInput);
          writeAttempted = true;
          await commitSparseHistory(snapshot, next, bodies, operationId);
          const accepted = await readPrivateTurn(replacement.id);
          if (accepted.state !== 'ready') throw new Error('Replacement projection is unavailable');
          const afterReplacement = clone(accepted.turn);
          let consumed = false;
          result = {
            status: 'accepted',
            ...(plan.previousUserTurnId ? { previousUserTurnId: plan.previousUserTurnId } : {}),
            rollback: async () => {
              await withWrites(`rollback:${operationId}`, async () => {
                const current = await querySnapshot();
                if (
                  consumed ||
                  current.rows.length < afterIds.length ||
                  afterIds.some((id, index) => current.rows[index]?.entry.id !== id)
                )
                  throw new HistoryWriteError([{ path: ['history'], code: 'rollback_conflict' }]);
                const currentRows = current.rows.slice(start, afterIds.length);
                const currentBodies = new Map(
                  (await readIndexedEntries(roostHistory, currentRows)).map((entry) => [
                    entry.id,
                    entry as SessionHistoryInput,
                  ])
                );
                const currentRange = currentRows.map((row) => currentBodies.get(row.entry.id)!);
                if (!matchesRollbackReceipt(beforeIds, [afterReplacement], currentRange))
                  throw new HistoryWriteError([{ path: ['history'], code: 'rollback_conflict' }]);
                const restored = [
                  ...(current.query.slice(0, start) as SessionHistoryInput[]),
                  ...removed,
                  ...(current.query.slice(afterIds.length) as SessionHistoryInput[]),
                ];
                await commitSparseHistory(
                  current,
                  restored,
                  currentBodies,
                  `rollback:${operationId}`,
                  [],
                  true
                );
                consumed = true;
                return true;
              });
            },
          };
          return true;
        });
      } catch (cause) {
        if (
          !writeAttempted &&
          cause instanceof Error &&
          'code' in cause &&
          ['active_goal', 'stale_boundary', 'invalid_input'].includes(String(cause.code))
        )
          return {
            status: 'rejected',
            reason: { code: cause.code as 'active_goal' | 'stale_boundary' | 'invalid_input' },
          };
        if (!writeAttempted && cause instanceof HistoryWriteError)
          return { status: 'rejected', reason: { code: 'invalid_input', issues: cause.issues } };
        return { status: 'indeterminate', cause };
      }
      return result ?? { status: 'rejected', reason: { code: 'stale_boundary' } };
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
            let snapshot: QuerySnapshot | undefined;
            const bodies = new Map<string, SessionHistoryInput>();
            let before: SessionHistoryInput[];
            if (input.targetAssistantEntryId) {
              before =
                selected?.state === 'ready' && selected.turn.role === 'assistant'
                  ? [selected.turn as SessionHistoryInput]
                  : [];
              for (const entry of before) bodies.set(entry.id, entry);
            } else {
              snapshot = await querySnapshot();
              const pendingNotifications = pending.flatMap((event) =>
                event.kind === 'notification' ? [event.value] : []
              );
              const dependencies = pendingNotifications.flatMap(
                (notification) => targetLocalHistoryTargets([notification]) ?? []
              );
              const tools = new Set(dependencies.flatMap((target) => target.toolCallIds)),
                tasks = new Set(dependencies.flatMap((target) => target.taskIds));
              for (const event of pending) {
                if (event.kind === 'notification') {
                  const update = event.value.update;
                  if (
                    update.sessionUpdate === 'tool_call' ||
                    update.sessionUpdate === 'tool_call_update'
                  )
                    tools.add(update.toolCallId);
                } else {
                  if (event.value.type === 'tool_call') tools.add(event.value.toolCallId);
                  if (event.value.type === 'subagent_task') tasks.add(event.value.taskId);
                }
              }
              const positions = selectAgentHistoryRows(snapshot.query, {
                toolCallIds: tools,
                taskIds: tasks,
                runs: dependencies.flatMap((target) => target.runs),
              });
              const selectedBodies = await readIndexedEntries(
                roostHistory,
                positions.map((index) => snapshot!.rows[index]!)
              );
              for (const entry of selectedBodies)
                bodies.set(entry.id, entry as SessionHistoryInput);
              before = snapshot.query.map(
                (row) => bodies.get(row.id as string) ?? (row as SessionHistoryInput)
              );
            }
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
              const changed = next.filter((entry, index) => !equal(entry, before[index]));
              for (const entry of changed)
                if (!bodies.has(entry.id))
                  throw new HistoryWriteError([{ path: ['history'], code: 'unselected_change' }]);
              await commitTurnChanges(
                changed.map((entry) => bodies.get(entry.id)!),
                changed,
                operationId,
                receipts,
                planned.textAppends,
                planned.changes
              );
            } else {
              const current = snapshot ?? (await querySnapshot());
              const replacements = new Map(next.map((entry) => [entry.id, entry]));
              const combined = input.targetAssistantEntryId
                ? current.query.map(
                    (row) => replacements.get(row.id as string) ?? (row as SessionHistoryInput)
                  )
                : [...next];
              if (input.targetAssistantEntryId)
                for (const entry of next)
                  if (!current.rows.some((row) => row.entry.id === entry.id)) combined.push(entry);
              await commitSparseHistory(current, combined, bodies, operationId, receipts);
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
            const latest = await inspectAtCursor(operationCursor!, async (index, checkpoint) => {
              for (let end = checkpoint.header.count; end > 0; end -= 500) {
                const rows = await index.range(checkpoint, Math.max(0, end - 500), end);
                for (let i = rows.length - 1; i >= 0; i--)
                  if (rows[i]!.entry.role === 'user') return rows[i]!.entry;
              }
              return undefined;
            });
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
  const readHistoryInspection = (
    query: SessionHistoryInspectionQuery
  ): Promise<SessionHistoryReadResponse> =>
    onOwner(() =>
      readStable(async () => {
        const source = roostHistory,
          host = historyHost,
          generation = readGeneration,
          cursor = await source.observedEventCursor();
        if (cursor !== knownCursor) {
          needsRefresh = true;
          throw staleRead();
        }
        const result =
          query.kind === 'readLatestGoal'
            ? await readGoalDirect()
            : query.kind === 'readReplayPrompt'
              ? await readReplayFromMembers(source, query.excludeTurnId)
              : await inspectAtCursor(cursor, async (index, checkpoint, selectedSource) => {
                  const rows = await inspectionRows(
                    index,
                    checkpoint,
                    query.kind === 'readQuerySnapshot' ? query : undefined
                  );
                  if (query.kind === 'readMetadata')
                    return rows.map((row) => {
                      const fields = index.inspection(row);
                      return {
                        ...fields.scalars,
                        inputConfig: fields.inputConfig,
                        ...(fields.userId === undefined ? {} : { userId: fields.userId }),
                        ...(fields.scheduleRun === undefined
                          ? {}
                          : { scheduleRun: fields.scheduleRun }),
                      };
                    });
                  if (query.kind === 'readTranscript') {
                    const projected = await historyQueryRows(rows, index, selectedSource, true);
                    const selected = selectTranscriptHistoryPositions(projected, query);
                    return {
                      ...selected,
                      entries: await readIndexedEntries(
                        selectedSource,
                        selected.positions.map((position) => rows[position]!)
                      ),
                    };
                  }
                  const projected = await historyQueryRows(
                    rows,
                    index,
                    selectedSource,
                    query.transcriptVisibility
                  );
                  const token = inspectionToken(projected);
                  if (query.kind === 'readQuerySnapshot') return { rows: projected, token };
                  if (query.token !== token)
                    throw Object.assign(new Error('History selection changed'), {
                      code: 'superseded',
                    });
                  const positions = [...new Set(query.positions)];
                  const selected = positions.map((position) => {
                    const row = rows[position];
                    if (!Number.isSafeInteger(position) || !row)
                      throw new Error('Invalid history selection');
                    return row;
                  });
                  const bodies = await readIndexedEntries(selectedSource, selected);
                  const byPosition = new Map(
                    positions.map((position, offset) => [position, bodies[offset]])
                  );
                  return query.positions.map((position) => {
                    const entry = byPosition.get(position);
                    if (!entry) throw new Error('Owner history selection is incomplete');
                    return entry;
                  });
                });
        if (!history.getPublication) throw new Error('Native history publication is unavailable');
        const published = await history.getPublication();
        await historyGeneration.resolve();
        if (
          source !== historyGeneration.history ||
          host !== historyGeneration.host ||
          generation !== readGeneration ||
          cursor !== (await source.observedEventCursor())
        ) {
          needsRefresh = true;
          throw staleRead();
        }
        return {
          type: 'session/history-read_response',
          sessionId: sessionDoc.sessionId,
          success: true,
          result,
          historyRevision: published.historyRevision,
          historyCount: published.historyCount,
          historyChange: published.historyChange,
        };
      })
    );
  return {
    sessionData,
    readHistoryInspection,
    readHistoryReplay: (excludeTurnId) =>
      readObservedHistory(() => readReplayFromMembers(roostHistory, excludeTurnId)),
    readLatestGoal,
    readLatestUserId,
    foldHistory: (create, visit) =>
      readObservedHistory(() => foldMemberHistory(roostHistory, create, visit)),
    readHistoryQuery: (options) =>
      inspectHistory(async (index, checkpoint, source) => {
        const rows = await inspectionRows(index, checkpoint, options);
        return historyQueryRows(rows, index, source, options?.transcriptVisibility);
      }),
    readHistorySelection: (select, options) =>
      inspectHistory(async (index, checkpoint, source) => {
        const rows: RoostDispatchRow[] = [];
        for (let from = 0; from < checkpoint.header.count; from += 500)
          rows.push(
            ...(await index.range(checkpoint, from, Math.min(checkpoint.header.count, from + 500)))
          );
        const selected = select(
          await historyQueryRows(rows, index, source, options?.transcriptVisibility)
        );
        return readIndexedEntries(
          source,
          selected.map((position) => {
            const row = rows[position];
            if (!Number.isSafeInteger(position) || !row)
              throw new Error('Invalid history selection');
            return row;
          })
        );
      }),
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
