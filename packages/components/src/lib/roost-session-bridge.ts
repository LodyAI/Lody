import type {
  LocalSessionControlRequest,
  LocalSessionControlResponse,
  MachineId,
  PermissionOutcome,
  SessionHistoryChange,
  SessionHistoryInput,
  SessionHistoryReadQuery,
  SessionHistoryReadResponse,
  SessionHistoryWriteOperation,
  SessionId,
  WorkspaceId,
} from '@lody/shared';
import {
  createRoostSessionData,
  createRoostDirectoryRow,
  applySessionHistoryPatches,
  type HistoryAction,
  type HistoryImportInput,
  type ReplaceEditableTailInput,
  type RoostSessionData,
  type SessionActionResult,
  type SessionDataChangeListener,
  type SessionDirectoryRow,
  type SessionHistoryDirectoryPage,
  type SessionEditableTailResult,
  type SessionEntry,
  type SessionHistoryReader,
  type SessionImportResult,
  type SessionSnapshot,
  type SessionTurn,
  type SessionTurnRead,
  type SessionInputAcceptanceResult,
  readSessionHistoryMetadata,
} from '@lody/shared/session-data';
import { sendLocalSessionControl } from './electron-ipc-client';
import { RoostHistoryError, SessionHistoryRequestError } from './roost-history-error';
import type {
  SessionHistoryRpcReadResponse,
  SessionHistoryRpcWriteResponse,
} from '@lody/loro-streams-rpc';
import {
  createRoostHistoryCache,
  parseRoostCacheCursor,
  roostCacheCursor,
} from './roost-history-cache';
import type { ConversationSessionDataFactory } from './conversation-view/create-conversation-session';
import type { SessionSnapshotService } from '@lody/shared/session-data';
import { SessionHistoryChangesSchema } from '@lody/shared';

type HistoryReadResponse = Extract<
  LocalSessionControlResponse,
  { type: 'session/history-read_response' }
>;
type HistoryWriteResponse = Extract<
  LocalSessionControlResponse,
  { type: 'session/history-write_response' }
>;

type RoostHistoryTransport = {
  readonly readHistory: (query: SessionHistoryReadQuery) => Promise<SessionHistoryReadResponse>;
  readonly writeHistory: (
    operation: SessionHistoryWriteOperation,
    payload: Record<string, unknown>
  ) => Promise<{
    readonly result?: unknown;
    readonly historyRevision?: number;
    readonly historyCount?: number;
    readonly historyChange?: SessionHistoryChange | null;
  }>;
};

type RoostHistoryObservationOptions = {
  readonly coherentInspection?: boolean | (() => boolean);
  readonly incremental?: boolean | (() => boolean);
  readonly watch?: boolean | (() => boolean);
  readonly patches?: boolean | (() => boolean);
  readonly active?: () => boolean;
  readonly subscribeWake?: (wake: () => void) => () => void;
};

export type LocalRoostSessionBridgeOptions = RoostHistoryObservationOptions & {
  readonly accountId?: string | null;
  readonly workspaceId: WorkspaceId;
  readonly machineId: MachineId;
  readonly sendControl?: typeof sendLocalSessionControl;
};

export type RemoteRoostSessionBridgeOptions = RoostHistoryObservationOptions & {
  readonly accountId?: string | null;
  readonly workspaceId: WorkspaceId;
  readonly machineId: MachineId;
  readonly requestHistoryRead: (
    machineId: MachineId,
    sessionId: SessionId,
    query: SessionHistoryReadQuery
  ) => Promise<SessionHistoryRpcReadResponse>;
  readonly requestHistoryWrite: (args: {
    readonly machineId: MachineId;
    readonly sessionId: SessionId;
    readonly operation: SessionHistoryWriteOperation;
    readonly payload: Record<string, unknown>;
  }) => Promise<SessionHistoryRpcWriteResponse>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const validateInputAcceptance = (value: unknown, turnId: string): SessionInputAcceptanceResult => {
  if (isRecord(value) && value.status === 'unobserved') return { status: 'unobserved' };
  if (
    isRecord(value) &&
    value.status === 'accepted' &&
    value.turnId === turnId &&
    typeof value.active === 'boolean'
  )
    return { status: 'accepted', turnId, active: value.active };
  throw new Error('Roost owner returned an invalid input acceptance receipt');
};

const validateHistory = (value: unknown, source: string): readonly SessionHistoryInput[] => {
  if (!Array.isArray(value)) {
    throw new Error(`${source} returned malformed history`);
  }
  return value.map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== 'string' ||
      entry.id.trim().length === 0 ||
      (entry.role !== 'user' && entry.role !== 'assistant' && entry.role !== 'system') ||
      typeof entry.timestamp !== 'string'
    ) {
      throw new Error(`${source} returned malformed history entry at index ${index}`);
    }
    return entry as SessionHistoryInput;
  });
};

const validateTurnRead = (value: unknown, source: string): SessionTurnRead => {
  if (!isRecord(value) || typeof value.state !== 'string') {
    throw new Error(`${source} returned a malformed turn read`);
  }
  if (value.state === 'ready') {
    const [turn] = validateHistory([value.turn], source);
    return { state: 'ready', turn: turn as unknown as SessionTurn };
  }
  if (value.state === 'invalid' || value.state === 'missing') return { state: value.state };
  if (
    value.state === 'unavailable' &&
    (value.reason === 'incomplete' || value.reason === 'unsupported' || value.reason === 'failed')
  ) {
    return { state: 'unavailable', reason: value.reason };
  }
  throw new Error(`${source} returned a malformed turn read state`);
};

const validateDirectory = (value: unknown, source: string): readonly SessionDirectoryRow[] => {
  if (!Array.isArray(value)) throw new Error(`${source} returned a malformed directory`);
  return value.map((row, index) => {
    if (
      !isRecord(row) ||
      !Number.isSafeInteger(row.position) ||
      (row.state !== 'ready' &&
        row.state !== 'invalid' &&
        row.state !== 'missing' &&
        row.state !== 'unavailable')
    ) {
      throw new Error(`${source} returned a malformed directory row at index ${index}`);
    }
    return row as unknown as SessionDirectoryRow;
  });
};

const validateDirectoryPage = (value: unknown, source: string): SessionHistoryDirectoryPage => {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.startPosition) ||
    !Number.isSafeInteger(value.totalCount) ||
    typeof value.hasMoreOlder !== 'boolean' ||
    (value.cursor !== null && typeof value.cursor !== 'string')
  ) {
    throw new Error(`${source} returned malformed page metadata`);
  }
  const rows = validateDirectory(value.rows, source);
  if (
    (value.startPosition as number) < 0 ||
    (value.totalCount as number) < (value.startPosition as number) + rows.length ||
    rows.some((row, index) => row.position !== (value.startPosition as number) + index)
  ) {
    throw new Error(`${source} returned inconsistent page positions`);
  }
  return { ...value, rows } as SessionHistoryDirectoryPage;
};

const READ_PAGE_SIZE = 500;
const INITIAL_DIRECTORY_READ_ATTEMPTS = 8;

class HistoryRefreshSupersededError extends Error {
  constructor() {
    super('Roost history observation was superseded');
    this.name = 'HistoryRefreshSupersededError';
  }
}

const isHistorySuperseded = (error: unknown): boolean =>
  error instanceof HistoryRefreshSupersededError ||
  (error instanceof RoostHistoryError && error.retryReason === 'superseded');

class HistoryDirectoryChangedDuringReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoryDirectoryChangedDuringReadError';
  }
}

const containsFunction = (value: unknown, seen = new Set<object>()): boolean => {
  if (typeof value === 'function') return true;
  if (!isRecord(value) && !Array.isArray(value)) return false;
  const object = value as object;
  if (seen.has(object)) return false;
  seen.add(object);
  return Array.isArray(value)
    ? value.some((item) => containsFunction(item, seen))
    : Object.values(value).some((item) => containsFunction(item, seen));
};

const assertSerializableHistoryPayload = (
  operation: SessionHistoryWriteOperation,
  payload: Record<string, unknown>
): void => {
  if (containsFunction(payload)) {
    throw new Error(`Roost history operation ${operation} contains a non-serializable value`);
  }
};

const createRoostSessionDataFactoryFromTransport =
  (
    createTransport: (sessionId: SessionId) => RoostHistoryTransport,
    cacheScope: (sessionId: SessionId) => string,
    targetMachineId: MachineId,
    options: RoostHistoryObservationOptions = {}
  ): ConversationSessionDataFactory =>
  ({ sessionId }) => {
    const transport = createTransport(sessionId);
    const incrementalEnabled = () =>
      typeof options.incremental === 'function'
        ? options.incremental()
        : options.incremental === true;
    const coherentInspectionEnabled = () =>
      typeof options.coherentInspection === 'function'
        ? options.coherentInspection()
        : options.coherentInspection === true;
    const active = () => options.active?.() ?? true;
    const patchesEnabled = () =>
      incrementalEnabled() &&
      (typeof options.patches === 'function' ? options.patches() : options.patches === true);
    const watchEnabled = () =>
      incrementalEnabled() &&
      active() &&
      (typeof options.watch === 'function' ? options.watch() : options.watch === true);
    let disposed = false;
    const cache = createRoostHistoryCache(cacheScope(sessionId));
    let cacheWarningReported = false;
    const cached = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await read();
      } catch (error) {
        if (!disposed && !cacheWarningReported) {
          cacheWarningReported = true;
          console.warn('Roost history persistence is unavailable', error);
        }
        return undefined;
      }
    };
    const bodies = new Map<string, { turn: SessionHistoryInput; position?: number }>();
    const rememberBody = (turn: SessionHistoryInput, position?: number) => {
      bodies.delete(turn.id);
      bodies.set(turn.id, { turn: structuredClone(turn), position });
      while (bodies.size > 200) bodies.delete(bodies.keys().next().value!);
    };
    let ownerRevision: number | undefined;
    let hasIncrementalCheckpoint = false;
    let replacingSnapshot = false;
    let displayedCacheRevision: number | undefined;
    let seenCacheRevision: number | undefined;
    let scheduleRefresh = () => {};
    const pendingReads = new Map<string, Promise<SessionHistoryReadResponse>>();
    const listeners = new Set<SessionDataChangeListener>();
    const snapshotProvenance = new WeakSet<object>();

    const readOwner = (query: SessionHistoryReadQuery): Promise<SessionHistoryReadResponse> => {
      const incremental = incrementalEnabled();
      if (incremental && (query.kind === 'readLatestPage' || query.kind === 'readOlderPage'))
        query = { ...query, withCheckpoint: true };
      const key = JSON.stringify(query);
      const pending = pendingReads.get(key);
      if (pending) return pending;
      const next = (async () => {
        if (disposed) throw new Error('Roost session bridge is disposed');
        const response = await transport.readHistory(query);
        if (disposed) throw new Error('Roost session bridge is disposed');
        const revision = response.historyRevision;
        const count = response.historyCount;
        const coherentProgress =
          incremental &&
          (query.kind === 'readChanges' ||
            query.kind === 'watchChanges' ||
            ((query.kind === 'readLatestPage' || query.kind === 'readOlderPage') &&
              query.withCheckpoint));
        if (
          revision === undefined ||
          count === undefined ||
          !Number.isSafeInteger(revision) ||
          !Number.isSafeInteger(count)
        ) {
          throw new Error('Roost history read has no durable observation');
        }
        if (!coherentProgress && ownerRevision !== undefined && revision < ownerRevision) {
          throw new HistoryRefreshSupersededError();
        }
        const firstOwnerObservation = ownerRevision === undefined;
        if (firstOwnerObservation) bodies.clear();
        ownerRevision = Math.max(ownerRevision ?? 0, revision);
        await notifyChanged(response.historyChange, revision, count);
        if (
          disposed ||
          (!coherentProgress && (revision < ownerRevision || revision < observedHistoryRevision))
        ) {
          throw new HistoryRefreshSupersededError();
        }
        if (firstOwnerObservation && !(incrementalEnabled() && hasIncrementalCheckpoint)) {
          // Cached bootstrap can overlap this first authoritative reply.
          observedDirectoryEpoch += 1;
          for (const listener of listeners) listener({ kind: 'structure', from: 0, to: count });
        }
        if (query.kind === 'readLatestPage' || query.kind === 'readOlderPage') {
          const page = validateDirectoryPage(response.result, 'Roost history page');
          if (page.checkpoint !== undefined && typeof page.checkpoint !== 'string')
            throw new Error('Roost history page checkpoint is malformed');
          if (incrementalEnabled() && page.checkpoint) hasIncrementalCheckpoint = true;
          const turns = validateHistory(response.pageTurns, 'Roost history page bodies');
          if (
            page.totalCount !== count ||
            turns.length !== page.rows.length ||
            turns.some((turn, index) => turn.id !== page.rows[index]?.turnId)
          ) {
            throw new Error('Roost page bodies and directory disagree');
          }
          turns.forEach((turn, index) => rememberBody(turn, page.startPosition + index));
          if (!replacingSnapshot)
            await cached(() => cache.acceptPage(page, turns, revision, response.historyChange));
        } else if (query.kind === 'readTurn' || query.kind === 'readAt') {
          const read = validateTurnRead(response.result, 'Roost turn read');
          if (read.state === 'ready')
            rememberBody(
              read.turn as SessionHistoryInput,
              query.kind === 'readAt' ? query.position : undefined
            );
        }
        if (
          disposed ||
          (!coherentProgress && (revision < ownerRevision || revision < observedHistoryRevision))
        ) {
          throw new HistoryRefreshSupersededError();
        }
        return response;
      })();
      pendingReads.set(key, next);
      void next.then(
        () => pendingReads.delete(key),
        () => pendingReads.delete(key)
      );
      return next;
    };
    const readHistory = async (query: SessionHistoryReadQuery): Promise<unknown> =>
      (await readOwner(query)).result;
    const canReadCache = async () => {
      const head = await cached(() => cache.getHead());
      if (head) {
        if (incrementalEnabled() && head.checkpoint) hasIncrementalCheckpoint = true;
        const changedOfflineSnapshot =
          ownerRevision === undefined &&
          seenCacheRevision !== undefined &&
          seenCacheRevision !== head.revision;
        seenCacheRevision = head.revision;
        if (head.revision > Math.max(ownerRevision ?? 0, observedHistoryRevision)) {
          await notifyChanged(undefined, head.revision, head.count);
        } else if (changedOfflineSnapshot) {
          bodies.clear();
          observedDirectoryEpoch += 1;
          for (const listener of listeners)
            listener({ kind: 'structure', from: 0, to: head.count });
        }
      }
      return head &&
        !replacingSnapshot &&
        (ownerRevision === undefined ||
          (incrementalEnabled() && head.checkpoint !== undefined) ||
          head.revision >= Math.max(ownerRevision, observedHistoryRevision))
        ? head
        : undefined;
    };

    const readCount = async (): Promise<number> => {
      const head = await canReadCache();
      if (head) return head.count;
      const result = await readHistory({ kind: 'count' });
      if (!Number.isSafeInteger(result) || (result as number) < 0) {
        throw new Error('Roost history count returned a malformed result');
      }
      return result as number;
    };

    const readDirectory = async (
      from: number,
      to: number
    ): Promise<readonly SessionDirectoryRow[]> => {
      const count = await readCount();
      from = Math.max(0, Math.min(from, count));
      to = Math.max(from, Math.min(to, count));
      if (await canReadCache()) {
        const stored = await cached(() => cache.readRows(from, to));
        if (stored) return stored.map((entry) => entry.row);
      }
      const rows: SessionDirectoryRow[] = [];
      for (let start = from; start < to; start += READ_PAGE_SIZE) {
        const end = Math.min(to, start + READ_PAGE_SIZE);
        const page = validateDirectory(
          await readHistory({ kind: 'readDirectory', from: start, to: end }),
          'Roost history directory read'
        );
        if (page.length !== end - start) {
          throw new HistoryDirectoryChangedDuringReadError(
            `Roost history directory returned ${page.length} rows for [${start}, ${end})`
          );
        }
        if (page.some((row, index) => row.position !== start + index)) {
          throw new HistoryDirectoryChangedDuringReadError(
            `Roost history directory positions changed while reading [${start}, ${end})`
          );
        }
        rows.push(...page);
      }
      return rows;
    };

    const readEntries = async (
      query: Extract<
        SessionHistoryReadQuery,
        { kind: 'readAll' | 'readTurnOutput' | 'readMetadata' }
      >
    ) => validateHistory(await readHistory(query), 'Roost history read');

    const readRange = async (from: number, to: number): Promise<readonly SessionTurnRead[]> => {
      if (await canReadCache()) {
        const stored = await cached(() => cache.readRows(from, to));
        if (stored)
          return stored.map((entry) => ({ state: 'ready', turn: entry.turn as SessionTurn }));
      }
      const reads: SessionTurnRead[] = [];
      for (let start = from; start < to; start += READ_PAGE_SIZE) {
        const end = Math.min(to, start + READ_PAGE_SIZE);
        const result = await readHistory({ kind: 'readRange', from: start, to: end });
        if (!Array.isArray(result) || result.length !== end - start) {
          throw new Error(`Roost history range returned an invalid page for [${start}, ${end})`);
        }
        reads.push(...result.map((item) => validateTurnRead(item, 'Roost history range read')));
      }
      return reads;
    };

    let observedHistoryRevision = 0;
    let observedHistoryCount: number | undefined;
    let latestChange: SessionHistoryChange | null | undefined;
    let observedDirectoryEpoch = 0;
    let notificationQueue: Promise<void> = Promise.resolve();
    const notifyChanged = (
      change?: SessionHistoryChange | null,
      revision?: number,
      count?: number
    ): Promise<void> => {
      const next = notificationQueue.then(async () => {
        if (disposed) return;
        if (revision !== undefined && revision <= observedHistoryRevision) return;

        if (
          incrementalEnabled() &&
          hasIncrementalCheckpoint &&
          !replacingSnapshot &&
          revision !== undefined
        ) {
          observedHistoryRevision = revision;
          if (count !== undefined) observedHistoryCount = count;
          latestChange = change;
          bodies.clear();
          scheduleRefresh();
          return;
        }
        const hasRevisionGap = revision !== undefined && revision !== observedHistoryRevision + 1;
        latestChange = change;
        if (hasRevisionGap || change === undefined) bodies.clear();
        else if (change?.kind === 'changed') for (const id of change.ids) bodies.delete(id);
        else if (change?.kind === 'structure') {
          for (const [id, entry] of bodies) {
            if (entry.position === undefined || entry.position >= change.from) bodies.delete(id);
          }
        }
        scheduleRefresh();
        if (revision === undefined || change === undefined || hasRevisionGap) {
          if (revision !== undefined) observedHistoryRevision = revision;
          observedHistoryCount = count ?? observedHistoryCount ?? 0;
          observedDirectoryEpoch += 1;
          for (const listener of listeners) {
            try {
              listener({ kind: 'structure', from: 0, to: observedHistoryCount });
            } catch (error) {
              console.error('Roost history observer failed', error);
            }
          }
          return;
        }

        observedHistoryRevision = revision;
        if (count !== undefined) observedHistoryCount = count;
        if (change === null) return;
        if (change.kind === 'structure') {
          observedDirectoryEpoch += 1;
          for (const listener of listeners) {
            try {
              listener(change);
            } catch (error) {
              console.error('Roost history observer failed', error);
            }
          }
        } else {
          for (const listener of listeners) {
            try {
              listener({ kind: 'changed', ids: [...change.ids] });
            } catch (error) {
              console.error('Roost history observer failed', error);
            }
          }
        }
      });
      notificationQueue = next.catch((error) => {
        console.error('Roost history change refresh failed', error);
      });
      return next;
    };

    const readDirectorySnapshot = async (
      query: Extract<SessionHistoryReadQuery, { kind: 'readLatestPage' | 'readOlderPage' }>
    ): Promise<{ page: SessionHistoryDirectoryPage; directoryEpoch: number | null }> => {
      const directoryEpoch = observedDirectoryEpoch;
      const before =
        query.kind === 'readOlderPage' ? parseRoostCacheCursor(query.cursor) : undefined;
      const localHead = await canReadCache();
      if (
        before &&
        localHead &&
        (before.revision > localHead.revision ||
          before.revision < (localHead.directoryRevision ?? localHead.revision))
      ) {
        observedDirectoryEpoch += 1;
        for (const listener of listeners)
          listener({ kind: 'structure', from: 0, to: localHead.count });
        throw new Error('Roost cached page cursor needs rebasing');
      }
      if ((query.kind === 'readLatestPage' || before) && localHead) {
        const stored = await cached(() => cache.readPage(query.limit, before));
        if (
          stored &&
          (ownerRevision === undefined ||
            (incrementalEnabled() && stored.head.checkpoint !== undefined) ||
            stored.head.revision >= Math.max(ownerRevision, observedHistoryRevision))
        ) {
          stored.turns.forEach((turn, index) =>
            rememberBody(turn, stored.page.startPosition + index)
          );
          if (ownerRevision === undefined) displayedCacheRevision = stored.head.revision;
          return { page: stored.page, directoryEpoch };
        }
      }
      if (before) {
        if (incrementalEnabled() && localHead?.checkpoint && !replacingSnapshot) {
          // A durable cursor already names an absolute edge. Read that window
          // directly at its checkpoint instead of walking from the latest page.
          const from = Math.max(0, before.end - query.limit);
          const response = await readOwner({
            kind: 'readRange',
            from,
            to: before.end,
            atCheckpoint: localHead.checkpoint,
          });
          if (
            response.historyRevision !== localHead.revision ||
            response.historyCount !== localHead.count ||
            !Array.isArray(response.result) ||
            response.result.length !== before.end - from
          )
            throw new HistoryRefreshSupersededError();
          const turns = response.result.map((value) => {
            const read = validateTurnRead(value, 'Roost cached page recovery');
            if (read.state !== 'ready') throw new Error('Roost cached page body is unavailable');
            return read.turn as SessionHistoryInput;
          });
          const page: SessionHistoryDirectoryPage = {
            checkpoint: localHead.checkpoint,
            startPosition: from,
            totalCount: localHead.count,
            rows: turns.map((turn, index) =>
              createRoostDirectoryRow(from + index, turn as SessionEntry)
            ),
            hasMoreOlder: from > 0,
            cursor: from > 0 ? roostCacheCursor(localHead.revision, from) : null,
          };
          await cached(() => cache.acceptPage(page, turns, localHead.revision));
          turns.forEach((turn, index) => rememberBody(turn, from + index));
          return { page, directoryEpoch };
        }
        // A durable cursor survives owner restarts. Resolve its absolute edge
        // through the existing reverse API if this replica lacks that page.
        let response = await readOwner({ kind: 'readLatestPage', limit: 40 });
        let page = validateDirectoryPage(response.result, 'Roost history page');
        if (response.historyRevision !== before.revision) {
          for (const listener of listeners)
            listener({ kind: 'structure', from: 0, to: page.totalCount });
          throw new Error('Roost cached page cursor needs rebasing');
        }
        const from = Math.max(0, before.end - query.limit);
        const rows = page.rows.filter((row) => row.position >= from && row.position < before.end);
        while (page.startPosition > from && page.cursor) {
          response = await readOwner({
            kind: 'readOlderPage',
            cursor: page.cursor,
            limit: Math.min(500, page.startPosition - from),
          });
          page = validateDirectoryPage(response.result, 'Roost history page');
          if (response.historyRevision !== before.revision) {
            throw new Error('Roost cached page cursor needs rebasing');
          }
          rows.unshift(
            ...page.rows.filter((row) => row.position >= from && row.position < before.end)
          );
        }
        if (
          rows.length !== before.end - from ||
          rows.some((row, index) => row.position !== from + index)
        ) {
          throw new Error('Roost cached page edge is stale');
        }
        return {
          page: {
            startPosition: from,
            totalCount: page.totalCount,
            rows,
            hasMoreOlder: from > 0,
            cursor: from > 0 ? roostCacheCursor(before.revision, from) : null,
          },
          directoryEpoch,
        };
      }
      const response = await readOwner(query);
      const page = validateDirectoryPage(response.result, 'Roost history page');
      return {
        page,
        // The reply covers its own notification. A coherent checkpoint can also
        // progress behind newer hints, while ordinary replies must still be current.
        directoryEpoch:
          (incrementalEnabled() && page.checkpoint) ||
          response.historyRevision === Math.max(ownerRevision ?? 0, observedHistoryRevision)
            ? observedDirectoryEpoch
            : null,
      };
    };

    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshTimerDelay = 0;
    let refreshing = false;
    let refreshRequested = false;
    let retryDelay = 250;
    let consecutiveSupersessions = 0;
    const refresh = async () => {
      if (!active()) return;
      if (disposed || refreshing || listeners.size === 0) return;
      refreshing = true;
      refreshRequested = false;
      try {
        const prior = await cached(() => cache.getHead());
        const checkpoint = prior?.checkpoint ?? prior?.recoveryCheckpoint;
        if (incrementalEnabled() && prior && !checkpoint) {
          // No verified interval remains. Establish a new bounded window;
          // unknown older bodies must not become a patch baseline.
          replacingSnapshot = true;
          bodies.clear();
        }
        if (incrementalEnabled() && prior && checkpoint) {
          const withPatches = patchesEnabled() && prior.checkpoint !== undefined;
          const response = await readOwner(
            watchEnabled() && prior.checkpoint
              ? {
                  kind: 'watchChanges',
                  checkpoint,
                  waitMs: 15_000,
                  includeBodiesFrom: prior.start,
                  ...(withPatches ? { withPatches: true as const } : {}),
                }
              : {
                  kind: 'readChanges',
                  checkpoint,
                  includeBodiesFrom: prior.start,
                  ...(withPatches ? { withPatches: true as const } : {}),
                }
          );
          const revision = response.historyRevision!;
          const count = response.historyCount!;
          const change = SessionHistoryChangesSchema.parse(response.result);
          if (
            change.state === 'ready' &&
            change.checkpoint === prior.checkpoint &&
            change.ids.length === 0 &&
            change.from === undefined &&
            response.historyRevision === prior.revision &&
            response.historyCount === prior.count
          ) {
            retryDelay = 0;
            consecutiveSupersessions = 0;
            return;
          }
          if (change.state === 'ready') {
            const from = change.from === undefined ? undefined : Math.min(change.from, count);
            const affected = (await cached(() => cache.readAffected(change.ids))) ?? [];
            const replacements: { position: number; turn: SessionHistoryInput }[] = [];
            const patches = new Map(
              withPatches && change.patches && change.patches.baseCheckpoint === prior.checkpoint
                ? change.patches.turns.map((patch) => [patch.turnId, patch.operations])
                : []
            );
            const changedBodies =
              change.bodies === undefined
                ? undefined
                : new Map(
                    validateHistory(change.bodies.changed, 'Roost incremental bodies').map(
                      (turn) => [turn.id, turn]
                    )
                  );
            for (const row of affected) {
              if (from !== undefined && row.position >= from) continue;
              const operations = patches.get(row.turnId);
              if (operations) {
                let prepared: SessionHistoryInput | undefined;
                try {
                  [prepared] = validateHistory(
                    [applySessionHistoryPatches(row.turn, operations)],
                    'Roost content patches'
                  );
                } catch {
                  // Keep the cached checkpoint; repair this body at the owner's target checkpoint.
                }
                if (prepared) {
                  replacements.push({ position: row.position, turn: prepared });
                  continue;
                }
              }
              if (changedBodies) {
                const turn = changedBodies.get(row.turnId);
                if (turn) {
                  replacements.push({ position: row.position, turn });
                  continue;
                }
                if (!change.patches?.turns.some((patch) => patch.turnId === row.turnId))
                  throw new Error('Roost incremental body is incomplete');
              }
              const read = await readOwner({
                kind: 'readTurn',
                turnId: row.turnId,
                atCheckpoint: change.checkpoint,
              });
              if (read.historyRevision !== revision) throw new HistoryRefreshSupersededError();
              const turn = validateTurnRead(read.result, 'Roost incremental body');
              if (turn.state !== 'ready' || turn.turn.id !== row.turnId)
                throw new Error('Roost incremental turn is unavailable');
              replacements.push({ position: row.position, turn: turn.turn as SessionHistoryInput });
            }
            const start =
              prior.start >= count && count > 0
                ? Math.max(0, count - 40)
                : Math.min(prior.start, count);
            if (change.bodies !== undefined) {
              const first = from === undefined ? undefined : Math.max(start, Math.min(from, count));
              const suffix = validateHistory(change.bodies.suffix, 'Roost incremental suffix');
              if (
                change.bodies.from !== first ||
                suffix.length !== (first === undefined ? 0 : count - first)
              )
                throw new Error('Roost incremental suffix is incomplete');
              suffix.forEach((turn, offset) =>
                replacements.push({ position: first! + offset, turn })
              );
            } else if (from !== undefined) {
              for (
                let position = Math.max(start, Math.min(from, count));
                position < count;
                position += READ_PAGE_SIZE
              ) {
                const read = await readOwner({
                  kind: 'readRange',
                  atCheckpoint: change.checkpoint,
                  from: position,
                  to: Math.min(count, position + READ_PAGE_SIZE),
                });
                if (read.historyRevision !== revision) throw new HistoryRefreshSupersededError();
                if (
                  !Array.isArray(read.result) ||
                  read.result.length !== Math.min(READ_PAGE_SIZE, count - position)
                )
                  throw new Error('Roost incremental range is incomplete');
                read.result.forEach((value, offset) => {
                  const turn = validateTurnRead(value, 'Roost incremental range');
                  if (turn.state !== 'ready')
                    throw new Error('Roost incremental range body is unavailable');
                  replacements.push({
                    position: position + offset,
                    turn: turn.turn as SessionHistoryInput,
                  });
                });
              }
            }
            if (change.bodies === undefined && revision < observedHistoryRevision)
              throw new HistoryRefreshSupersededError();
            const applied = await cached(() =>
              cache.applyChanges(
                prior,
                revision,
                count,
                change.checkpoint,
                from,
                replacements,
                !withPatches
              )
            );
            if (applied === undefined) throw new Error('Roost history cache is unavailable');
            if (!applied) throw new HistoryRefreshSupersededError();
            await notificationQueue;
            // The cache transaction committed this interval. A newer hint can
            // request catch-up, but must not suppress its view invalidations.
            if (disposed) return;
            hasIncrementalCheckpoint = true;
            replacingSnapshot = false;
            if (revision < (ownerRevision ?? 0) || revision < observedHistoryRevision)
              refreshRequested = true;
            displayedCacheRevision = revision;
            for (const replacement of replacements)
              rememberBody(replacement.turn, replacement.position);
            if (from !== undefined) {
              observedDirectoryEpoch += 1;
              for (const listener of listeners)
                listener({
                  kind: 'structure',
                  from: Math.min(from, count),
                  to: Math.max(prior.count, count),
                });
            }
            if (change.ids.length)
              for (const listener of listeners) listener({ kind: 'changed', ids: [...change.ids] });
            retryDelay = refreshRequested || watchEnabled() ? 0 : 250;
            consecutiveSupersessions = 0;
            // Complete checkpoint coverage repairs the retained window even
            // when older pages have never been loaded. Do not reread its tail.
            return;
          } else {
            // A reset rejects prefix coverage. Replace the readable window
            // atomically, then fetch invalidated older pages on demand.
            replacingSnapshot = true;
            bodies.clear();
            observedDirectoryEpoch += 1;
            for (const listener of listeners) listener({ kind: 'structure', from: 0, to: count });
          }
        }
        const delta = latestChange;
        const deltaRevision = observedHistoryRevision;
        const deltaCount = observedHistoryCount;
        if (
          !replacingSnapshot &&
          prior &&
          prior.revision + 1 === deltaRevision &&
          delta?.kind === 'changed' &&
          deltaCount !== undefined &&
          delta.ids.length <= 500
        ) {
          const responses = await Promise.all(
            delta.ids.map((turnId) => readOwner({ kind: 'readTurn', turnId }))
          );
          if (responses.every((response) => response.historyRevision === deltaRevision)) {
            const turns = responses.map((response, index) => {
              const read = validateTurnRead(response.result, 'Roost changed turn');
              if (read.state !== 'ready' || read.turn.id !== delta.ids[index])
                throw new Error('Changed history turn is unavailable');
              return read.turn as SessionHistoryInput;
            });
            const applied = await cached(() => cache.updateTurns(deltaRevision, deltaCount, turns));
            if (applied) {
              retryDelay = 250;
              consecutiveSupersessions = 0;
              return;
            }
          }
        }
        const response = await readOwner({ kind: 'readLatestPage', limit: 40 });
        const revision = response.historyRevision;
        const page = validateDirectoryPage(response.result, 'Roost refresh page');
        if (displayedCacheRevision !== undefined && displayedCacheRevision !== revision) {
          displayedCacheRevision = undefined;
          for (const listener of listeners)
            listener({ kind: 'structure', from: 0, to: page.totalCount });
        }
        const rebuilding = replacingSnapshot;
        if (replacingSnapshot) {
          const turns = validateHistory(response.pageTurns, 'Roost replacement window');
          const applied = await cached(() =>
            cache.acceptPage(page, turns, revision!, response.historyChange, prior)
          );
          if (applied === undefined) throw new Error('Roost history cache is unavailable');
          if (!applied) throw new HistoryRefreshSupersededError();
          replacingSnapshot = false;
          hasIncrementalCheckpoint = page.checkpoint !== undefined;
          if (revision! < Math.max(ownerRevision ?? 0, observedHistoryRevision))
            refreshRequested = true;
        }
        if (!disposed && rebuilding) {
          observedDirectoryEpoch += 1;
          for (const listener of listeners)
            listener({ kind: 'structure', from: 0, to: page.totalCount });
        }
        retryDelay = refreshRequested || watchEnabled() ? 0 : 250;
        consecutiveSupersessions = 0;
      } catch (error) {
        // Cached history remains readable. This retries connection recovery,
        // never a user command or an uncertain provider delivery.
        refreshRequested = true;
        if (isHistorySuperseded(error)) {
          consecutiveSupersessions += 1;
          retryDelay =
            consecutiveSupersessions <= 2 ? 0 : Math.min(10_000, Math.max(250, retryDelay) * 2);
        } else {
          consecutiveSupersessions = 0;
          retryDelay = Math.min(10_000, Math.max(250, retryDelay) * 2);
        }
      } finally {
        refreshing = false;
        if ((refreshRequested || watchEnabled()) && !disposed && listeners.size > 0 && active()) {
          refreshTimerDelay = retryDelay;
          refreshTimer = setTimeout(() => {
            refreshTimer = undefined;
            void refresh();
          }, retryDelay);
        }
      }
    };
    scheduleRefresh = () => {
      if (disposed || !active()) return;
      refreshRequested = true;
      if (refreshing || listeners.size === 0) return;
      if (refreshTimer) {
        // Keep repeated snapshot supersessions bounded while hints still
        // invalidate the live view. A recovery hint can shorten other retries.
        if (refreshTimerDelay === 0 || consecutiveSupersessions > 2) return;
        clearTimeout(refreshTimer);
      }
      refreshTimerDelay = 0;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void refresh();
      }, 0);
    };

    const readInitialDirectoryPage = async (): Promise<SessionHistoryDirectoryPage> => {
      let lastPage: SessionHistoryDirectoryPage | undefined;
      let attempt = 0;
      for (;;) {
        if (disposed) throw new Error('Roost session bridge is disposed');
        try {
          const snapshot = await readDirectorySnapshot({ kind: 'readLatestPage', limit: 40 });
          lastPage = snapshot.page;
          await notificationQueue;
          if (snapshot.directoryEpoch === observedDirectoryEpoch) return lastPage;
        } catch (error) {
          if (!isHistorySuperseded(error)) throw error;
        }
        if (++attempt >= INITIAL_DIRECTORY_READ_ATTEMPTS) {
          if (lastPage) return lastPage;
          attempt = 0;
          // Continuous writes can supersede a cold open. Retain this read owner
          // and yield before retrying; an ordinary supersession is not a UI fault.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
    };

    const unsubscribeWake = options.subscribeWake?.(scheduleRefresh);

    const history: SessionHistoryReader = {
      readMetadata: async () => {
        const head = await canReadCache();
        if (head?.start === 0) {
          const rows = await cached(() => cache.readCompleteDirectory(head));
          if (rows) return readSessionHistoryMetadata({ readDirectory: () => rows });
        }
        const entries = coherentInspectionEnabled()
          ? await readEntries({ kind: 'readMetadata' })
          : await history.readAll();
        return readSessionHistoryMetadata({
          readDirectory: () =>
            entries.map((entry, position) => createRoostDirectoryRow(position, entry)),
        });
      },
      count: readCount,
      async readAt(position) {
        if (await canReadCache()) {
          const stored = await cached(() => cache.readRows(position, position + 1));
          if (stored?.[0]) return { state: 'ready', turn: stored[0].turn as SessionTurn };
        }
        return validateTurnRead(
          await readHistory({ kind: 'readAt', position }),
          'Roost history readAt'
        );
      },
      async readTurn(turnId) {
        if (incrementalEnabled() && (await canReadCache())) {
          const stored = await cached(() => cache.readTurn(turnId));
          if (stored) return { state: 'ready', turn: stored as SessionTurn };
        }
        const body = bodies.get(turnId);
        if (body) return { state: 'ready', turn: structuredClone(body.turn) as SessionTurn };
        if (await canReadCache()) {
          const stored = await cached(() => cache.readTurn(turnId));
          if (stored) return { state: 'ready', turn: stored as SessionTurn };
        }
        return validateTurnRead(
          await readHistory({ kind: 'readTurn', turnId }),
          'Roost history readTurn'
        );
      },
      readRange,
      readDirectory,
      readLatestDirectoryPage: async (limit) =>
        (await readDirectorySnapshot({ kind: 'readLatestPage', limit })).page,
      readOlderDirectoryPage: async (cursor, limit) =>
        (await readDirectorySnapshot({ kind: 'readOlderPage', cursor, limit })).page,
      readAll: async () => {
        const head = await canReadCache();
        if (head?.start === 0) {
          const stored = await cached(() => cache.readRows(0, head.count));
          if (stored) return stored.map((row) => row.turn as SessionEntry);
        }
        return [...(await readEntries({ kind: 'readAll' }))] as SessionEntry[];
      },
      readTurnOutput: async (userTurnId) =>
        [...(await readEntries({ kind: 'readTurnOutput', userTurnId }))] as SessionEntry[],
      observe(listener) {
        if (disposed) {
          return {
            initial: Promise.reject(new Error('Roost session bridge is disposed')),
            unsubscribe: () => {},
          };
        }
        listeners.add(listener);
        const initialPage = readInitialDirectoryPage();
        scheduleRefresh();
        return {
          initial: initialPage.then((page) => page.rows),
          initialPage,
          unsubscribe: () => {
            listeners.delete(listener);
            if (listeners.size === 0 && refreshTimer) {
              clearTimeout(refreshTimer);
              refreshTimer = undefined;
            }
          },
        };
      },
    };

    const write = async (
      operation: SessionHistoryWriteOperation,
      payload: Record<string, unknown>
    ): Promise<unknown> => {
      if (disposed) throw new Error('Roost session bridge is disposed');
      assertSerializableHistoryPayload(operation, payload);
      const receipt = await transport.writeHistory(operation, payload);
      await notifyChanged(
        receipt.historyChange,
        receipt.historyRevision,
        receipt.historyCount
      ).catch((error) => {
        console.error('Roost history write notification failed', error);
      });
      return receipt.result;
    };

    const commands = {
      applyHistoryAction: async (action: HistoryAction): Promise<SessionActionResult> =>
        (await write('apply_action', { action })) as SessionActionResult,
      appendTurn: async (turn: SessionTurn): Promise<void> => {
        await write('append', { entry: turn });
      },
      replaceTurn: async (turnId: string, turn: SessionTurn): Promise<void> => {
        await write('replace', { turnId, entry: turn });
      },
      respondPermission: async (
        requestId: string,
        outcome: PermissionOutcome,
        commandOptions?: { readonly turnId?: string }
      ): Promise<boolean> =>
        Boolean(
          await write('respond_permission', {
            requestId,
            outcome,
            ...(commandOptions ? { options: commandOptions } : {}),
          })
        ),
      replaceEditableTail: async (
        _input: ReplaceEditableTailInput
      ): Promise<SessionEditableTailResult> =>
        // The compensation closure returned by this command is an in-process
        // capability and cannot cross IPC/RPC. The product edit-and-resend path
        // uses its dedicated session RPC; the generic command reports the same
        // explicit unsupported result promised by the SessionData contract.
        ({ status: 'rejected', reason: { code: 'unsupported' } }),
      applyHistoryImport: async (input: HistoryImportInput): Promise<SessionImportResult> =>
        (await write('apply_import', { input })) as SessionImportResult,
    };

    const snapshots: SessionSnapshotService = {
      capture: async (): Promise<SessionSnapshot> => {
        const snapshot = Object.freeze({
          history: [...(await readEntries({ kind: 'readAll' }))],
        }) as unknown as SessionSnapshot;
        snapshotProvenance.add(snapshot);
        return snapshot;
      },
      copyFrom: async (snapshot, selection): Promise<void> => {
        if (!snapshotProvenance.has(snapshot)) throw new Error('Invalid Roost snapshot provenance');
        const sourceIds = new Set(
          (snapshot.history as readonly SessionHistoryInput[]).map((entry) => entry.id)
        );
        if (selection.some((entry) => !sourceIds.has(entry.id))) {
          throw new Error('Fork selection is not from the captured snapshot');
        }
        await write('copy_history', { history: selection });
      },
    };

    const sessionData = createRoostSessionData({
      sessionId,
      history,
      commands,
      snapshots,
      inputAcceptance: {
        targetMachineId,
        accept: async (entry) =>
          validateInputAcceptance(await write('accept_input', { entry }), entry.id),
        acceptAndDispatch: async (entry) =>
          validateInputAcceptance(await write('accept_input_and_dispatch', { entry }), entry.id),
        lookup: async (entry) =>
          validateInputAcceptance(await readHistory({ kind: 'inputAcceptance', entry }), entry.id),
      },
      dispose: () => {
        disposed = true;
        unsubscribeWake?.();
        if (refreshTimer) clearTimeout(refreshTimer);
        bodies.clear();
        cache.dispose();
        listeners.clear();
      },
    });
    return sessionData as RoostSessionData;
  };

const historyCacheScope = (options: LocalRoostSessionBridgeOptions, sessionId: SessionId) =>
  JSON.stringify([options.accountId ?? 'local', options.workspaceId, options.machineId, sessionId]);

function localHistoryTransport(
  options: LocalRoostSessionBridgeOptions,
  sessionId: SessionId
): RoostHistoryTransport {
  const send = options.sendControl ?? sendLocalSessionControl;
  return {
    readHistory: async (query) => {
      const request: LocalSessionControlRequest = {
        type: 'session/history-read',
        machineId: options.machineId,
        workspaceId: options.workspaceId,
        sessionId,
        query,
      };
      const result = await send(request);
      if (!result.ok) throw new Error(`Roost history read failed: ${result.error}`);
      const response = result.responses.find(
        (item): item is HistoryReadResponse =>
          item.type === 'session/history-read_response' && item.sessionId === sessionId
      );
      if (!response) throw new Error('Roost history read returned no response');
      if (!response.success)
        throw new RoostHistoryError('read', response.error ?? '', response.retryReason);
      return response;
    },
    writeHistory: async (operation, payload) => {
      const request: LocalSessionControlRequest = {
        type: 'session/history-write',
        machineId: options.machineId,
        workspaceId: options.workspaceId,
        sessionId,
        operation,
        payload,
      };
      const result = await send(request);
      if (!result.ok) throw new Error(`Roost history write failed: ${result.error}`);
      const response = result.responses.find(
        (item): item is HistoryWriteResponse =>
          item.type === 'session/history-write_response' &&
          item.sessionId === sessionId &&
          item.operation === operation
      );
      if (!response) throw new Error(`Roost history write returned no ${operation} response`);
      if (!response.success) throw new RoostHistoryError('write', response.error ?? '');
      return {
        result: response.result,
        historyRevision: response.historyRevision,
        historyCount: response.historyCount,
        historyChange: response.historyChange,
      };
    },
  };
}

function remoteHistoryTransport(
  options: RemoteRoostSessionBridgeOptions,
  sessionId: SessionId
): RoostHistoryTransport {
  return {
    readHistory: async (query) => {
      const response = await options.requestHistoryRead(options.machineId, sessionId, query);
      if (response.sessionId !== sessionId) {
        throw new Error('Roost history read response targeted a different session');
      }
      if (response.rpcFailure) {
        throw new SessionHistoryRequestError('read', response.rpcFailure, response.error ?? '');
      }
      if (!response.success)
        throw new RoostHistoryError('read', response.error ?? '', response.retryReason);
      return response;
    },
    writeHistory: async (operation, payload) => {
      const response = await options.requestHistoryWrite({
        machineId: options.machineId,
        sessionId,
        operation,
        payload,
      });
      if (response.sessionId !== sessionId || response.operation !== operation) {
        throw new Error('Roost history write response targeted a different operation');
      }
      if (response.rpcFailure) {
        throw new SessionHistoryRequestError('write', response.rpcFailure, response.error ?? '');
      }
      if (!response.success) throw new RoostHistoryError('write', response.error ?? '');
      return {
        result: response.result,
        historyRevision: response.historyRevision,
        historyCount: response.historyCount,
        historyChange: response.historyChange,
      };
    },
  };
}

/** Renderer bridge for an owner reached through the local Electron process. */
export function createLocalRoostSessionDataFactory(
  options: LocalRoostSessionBridgeOptions
): ConversationSessionDataFactory {
  return createRoostSessionDataFactoryFromTransport(
    (sessionId) => localHistoryTransport(options, sessionId),
    (sessionId) => historyCacheScope(options, sessionId),
    options.machineId,
    options
  );
}

/** Renderer bridge for an owner reached through encrypted Machine RPC. */
export function createRemoteRoostSessionDataFactory(
  options: RemoteRoostSessionBridgeOptions
): ConversationSessionDataFactory {
  return createRoostSessionDataFactoryFromTransport(
    (sessionId) => remoteHistoryTransport(options, sessionId),
    (sessionId) => historyCacheScope(options, sessionId),
    options.machineId,
    options
  );
}

/** Keep the owner fixed while resolving its current local/cloud transport per operation. */
export function createRoostSessionDataFactoryForMachine(
  options: LocalRoostSessionBridgeOptions &
    RemoteRoostSessionBridgeOptions & {
      readonly resolvePlane: (machineId: MachineId) => Promise<'local' | 'cloud'>;
    }
): ConversationSessionDataFactory {
  return createRoostSessionDataFactoryFromTransport(
    (sessionId) => {
      const local = localHistoryTransport(options, sessionId);
      const remote = remoteHistoryTransport(options, sessionId);
      const transport = async () => {
        const plane = await options.resolvePlane(options.machineId);
        if (plane === 'local') return local;
        if (plane === 'cloud') return remote;
        throw new Error('Roost history target transport is unresolved');
      };
      return {
        readHistory: async (query) => (await transport()).readHistory(query),
        writeHistory: async (operation, payload) =>
          (await transport()).writeHistory(operation, payload),
      };
    },
    (sessionId) => historyCacheScope(options, sessionId),
    options.machineId,
    options
  );
}
