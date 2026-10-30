import {
  SessionHistoryChangesSchema,
  type SessionHistoryReadQuery,
  type SessionHistoryReadResponse,
  type SessionHistoryWriteOperation,
  type SessionHistoryWriteResponse,
} from '@lody/shared';
import {
  createRoostSessionData,
  type SessionActionResult,
  type SessionDataChangeListener,
  type SessionHistoryDirectoryPage,
  type SessionHistoryReader,
  type SessionImportResult,
  type SessionTurnRead,
  historyQueryRow,
  type HistoryQueryRow,
  type SessionHistoryMetadata,
  readSessionHistoryMetadata,
  createRoostDirectoryRow,
} from '@lody/shared/session-data';
import type { SessionDocument } from '@/lib/loro/doc';
import type { RoostSessionBackendServices } from './roost-session-backend';

/** A command client has no native history owner, even when it runs on that machine. */
export type RoostSessionRpc = {
  readonly inspection?: boolean;
  read(query: SessionHistoryReadQuery): Promise<SessionHistoryReadResponse>;
  write(
    operation: SessionHistoryWriteOperation,
    payload: Record<string, unknown>
  ): Promise<SessionHistoryWriteResponse>;
};

export function createRoostRpcSessionServices(
  doc: SessionDocument,
  rpc: RoostSessionRpc
): RoostSessionBackendServices {
  const listeners = new Set<Parameters<SessionHistoryReader['observe']>[0]>();
  const readResponse = async (query: SessionHistoryReadQuery) => {
    if (disposed) throw new Error('Owner history reader is disposed');
    const response = await rpc.read(query);
    if (!response.success || response.sessionId !== doc.sessionId || response.result === undefined)
      throw Object.assign(new Error(response.error ?? 'Owner history read failed'), {
        code: response.retryReason === 'superseded' ? 'superseded' : 'history_read_failed',
      });
    return response;
  };
  const readResult = async <T>(query: SessionHistoryReadQuery): Promise<T> =>
    (await readResponse(query)).result as T;
  const readRange = async <T>(
    kind: 'readRange' | 'readDirectory',
    from: number,
    to: number
  ): Promise<T[]> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const count = await readResponse({ kind: 'count' });
      const end = Math.min(to, count.result as number);
      const result: T[] = [];
      let changed = false;
      for (let start = Math.max(0, from); start < end; start += 500) {
        const page = await readResponse({ kind, from: start, to: Math.min(start + 500, end) });
        if (page.historyRevision !== count.historyRevision) {
          changed = true;
          break;
        }
        if (!Array.isArray(page.result)) throw new Error('Owner history range is unavailable');
        result.push(...(page.result as T[]));
      }
      if (!changed) return result;
    }
    throw new Error('Owner history changed during the read');
  };
  const notify = (change: Parameters<SessionDataChangeListener>[0]) => {
    for (const listener of listeners) {
      try {
        listener(change);
      } catch (error) {
        console.error('Owner history observer failed', error);
      }
    }
  };
  const write = async <T>(
    operation: SessionHistoryWriteOperation,
    payload: Record<string, unknown>
  ): Promise<T> => {
    if (disposed) throw new Error('Owner history reader is disposed');
    const response = await rpc.write(operation, payload);
    if (
      !response.success ||
      response.sessionId !== doc.sessionId ||
      response.operation !== operation
    )
      throw new Error(response.error ?? 'Owner history write failed');
    const change = response.historyChange ?? {
      kind: 'structure' as const,
      from: 0,
      to: response.historyCount ?? (await readResult<number>({ kind: 'count' })),
    };
    notify(change);
    return response.result as T;
  };
  let disposed = false;
  let checkpoint: string | undefined;
  let watchRevision = -1;
  let watching = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const observeHead = (response: SessionHistoryReadResponse, next: string) => {
    if ((response.historyRevision ?? -1) < watchRevision) return;
    watchRevision = response.historyRevision ?? watchRevision;
    checkpoint = next;
  };
  const startWatch = () => {
    if (disposed || !listeners.size || watching || retry || !checkpoint) return;
    watching = true;
    const from = checkpoint;
    let delay = 0;
    void (async () => {
      const response = await readResponse({
        kind: 'watchChanges',
        checkpoint: from,
        waitMs: 15_000,
      });
      if (disposed || !listeners.size) return;
      const change = SessionHistoryChangesSchema.parse(response.result);
      observeHead(response, change.checkpoint);
      if (change.state === 'reset') {
        notify({ kind: 'structure', from: 0, to: response.historyCount ?? 0 });
      } else {
        if (change.from !== undefined)
          notify({ kind: 'structure', from: change.from, to: response.historyCount ?? 0 });
        if (change.ids.length) notify({ kind: 'changed', ids: change.ids });
      }
    })()
      .catch((error) => {
        delay = 250;
        if (!disposed && listeners.size) console.error('Owner history observation failed', error);
      })
      .finally(() => {
        watching = false;
        if (!disposed && listeners.size)
          retry = setTimeout(() => {
            retry = undefined;
            startWatch();
          }, delay);
      });
  };
  const history: SessionHistoryReader = {
    readMetadata: () =>
      observe(async (revision, count, atCheckpoint) => {
        const result: SessionHistoryMetadata[] = [];
        for (let from = 0; from < count; from += 40) {
          const response = await readResponse({
            kind: rpc.inspection ? 'readDirectory' : 'readRange',
            from,
            to: Math.min(count, from + 40),
            atCheckpoint,
          });
          if (response.historyRevision !== revision) throw superseded();
          const rows = rpc.inspection
            ? (response.result as import('@lody/shared/session-data').SessionDirectoryRow[])
            : (response.result as SessionTurnRead[]).map((value, index) =>
                value.state === 'ready'
                  ? createRoostDirectoryRow(from + index, value.turn)
                  : { position: from + index, state: 'invalid' as const }
              );
          if (rows.every((row) => row.metadataVersion === 1 || row.state !== 'ready')) {
            result.push(...(await readSessionHistoryMetadata({ readDirectory: () => rows })));
          } else {
            const bodies = await readResponse({
              kind: 'readRange',
              from,
              to: Math.min(count, from + 40),
              atCheckpoint,
            });
            if (bodies.historyRevision !== revision) throw superseded();
            const directory = (bodies.result as SessionTurnRead[]).map((read, index) =>
              read.state === 'ready'
                ? createRoostDirectoryRow(from + index, read.turn)
                : { position: from + index, state: 'invalid' as const }
            );
            result.push(...(await readSessionHistoryMetadata({ readDirectory: () => directory })));
          }
        }
        return result;
      }),
    count: () => readResult<number>({ kind: 'count' }),
    readAt: (position) => readResult<SessionTurnRead>({ kind: 'readAt', position }),
    readTurn: (turnId) => readResult<SessionTurnRead>({ kind: 'readTurn', turnId }),
    readRange: (from, to) => readRange('readRange', from, to),
    readDirectory: (from, to) => readRange('readDirectory', from, to),
    readLatestDirectoryPage: (limit) => readResult({ kind: 'readLatestPage', limit }),
    readOlderDirectoryPage: (cursor, limit) => readResult({ kind: 'readOlderPage', cursor, limit }),
    readAll: () => readResult({ kind: 'readAll' }),
    readTurnOutput: (userTurnId) => readResult({ kind: 'readTurnOutput', userTurnId }),
    observe(listener) {
      listeners.add(listener);
      const initialPage = readResponse({
        kind: 'readLatestPage',
        limit: 40,
        withCheckpoint: true,
      }).then((response) => {
        const page = response.result as SessionHistoryDirectoryPage;
        if (!page.checkpoint) throw new Error('Owner history checkpoint is unavailable');
        observeHead(response, page.checkpoint);
        startWatch();
        return page;
      });
      return {
        initial: initialPage.then((page) => page.rows),
        initialPage,
        unsubscribe: () => {
          listeners.delete(listener);
          if (!listeners.size && retry) {
            clearTimeout(retry);
            retry = undefined;
          }
        },
      };
    },
  };
  const superseded = () =>
    Object.assign(new Error('Owner history observation was superseded'), { code: 'superseded' });
  const observation = async () => {
    const response = await readResponse(
      rpc.inspection
        ? { kind: 'count', withCheckpoint: true }
        : { kind: 'readLatestPage', limit: 1, withCheckpoint: true }
    );
    const value = response.result as { count?: number; totalCount?: number; checkpoint?: string };
    const count = rpc.inspection ? value.count : value.totalCount;
    if (
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      typeof value.checkpoint !== 'string' ||
      !value.checkpoint
    )
      throw new Error('Owner history checkpoint is unavailable');
    return { revision: response.historyRevision, count, checkpoint: value.checkpoint };
  };
  // The opaque checkpoint also binds generation changes whose revision/count
  // can be equal. Older owners supply it through their existing one-row page.
  const observe = async <T>(
    work: (revision: number | undefined, count: number, checkpoint: string) => Promise<T>
  ): Promise<T> => {
    for (let attempt = 0; attempt < 3; attempt++)
      try {
        const before = await observation();
        const result = await work(before.revision, before.count, before.checkpoint);
        const after = await observation();
        if (
          before.checkpoint === after.checkpoint &&
          before.revision === after.revision &&
          before.count === after.count
        )
          return result;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 'superseded' ||
          attempt === 2
        )
          throw error;
      }
    throw superseded();
  };
  const queryRows = async (
    revision: number | undefined,
    count: number,
    atCheckpoint: string,
    options?: { from?: number; to?: number; transcriptVisibility?: boolean }
  ) => {
    const rows: HistoryQueryRow[] = [];
    const end = Math.min(options?.to ?? count, count);
    const pageSize = rpc.inspection ? 500 : 1;
    for (let from = Math.max(0, options?.from ?? 0); from < end; from += pageSize) {
      const response = await readResponse(
        rpc.inspection
          ? {
              kind: 'readQuery',
              from,
              to: Math.min(end, from + pageSize),
              transcriptVisibility: options?.transcriptVisibility,
              atCheckpoint,
            }
          : { kind: 'readRange', from, to: Math.min(end, from + pageSize), atCheckpoint }
      );
      if (response.historyRevision !== revision) throw superseded();
      if (!Array.isArray(response.result)) throw new Error('Owner history query is unavailable');
      if (rpc.inspection) rows.push(...(response.result as HistoryQueryRow[]));
      else
        for (const read of response.result as SessionTurnRead[]) {
          if (read.state !== 'ready') throw new Error('Owner history query is incomplete');
          rows.push(
            historyQueryRow(
              read.turn,
              {
                field: (value, key) =>
                  value && typeof value === 'object' ? Reflect.get(value, key) : undefined,
                scalar: (value) => value,
                length: (value) => (Array.isArray(value) ? value.length : 0),
                at: (value, index) => (value as unknown[])[index],
              },
              options?.transcriptVisibility
            )
          );
        }
    }
    return rows;
  };
  const unsupported = async (): Promise<never> => {
    throw new Error('Agent execution requires the session history owner');
  };
  return {
    readHistoryQuery: (options) =>
      observe((revision, count, atCheckpoint) => queryRows(revision, count, atCheckpoint, options)),
    readHistorySelection: (select, options) =>
      observe(async (revision, count, atCheckpoint) => {
        const query = await queryRows(revision, count, atCheckpoint, options);
        if (!query) throw superseded();
        const bodies: import('@lody/shared').SessionHistoryInput[] = [];
        for (const position of select(query)) {
          if (!Number.isSafeInteger(position) || position < 0 || position >= count)
            throw new Error('Invalid history selection');
          const response = await readResponse({
            kind: 'readRange',
            from: position,
            to: position + 1,
            atCheckpoint,
          });
          if (response.historyRevision !== revision) throw superseded();
          const [read] = response.result as SessionTurnRead[];
          if (!read || read.state !== 'ready')
            throw new Error('Owner history selection is incomplete');
          bodies.push(read.turn as import('@lody/shared').SessionHistoryInput);
        }
        return bodies;
      }),
    foldHistory: (create, visit) =>
      observe(async (revision, count, atCheckpoint) => {
        const state = create();
        for (let from = 0; from < count; from += 1) {
          const response = await readResponse({
            kind: 'readRange',
            from,
            to: Math.min(count, from + 1),
            atCheckpoint,
          });
          if (response.historyRevision !== revision) throw superseded();
          for (const read of response.result as SessionTurnRead[]) {
            if (read.state !== 'ready') throw new Error('Owner history traversal is incomplete');
            visit(state, read.turn as import('@lody/shared').SessionHistoryInput);
          }
        }
        return state;
      }),
    sessionData: createRoostSessionData({
      sessionId: doc.sessionId,
      history,
      commands: {
        applyHistoryAction: (action) => write<SessionActionResult>('apply_action', { action }),
        appendTurn: (entry) => write<void>('append', { entry }),
        replaceTurn: (turnId, entry) => write<void>('replace', { turnId, entry }),
        respondPermission: (requestId, outcome, options) =>
          write<boolean>('respond_permission', { requestId, outcome, options }),
        applyHistoryImport: (input) => write<SessionImportResult>('apply_import', { input }),
        // The owner executes the edit-and-resend saga, including compensation.
        replaceEditableTail: async () => ({ status: 'rejected', reason: { code: 'unsupported' } }),
      },
      snapshots: {
        // A process-local provenance handle cannot cross RPC. CLI Fork uses
        // the dedicated owner saga, which captures and copies on that owner.
        capture: async () => {
          throw new Error('Fork snapshots require the session history owner');
        },
        copyFrom: async () => {
          throw new Error('Fork history copy requires the session history owner');
        },
      },
    }),
    agentWrites: {
      setTurnField: unsupported,
      openAssistantTurn: unsupported,
      applyAgentBatch: unsupported,
      markTurnSeen: () => {
        throw new Error('Auto-read belongs to the history owner');
      },
    },
    setPlan: unsupported,
    dispose: () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      listeners.clear();
    },
  };
}
