import {
  SessionHistoryChangeSchema,
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
} from '@lody/shared/session-data';
import type { SessionDocument } from '@/lib/loro/doc';
import type { RoostSessionBackendServices } from './roost-session-backend';

/** A command client has no native history owner, even when it runs on that machine. */
export type RoostSessionRpc = {
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
    const response = await rpc.read(query);
    if (!response.success || response.sessionId !== doc.sessionId || response.result === undefined)
      throw new Error(response.error ?? 'Owner history read failed');
    return response;
  };
  const read = async <T>(query: SessionHistoryReadQuery): Promise<T> =>
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
      to: response.historyCount ?? (await read<number>({ kind: 'count' })),
    };
    notify(change);
    return response.result as T;
  };
  const unsubscribe = doc.subscribeRoostHistoryCursor(() => {
    // The authoritative read obtains its own revision; a hint cannot overwrite it.
    void doc
      .getRoostHistoryCursor()
      .then(async (cursor) => {
        let parsed;
        try {
          parsed = cursor?.historyChangeJson
            ? SessionHistoryChangeSchema.nullable().safeParse(JSON.parse(cursor.historyChangeJson))
            : undefined;
        } catch {
          /* A stale hint falls back to the authoritative count. */
        }
        const change = parsed?.success ? parsed.data : undefined;
        notify(
          change ?? {
            kind: 'structure',
            from: 0,
            to: cursor?.historyCount ?? (await read<number>({ kind: 'count' })),
          }
        );
      })
      .catch((error) => console.error('Owner history cursor refresh failed', error));
  });
  const history: SessionHistoryReader = {
    count: () => read<number>({ kind: 'count' }),
    readAt: (position) => read<SessionTurnRead>({ kind: 'readAt', position }),
    readTurn: (turnId) => read<SessionTurnRead>({ kind: 'readTurn', turnId }),
    readRange: (from, to) => readRange('readRange', from, to),
    readDirectory: (from, to) => readRange('readDirectory', from, to),
    readLatestDirectoryPage: (limit) => read({ kind: 'readLatestPage', limit }),
    readOlderDirectoryPage: (cursor, limit) => read({ kind: 'readOlderPage', cursor, limit }),
    readAll: () => read({ kind: 'readAll' }),
    readTurnOutput: (userTurnId) => read({ kind: 'readTurnOutput', userTurnId }),
    observe(listener) {
      listeners.add(listener);
      const initialPage = read<SessionHistoryDirectoryPage>({ kind: 'readLatestPage', limit: 40 });
      return {
        initial: initialPage.then((page) => page.rows),
        initialPage,
        unsubscribe: () => {
          listeners.delete(listener);
        },
      };
    },
  };
  const unsupported = async (): Promise<never> => {
    throw new Error('Agent execution requires the session history owner');
  };
  return {
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
      unsubscribe();
      listeners.clear();
    },
  };
}
