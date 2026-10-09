import { createHash, randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  applyMessageContentsBatch,
  applyNotificationOnHistory,
  type SessionPlanEntry,
  type SessionHistoryInput,
  captureStoredHistory,
  prepareStoredHistoryCopy,
  matchesRollbackReceipt,
  prepareReplacement,
  HistoryEntryWriteSchema,
  HistoryWriteError,
  parseHistoryWrite,
  PermissionOutcomeSchema,
} from '@lody/shared';
import {
  applyHistoryAction as applyDomainHistoryAction,
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
import { RoostNativeClient } from '@loro-dev/roost-node';
import type { SessionDocument } from '@/lib/loro/doc';
import type { SessionAgentWrites } from '@/lib/loro/session-agent-writes';
import { latestSessionModel } from '@/lib/loro/session-model-summary';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  createRoostSessionBackendFactory,
  type RoostSessionBackendServices,
} from './roost-session-backend';
import {
  adaptRoostProjectedMessage,
  adaptRoostProjectedMessages,
  encodeRoostContent,
} from './roost-history-port';
import { registerSessionBackendFactory } from './session-backend';
import { RoostHistoryGeneration } from './roost-history-generation';

type RoostNativeOptions = {
  readonly dbPath?: string;
  readonly seed?: Uint8Array;
  readonly maxQueuedRequests?: number;
  readonly maxQueuedBytes?: number;
};

type OwnerLease = {
  readonly client: RoostNativeClient;
  readonly owner: Uint8Array;
  release(): Promise<void>;
};

const bytesHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

const parseSeed = (raw: string | undefined): Uint8Array | undefined => {
  if (!raw?.trim()) return undefined;
  const value = raw.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('LODY_ROOST_SEED_HEX must contain exactly 32 bytes (64 hex characters)');
  }
  return Uint8Array.from(Buffer.from(value, 'hex'));
};

const loadRoostOwnerSeed = async (): Promise<Uint8Array> => {
  const configured = parseSeed(process.env.LODY_ROOST_SEED_HEX);
  if (configured) return configured;
  try {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    const entry = new AsyncEntry('Lody Roost History', 'owner-seed-v1', {
      linux: { store: 'secret-service' },
    });
    const existing = await entry.getPassword(AbortSignal.timeout(30_000));
    const restored = parseSeed(existing ?? undefined);
    if (existing && !restored) {
      throw new Error('stored Roost owner identity is invalid');
    }
    if (restored) return restored;
    const generated = randomBytes(32);
    await entry.setPassword(generated.toString('hex'), AbortSignal.timeout(30_000));
    return generated;
  } catch (error) {
    throw new Error(
      `Roost history owner identity is unavailable; configure LODY_ROOST_SEED_HEX or unlock the system credential store (${error instanceof Error ? error.message : String(error)})`,
      { cause: error }
    );
  }
};

const defaultDatabase = (): string =>
  process.env.LODY_ROOST_DB_PATH?.trim() ||
  join(getLodyDataDir(undefined, homedir()), 'roost-history.sqlite3');

let ownerPool:
  | {
      key: string;
      client: RoostNativeClient;
      owner: Uint8Array;
      refs: number;
      closePromise?: Promise<void>;
    }
  | undefined;

const acquireOwnerUnlocked = async (options: RoostNativeOptions): Promise<OwnerLease> => {
  const seed = options.seed ?? (await loadRoostOwnerSeed());
  const dbPath = resolve(options.dbPath ?? defaultDatabase());
  const key = `${dbPath}:${bytesHex(seed)}`;
  if (ownerPool?.key === key && !ownerPool.closePromise) {
    ownerPool.refs += 1;
    return {
      client: ownerPool.client,
      owner: ownerPool.owner.slice(),
      release: async () => releaseOwner(key),
    };
  }
  if (ownerPool) await releaseOwnerUnlocked(ownerPool.key, true);
  await mkdir(dirname(dbPath), { recursive: true });
  const owner = Identity.fromSeed(seed).owner();
  const client = new RoostNativeClient({
    dbPath,
    seed,
    allowedOwners: [owner],
    maxQueuedRequests: options.maxQueuedRequests ?? 32,
    maxQueuedBytes: options.maxQueuedBytes ?? 8 * 1024 * 1024,
  });
  try {
    await client.ready;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
  ownerPool = { key, client, owner, refs: 1 };
  return {
    client,
    owner: owner.slice(),
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
  await current.closePromise;
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
  await historyGeneration.resolve();
  let historyHost = historyGeneration.host;
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
  let pendingChange: RoostHistoryChange | undefined;
  let pendingModelSummary = false;
  let latestAssistantId: string | undefined;
  let latestModelTurnId: string | undefined;
  let syncModelSummary: (() => Promise<void>) | undefined;
  let fullEntriesCache: SessionEntry[] | undefined;
  let readGeneration = 0;
  let writeSerial: Promise<void> = Promise.resolve();
  let operationCursor: bigint | undefined;
  let needsRefresh = false;
  const stateCache = new Map<string, Promise<HistoryProjectedMessage | undefined>>();
  const permissionCache = new Map<string, Promise<Record<string, unknown> | undefined>>();

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
  const readState = (primary: HistoryProjectedMessage) => {
    const identity = stateIdentity(primary);
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
    messages: readonly HistoryProjectedMessage[]
  ): Promise<SessionEntry[]> => {
    const projected = projectRoostSegments(adaptRoostProjectedMessages(messages)) as SessionEntry[];
    const primaries = new Map(
      messages.filter((row) => row.segmentId === 'primary').map((row) => [row.businessId, row])
    );
    const result: SessionEntry[] = [];
    // Bound native requests independently of a page's number of tool requests.
    for (const entry of projected) {
      const primary = primaries.get(entry.id);
      const state = primary ? await readState(primary) : undefined;
      let turn = state ? (toApplicationJson(state.content) as SessionEntry) : entry;
      if (turn.id !== entry.id) throw new Error('Roost state record identity mismatch');
      const items = [...(turn.items ?? [])];
      for (const [index, item] of items.entries()) {
        if (item.type !== 'tool_call' || !item.permissionRequest) continue;
        const requestId = item.permissionRequest.requestId;
        let promise = permissionCache.get(requestId);
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
          permissionCache.set(requestId, promise);
          while (permissionCache.size > 500)
            permissionCache.delete(permissionCache.keys().next().value!);
        }
        const response = await promise;
        if (response?.assistantBusinessId === turn.id) {
          const outcome = parseHistoryWrite(PermissionOutcomeSchema, response.outcome);
          items[index] = { ...item, permissionRequest: { ...item.permissionRequest, outcome } };
        }
      }
      turn = { ...turn, items };
      result.push(clone(turn));
    }
    return result;
  };
  // Directory pages already carry bodies; retain a bounded cache for hydration.
  const pageEntries = new Map<string, { position: number; turn: SessionEntry }>();
  const pageIdsByPosition = new Map<number, string>();
  const pageBodyLimit = 500;

  const readFullBranch = () => roostHistory.readActiveBranch(viewId);
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
      const segment = adaptRoostProjectedMessage(message);
      const key = identityKey(segment);
      projectedByIdentity.set(key, message);
    }
  };

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

  const projectBranchPage = async (branch: ActiveBranchPageRead): Promise<SessionEntry[]> => {
    if (!branch.complete) {
      throw new Error(`Roost active branch for ${viewId} is incomplete`);
    }
    const projected = await projectMessages(branch.messages);
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
    branch: ActiveBranchPageRead
  ): Promise<SessionHistoryDirectoryPage> => {
    const projected = await projectBranchPage(branch);
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
    notify = false
  ): void => {
    const previous = rows;
    const previousStart = loadedStartPosition;
    activeBranch = branch;
    windowHistory = roostHistory;
    loadedStartPosition = branch.startPosition;
    totalHistoryCount = branch.totalCount;
    rows = adaptRoostProjectedMessages(branch.messages).map((row) => ({ ...row }));
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
    if (await historyGeneration.resolve()) {
      branchCursors.clear();
    }
    roostHistory = historyGeneration.history;
    historyHost = historyGeneration.host;
    stateCache.clear();
    permissionCache.clear();
    readGeneration += 1;
    pageEntries.clear();
    pageIdsByPosition.clear();
    fullEntriesCache = undefined;
    const previous = rows;
    const previousEntries = entries;
    const previousStart = loadedStartPosition;
    const nextBranch = await roostHistory.readActiveBranchPage(viewId, {
      latest: true,
      limit: branchPageSize,
    });
    if (disposed) throw new Error('Roost session backend is disposed');
    const projected = await projectBranchPage(nextBranch);
    const nextRows = adaptRoostProjectedMessages(nextBranch.messages);
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
    installBranchWindow(nextBranch, projected);
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
    const next = reloadPromise ?? performBranchReload();
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
    const known = branch.messages.find((row) =>
      Buffer.from(row.turnId).equals(Buffer.from(turnId))
    );
    const position = known ? positionById.get(known.businessId) : undefined;
    // This identity already belongs to the active window. Editing its unsealed
    // primary cannot change membership; hydrate just that physical message.
    if (!mutation && known?.segmentId === 'primary' && !known.sealed && position !== undefined) {
      const [fresh] = await roostHistory.readProjectedMessagesById([turnId]);
      if (disposed) throw new Error('Roost session backend is disposed');
      if (!fresh || identityKey(fresh) !== identityKey(known)) {
        throw new Error(`Roost changed message ${known.businessId} is unavailable`);
      }
      if (generation === readGeneration && activeBranch === branch && !fresh.sealed) {
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
    // Re-read the bounded latest window after membership/seal changes. This keeps a
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

  const storedCursor = await sessionDoc.getRoostHistoryCursor();
  if (!Number.isSafeInteger(storedCursor?.historyRevision)) {
    const observedCursor = await roostHistory.observedEventCursor();
    await sessionDoc.setRoostHistoryCursor({
      cursor: storedCursor?.cursor ?? observedCursor.toString(),
      ...(storedCursor?.operationId ? { operationId: storedCursor.operationId } : {}),
      historyRevision: 0,
      historyCount: totalHistoryCount,
      historyChangeJson: 'null',
    });
  }
  let observedHistoryRevision = Number.isSafeInteger(storedCursor?.historyRevision)
    ? storedCursor!.historyRevision!
    : 0;

  // Ignore unrelated control writes and refresh only for another history owner.
  // Queue refreshes with writes so a pending branch read cannot install an old
  // window after a newer local mutation has published its projection.
  const unsubscribeControl = sessionDoc.subscribeRoostHistoryCursor(() => {
    if (disposed) return;
    const next = writeSerial.then(async () => {
      if (disposed) return;
      const cursor = await sessionDoc.getRoostHistoryCursor();
      if (
        disposed ||
        cursor?.historyRevision === undefined ||
        cursor.historyRevision <= observedHistoryRevision
      ) {
        return;
      }
      await reloadBranch();
      observedHistoryRevision = cursor.historyRevision;
      if (pendingModelSummary) {
        await syncModelSummary?.();
        pendingModelSummary = false;
      }
    });
    writeSerial = next.catch((error) => {
      console.error(`Roost session history refresh failed for ${viewId}`, error);
    });
  });

  const readyTurn = (turn: SessionEntry): SessionTurnRead => ({
    state: 'ready',
    turn: clone(turn) as SessionTurn,
  });
  const staleRead = () =>
    Object.assign(new Error(`Roost active branch for ${viewId} changed during a read`), {
      code: 'stale',
    });
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
  const readPage = async (input: Parameters<typeof roostHistory.readActiveBranchPage>[1]) => {
    const generation = readGeneration;
    const branch = await roostHistory.readActiveBranchPage(viewId, input);
    if (generation !== readGeneration || disposed) throw staleRead();
    const projected = await projectBranchPage(branch);
    if (input?.latest && branch.startPosition + projected.length !== branch.totalCount) {
      throw new Error(`Roost latest page for ${viewId} does not reach the active head`);
    }
    if (branch.state.revision === currentBranch().state.revision) {
      for (const [index, turn] of projected.entries()) {
        const position = branch.startPosition + index;
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
    readStable(async () =>
      directoryPageFromBranch(
        limit === branchPageSize
          ? currentBranch()
          : (await readPage({ latest: true, limit })).branch
      )
    );
  const history: SessionHistoryReader = {
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
        return directoryPageFromBranch((await readPage({ before: decoded, limit })).branch);
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

  const { createRoostSessionData } = await import('@lody/shared/session-data');
  syncModelSummary = async () => {
    const read = latestModelTurnId
      ? await history.readTurn(latestModelTurnId)
      : { state: 'missing' as const };
    const turn = read.state === 'ready' ? [read.turn] : [];
    await sessionDoc.setLastModel(latestSessionModel(turn));
  };
  await syncModelSummary();

  const pendingSeen = new Map<string, Promise<void>>();

  const publishCursor = async (operationId: string): Promise<void> => {
    const cursor = await roostHistory.observedEventCursor();
    const change = pendingChange;
    const previous = await sessionDoc.getRoostHistoryCursor();
    const historyRevision = (previous?.historyRevision ?? 0) + 1;
    if (!Number.isSafeInteger(historyRevision)) {
      throw new Error(`Roost history revision overflow for ${viewId}`);
    }
    await sessionDoc.setRoostHistoryCursor({
      cursor: cursor.toString(),
      operationId,
      historyRevision,
      historyCount: totalHistoryCount,
      historyChangeJson: JSON.stringify(
        change
          ? change.kind === 'changed'
            ? { kind: 'changed', ids: change.businessIds }
            : change
          : null
      ),
    });
    observedHistoryRevision = Math.max(observedHistoryRevision, historyRevision);
    if (pendingChange === change) pendingChange = undefined;
    if (change) notifyHistoryChange(change);
    if (pendingModelSummary) {
      await syncModelSummary?.();
      pendingModelSummary = false;
    }
  };

  const withWrites = async (
    operationId: string,
    operation: () => Promise<boolean | void>
  ): Promise<void> => {
    if (closing || disposed) throw new Error('Roost session backend is disposed');
    const next = writeSerial.then(async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await historyGeneration.resolve();
          if (needsRefresh || reloadPromise || windowHistory !== historyGeneration.history) {
            await reloadBranch({ publish: true });
            needsRefresh = false;
          }
          operationCursor = await roostHistory.observedEventCursor();
          const changed = await operation();
          if (changed !== false || pendingChange || pendingModelSummary)
            await publishCursor(operationId);
          return;
        } catch (error) {
          needsRefresh = true;
          const stale = error instanceof Error && 'code' in error && error.code === 'stale';
          if (!stale || attempt >= 2) throw error;
          const cursor = await sessionDoc.getRoostHistoryCursor();
          if (Number.isSafeInteger(cursor?.historyRevision)) {
            observedHistoryRevision = Math.max(observedHistoryRevision, cursor!.historyRevision!);
          }
          await reloadBranch({ publish: true });
          needsRefresh = false;
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
      return [
        state
          ? {
              type: 'setContent',
              identity,
              expectedNextSeq: state.nextSeq,
              content: encodeRoostContent(after),
            }
          : {
              type: 'accept',
              identity,
              parents: primary.sealedHash ? [{ id: primary.turnId, hash: primary.sealedHash }] : [],
              content: encodeRoostContent(after),
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
  const refreshTurnProjections = async (changed: readonly string[]): Promise<void> => {
    if (!changed.length) return;
    const ids = new Set(changed);
    for (const key of stateCache.keys()) {
      if (ids.has(key.slice(0, key.indexOf('\u0000')))) stateCache.delete(key);
    }
    for (const id of ids) {
      const cached = pageEntries.get(id);
      if (cached) pageIdsByPosition.delete(cached.position);
      pageEntries.delete(id);
    }
    fullEntriesCache = undefined;
    const branch = currentBranch();
    const primaryIds = branch.messages
      .filter((row) => row.segmentId === 'primary' && ids.has(row.businessId))
      .map((row) => row.turnId);
    const fresh = await roostHistory.readProjectedMessagesById(primaryIds);
    if (fresh.length !== primaryIds.length || fresh.some((row) => !row || !ids.has(row.businessId)))
      throw new Error('Roost changed history is incomplete');
    const byPhysicalId = new Map(fresh.map((row) => [bytesHex(row.turnId), row]));
    const messages = branch.messages.map((row) => byPhysicalId.get(bytesHex(row.turnId)) ?? row);
    const projected = await projectMessages(messages.filter((row) => ids.has(row.businessId)));
    for (const entry of projected) {
      const position = positionById.get(entry.id);
      if (position === undefined) throw new Error('Roost changed history has no position');
      entries[position] = clone(entry);
      directory[position] = createRoostDirectoryRow(loadedStartPosition + position, entry);
    }
    activeBranch = { ...branch, messages };
    rows = [...adaptRoostProjectedMessages(messages)];
    rebuildSegmentIndexes(messages);
    readGeneration += 1;
    updateLatestSummaryTargets();
    pendingModelSummary = true;
  };

  const commitTurnChanges = async (
    before: readonly SessionHistoryInput[],
    next: readonly SessionHistoryInput[],
    operationId: string,
    extra: readonly HistoryBatchCommand[] = []
  ): Promise<boolean> => {
    const oldById = new Map(before.map((entry) => [entry.id, entry]));
    // Preflight every authored change before creating a receipt or editing a turn.
    const prepared = next.map((entry) => prepareTurn(oldById.get(entry.id), entry));
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
      await historyGeneration.replace(
        (await readAll()).map((entry) => replacements.get(entry.id) ?? entry),
        operationId,
        operationCursor,
        { commands: extra }
      );
      await reloadBranch({ publish: true });
    } else {
      await roostHistory.commitHistoryBatch(
        `${operationId}:${randomBytes(8).toString('hex')}`,
        commands
      );
      await refreshTurnProjections(changed);
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
    return accepted.created;
  };

  const readAll = async (): Promise<SessionHistoryInput[]> =>
    (await history.readAll()) as SessionHistoryInput[];

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
    recordChange({ kind: 'structure', from: 0, to: Math.max(current.length, prepared.length) });
    return true;
  };

  const commands: SessionHistoryCommands = {
    async applyHistoryAction(action) {
      let matched = false;
      await withWrites(`action:${operationDigest(action)}`, async () => {
        const target = historyActionTarget(action);
        const selected = target ? await history.readTurn(target) : undefined;
        const before = target
          ? selected?.state === 'ready'
            ? [selected.turn as SessionHistoryInput]
            : []
          : await readAll();
        const result = applyDomainHistoryAction(clone(before) as never, action);
        matched = result.matched;
        const turns = result.turns as unknown as SessionHistoryInput[];
        return target
          ? commitTurnChanges(before, turns, `action:${operationDigest(action)}`)
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
        const read = await history.readTurn(turnId);
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
        const read = targetId ? await history.readTurn(targetId) : { state: 'missing' as const };
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
          ]
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
          const before = await readAll();
          const plan = planEditableTailReplacement(before as never, input);
          const start = plan.turns.length - 1;
          const replacement = prepareTurn(undefined, input.replacement as SessionHistoryInput);
          writeAttempted = true;
          await replaceActiveHistory([...before.slice(0, start), replacement], operationId);
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
                  !matchesRollbackReceipt(
                    before.slice(start),
                    [replacement],
                    current.slice(index, index + 1)
                  )
                )
                  throw new HistoryWriteError([{ path: ['history'], code: 'rollback_conflict' }]);
                await replaceActiveHistory(
                  [...current.slice(0, index), ...before.slice(start), ...current.slice(index + 1)],
                  `${operationId}:rollback`,
                  [],
                  { storedCopy: true }
                );
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
        const read = await history.readTurn(turnId);
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
        const read = await history.readTurn(turnId);
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
        const read = await history.readTurn(input.turnId);
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
      await withWrites(operationId, async () => {
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
            const prior = await historyGeneration.lookupOperation(identity);
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
          const selected = input.targetAssistantEntryId
            ? await history.readTurn(input.targetAssistantEntryId)
            : undefined;
          const before = input.targetAssistantEntryId
            ? selected?.state === 'ready' && selected.turn.role === 'assistant'
              ? [selected.turn as SessionHistoryInput]
              : []
            : await readAll();
          let next = clone(before);
          // Preserve transport order instead of deduplicating identical payloads.
          for (const event of pending) {
            if (event.kind === 'notification') {
              next = applyNotificationOnHistory(next, [event.value], input.model, {
                ...(input.createId ? { createId: input.createId } : {}),
                ...(input.now ? { now: input.now } : {}),
                ...(input.targetAssistantEntryId
                  ? { targetAssistantEntryId: input.targetAssistantEntryId }
                  : {}),
              });
            } else {
              next = applyMessageContentsBatch(next, [event.value], {
                ...(input.createId ? { createId: input.createId } : {}),
                ...(input.now ? { now: input.now } : {}),
                ...(input.targetAssistantEntryId
                  ? { targetAssistantEntryId: input.targetAssistantEntryId }
                  : {}),
                ...(input.model ? { model: input.model } : {}),
              });
            }
          }
          if (
            next.length === before.length &&
            next.every((entry, index) => entry.id === before[index]?.id)
          ) {
            await commitTurnChanges(before, next, operationId, receipts);
          } else {
            const all = await readAll();
            const changed = new Map(next.map((entry) => [entry.id, entry]));
            const combined = all.map((entry) => changed.get(entry.id) ?? entry);
            for (const entry of next)
              if (!all.some((old) => old.id === entry.id)) combined.push(entry);
            await replaceActiveHistory(combined, operationId, receipts);
          }
          anyChanged = true;
          operationCursor = await roostHistory.observedEventCursor();
        }
        return anyChanged;
      });
    },
  };

  const sessionData: RoostSessionData = createRoostSessionData({
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
      // the failed action. RPC reads must bind it to a durable control revision.
      await withWrites(`projection-recovery:${randomBytes(8).toString('hex')}`, async () => false);
    }
  };

  return {
    sessionData,
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
      unsubscribeControl();
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
  const lease = await acquireOwner(ownerOptions);
  try {
    return await createNodeServicesForLease(sessionDoc, lease);
  } catch (error) {
    await lease.release().catch(() => undefined);
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
