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
  SessionHistoryWriteResponse,
  SessionId,
  WorkspaceId,
} from '@lody/shared';
import {
  createRoostSessionData,
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
} from '@lody/shared/session-data';
import { sendLocalSessionControl } from './electron-ipc-client';
import {
  createRoostHistoryCache,
  parseRoostCacheCursor,
  roostCacheCursor,
} from './roost-history-cache';
import type { ConversationSessionDataFactory } from './conversation-view/create-conversation-session';
import type { SessionSnapshotService } from '@lody/shared/session-data';
import { SessionHistoryChangeSchema } from '@lody/shared';

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

export type LocalRoostSessionBridgeOptions = {
  readonly accountId?: string | null;
  readonly workspaceId: WorkspaceId;
  readonly machineId: MachineId;
  readonly sendControl?: typeof sendLocalSessionControl;
};

export type RemoteRoostSessionBridgeOptions = {
  readonly accountId?: string | null;
  readonly workspaceId: WorkspaceId;
  readonly machineId: MachineId;
  readonly requestHistoryRead: (
    machineId: MachineId,
    sessionId: SessionId,
    query: SessionHistoryReadQuery
  ) => Promise<SessionHistoryReadResponse>;
  readonly requestHistoryWrite: (args: {
    readonly machineId: MachineId;
    readonly sessionId: SessionId;
    readonly operation: SessionHistoryWriteOperation;
    readonly payload: Record<string, unknown>;
  }) => Promise<SessionHistoryWriteResponse>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

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
    cacheScope: (sessionId: SessionId) => string
  ): ConversationSessionDataFactory =>
  ({ sessionId, doc }) => {
    const transport = createTransport(sessionId);
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
    let displayedCacheRevision: number | undefined;
    let seenCacheRevision: number | undefined;
    let scheduleRefresh = () => {};
    const pendingReads = new Map<string, Promise<SessionHistoryReadResponse>>();
    const listeners = new Set<SessionDataChangeListener>();
    const snapshotProvenance = new WeakSet<object>();

    const readOwner = (query: SessionHistoryReadQuery): Promise<SessionHistoryReadResponse> => {
      const key = JSON.stringify(query);
      const pending = pendingReads.get(key);
      if (pending) return pending;
      const next = (async () => {
        if (disposed) throw new Error('Roost session bridge is disposed');
        const response = await transport.readHistory(query);
        if (disposed) throw new Error('Roost session bridge is disposed');
        const revision = response.historyRevision;
        const count = response.historyCount;
        if (
          revision === undefined ||
          count === undefined ||
          !Number.isSafeInteger(revision) ||
          !Number.isSafeInteger(count)
        ) {
          throw new Error('Roost history read has no durable observation');
        }
        if (ownerRevision !== undefined && revision < ownerRevision) {
          throw new Error('Roost history read was superseded');
        }
        const firstOwnerObservation = ownerRevision === undefined;
        if (firstOwnerObservation) bodies.clear();
        ownerRevision = revision;
        await notifyChanged(response.historyChange, revision, count);
        if (disposed || revision < ownerRevision || revision < observedHistoryRevision) {
          throw new Error('Roost history read was superseded');
        }
        if (firstOwnerObservation) {
          // Cached bootstrap can overlap this reply even if the control doc
          // already advertised the same revision before this view opened.
          observedDirectoryEpoch += 1;
          for (const listener of listeners) listener({ kind: 'structure', from: 0, to: count });
        }
        if (query.kind === 'readLatestPage' || query.kind === 'readOlderPage') {
          const page = validateDirectoryPage(response.result, 'Roost history page');
          const turns = validateHistory(response.pageTurns, 'Roost history page bodies');
          if (
            page.totalCount !== count ||
            turns.length !== page.rows.length ||
            turns.some((turn, index) => turn.id !== page.rows[index]?.turnId)
          ) {
            throw new Error('Roost page bodies and directory disagree');
          }
          turns.forEach((turn, index) => rememberBody(turn, page.startPosition + index));
          await cached(() => cache.acceptPage(page, turns, revision, response.historyChange));
        } else if (query.kind === 'readTurn' || query.kind === 'readAt') {
          const read = validateTurnRead(response.result, 'Roost turn read');
          if (read.state === 'ready')
            rememberBody(
              read.turn as SessionHistoryInput,
              query.kind === 'readAt' ? query.position : undefined
            );
        }
        if (disposed || revision < ownerRevision || revision < observedHistoryRevision) {
          throw new Error('Roost history read was superseded');
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
        (ownerRevision === undefined ||
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
      query: Extract<SessionHistoryReadQuery, { kind: 'readAll' | 'readTurnOutput' }>
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

    const readCursor = (): {
      readonly revision?: number;
      readonly count?: number;
      readonly change?: SessionHistoryChange | null;
    } => {
      const state = doc.getMap('roostHistoryCursor').toJSON();
      if (!isRecord(state)) return {};
      const revision =
        typeof state.historyRevision === 'number' && Number.isSafeInteger(state.historyRevision)
          ? state.historyRevision
          : undefined;
      const count =
        typeof state.historyCount === 'number' && Number.isSafeInteger(state.historyCount)
          ? state.historyCount
          : undefined;
      let change: SessionHistoryChange | null | undefined;
      if (typeof state.historyChangeJson === 'string' && state.historyChangeJson.length > 0) {
        try {
          const parsed = SessionHistoryChangeSchema.nullable().safeParse(
            JSON.parse(state.historyChangeJson)
          );
          if (parsed.success) change = parsed.data;
        } catch {
          change = undefined;
        }
      }
      return { revision, count, change };
    };

    const initialCursor = readCursor();
    let observedHistoryRevision = initialCursor.revision ?? 0;
    let observedHistoryCount = initialCursor.count;
    let latestChange = initialCursor.change;
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
          observedHistoryCount = count ?? readCursor().count ?? observedHistoryCount ?? 0;
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

    const readDirectoryPage = async (
      query: Extract<SessionHistoryReadQuery, { kind: 'readLatestPage' | 'readOlderPage' }>
    ): Promise<SessionHistoryDirectoryPage> => {
      const before =
        query.kind === 'readOlderPage' ? parseRoostCacheCursor(query.cursor) : undefined;
      const localHead = await canReadCache();
      if (before && localHead && before.revision !== localHead.revision) {
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
            stored.head.revision >= Math.max(ownerRevision, observedHistoryRevision))
        ) {
          stored.turns.forEach((turn, index) =>
            rememberBody(turn, stored.page.startPosition + index)
          );
          if (ownerRevision === undefined) displayedCacheRevision = stored.head.revision;
          return stored.page;
        }
      }
      if (before) {
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
          startPosition: from,
          totalCount: page.totalCount,
          rows,
          hasMoreOlder: from > 0,
          cursor: from > 0 ? roostCacheCursor(before.revision, from) : null,
        };
      }
      return validateDirectoryPage(await readHistory(query), 'Roost history page');
    };

    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshing = false;
    let refreshRequested = false;
    let retryDelay = 250;
    const refresh = async () => {
      if (disposed || refreshing || listeners.size === 0) return;
      refreshing = true;
      refreshRequested = false;
      try {
        const prior = await cached(() => cache.getHead());
        const delta = latestChange;
        const deltaRevision = observedHistoryRevision;
        const deltaCount = observedHistoryCount;
        if (
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
            if (applied && prior.start === 0) {
              retryDelay = 250;
              return;
            }
          }
        }
        let response = await readOwner({ kind: 'readLatestPage', limit: 40 });
        const revision = response.historyRevision;
        let page = validateDirectoryPage(response.result, 'Roost refresh page');
        if (displayedCacheRevision !== undefined && displayedCacheRevision !== revision) {
          displayedCacheRevision = undefined;
          for (const listener of listeners)
            listener({ kind: 'structure', from: 0, to: page.totalCount });
        }
        // Populate the durable replica by bounded pages after the first window
        // is available. Keep the previous coherent snapshot during a revision
        // gap; publication of the replacement is atomic in the cache.
        let head = await cached(() => cache.getHead());
        const rebuilding = prior?.revision !== revision && head?.revision !== revision;
        for (;;) {
          if (
            disposed ||
            listeners.size === 0 ||
            !page.cursor ||
            (head && head.revision === revision && head.start === 0)
          )
            break;
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          response = await readOwner({ kind: 'readOlderPage', cursor: page.cursor, limit: 40 });
          if (response.historyRevision !== revision)
            throw new Error('History refresh was superseded');
          page = validateDirectoryPage(response.result, 'Roost refresh page');
          head = await cached(() => cache.getHead());
        }
        if (!disposed && head?.start === 0 && (!prior || prior.start > 0 || rebuilding)) {
          // Wake readers that previously failed on an uncached old body,
          // including a search or fact scan with no remaining visible page work.
          observedDirectoryEpoch += 1;
          for (const listener of listeners)
            listener({ kind: 'structure', from: 0, to: head.count });
        }
        retryDelay = 250;
      } catch {
        // Cached history remains readable. This retries connection recovery,
        // never a user command or an uncertain provider delivery.
        refreshRequested = true;
        retryDelay = Math.min(10_000, retryDelay * 2);
      } finally {
        refreshing = false;
        if (refreshRequested && !disposed && listeners.size > 0) {
          refreshTimer = setTimeout(() => {
            refreshTimer = undefined;
            void refresh();
          }, retryDelay);
        }
      }
    };
    scheduleRefresh = () => {
      if (disposed) return;
      refreshRequested = true;
      if (refreshing || refreshTimer || listeners.size === 0) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void refresh();
      }, 0);
    };

    const readInitialDirectoryPage = async (): Promise<SessionHistoryDirectoryPage> => {
      let lastPage: SessionHistoryDirectoryPage | undefined;
      for (let attempt = 0; attempt < INITIAL_DIRECTORY_READ_ATTEMPTS; attempt += 1) {
        const directoryEpoch = observedDirectoryEpoch;
        lastPage = await readDirectoryPage({ kind: 'readLatestPage', limit: 40 });
        await notificationQueue;
        if (directoryEpoch === observedDirectoryEpoch) return lastPage;
      }

      // Notifications remain queued for the view; the final page is a bounded
      // snapshot and any later structural event refreshes it.
      if (lastPage) return lastPage;
      throw new Error('Roost history changed before an initial page could be read');
    };

    const unsubscribeDoc = doc.subscribe((batch) => {
      if (batch.events.some((event) => String(event.path[0]) === 'roostHistoryCursor')) {
        const cursor = readCursor();
        void notifyChanged(cursor.change, cursor.revision, cursor.count).catch((error) => {
          console.error('Roost history cursor notification failed', error);
        });
      }
    });

    const history: SessionHistoryReader = {
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
        await readDirectoryPage({ kind: 'readLatestPage', limit }),
      readOlderDirectoryPage: async (cursor, limit) =>
        await readDirectoryPage({ kind: 'readOlderPage', cursor, limit }),
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
      dispose: () => {
        disposed = true;
        unsubscribeDoc();
        if (refreshTimer) clearTimeout(refreshTimer);
        bodies.clear();
        cache.dispose();
        listeners.clear();
      },
    });
    return sessionData as RoostSessionData;
  };

/** Renderer bridge for a Roost owner running in the local Electron process. */
export function createLocalRoostSessionDataFactory(
  options: LocalRoostSessionBridgeOptions
): ConversationSessionDataFactory {
  const send = options.sendControl ?? sendLocalSessionControl;
  return createRoostSessionDataFactoryFromTransport(
    (sessionId) => ({
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
        if (!response.success) throw new Error(response.error ?? 'Roost history read failed');
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
        if (!response.success) throw new Error(response.error ?? `Roost ${operation} failed`);
        return {
          result: response.result,
          historyRevision: response.historyRevision,
          historyCount: response.historyCount,
          historyChange: response.historyChange,
        };
      },
    }),
    (sessionId) =>
      JSON.stringify([
        options.accountId ?? 'local',
        options.workspaceId,
        options.machineId,
        sessionId,
      ])
  );
}

/** Renderer bridge for a Roost owner reached through encrypted Machine RPC. */
export function createRemoteRoostSessionDataFactory(
  options: RemoteRoostSessionBridgeOptions
): ConversationSessionDataFactory {
  return createRoostSessionDataFactoryFromTransport(
    (sessionId) => ({
      readHistory: async (query) => {
        const response = await options.requestHistoryRead(options.machineId, sessionId, query);
        if (response.sessionId !== sessionId) {
          throw new Error('Roost history read response targeted a different session');
        }
        if (!response.success) throw new Error(response.error ?? 'Roost history read failed');
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
        if (!response.success) throw new Error(response.error ?? `Roost ${operation} failed`);
        return {
          result: response.result,
          historyRevision: response.historyRevision,
          historyCount: response.historyCount,
          historyChange: response.historyChange,
        };
      },
    }),
    (sessionId) =>
      JSON.stringify([
        options.accountId ?? 'local',
        options.workspaceId,
        options.machineId,
        sessionId,
      ])
  );
}
