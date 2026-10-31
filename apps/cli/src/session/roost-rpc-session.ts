import { z } from 'zod';
import {
  SessionHistoryChangesSchema,
  ResumeFromExternalChatHistoryMetaSchema,
  buildReplayPromptFromHistory,
  resolveLatestSessionGoalFromHistory,
  type SessionHistoryInput,
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
  readSessionHistoryMetadata,
  createRoostDirectoryRow,
} from '@lody/shared/session-data';
import type { SessionDocument } from '@/lib/loro/doc';
import type { RoostSessionBackendServices } from './roost-session-backend';

/** A command client has no native history owner, even when it runs on that machine. */
export type RoostSessionRpc = {
  readonly coherentInspection?: boolean;
  read(query: SessionHistoryReadQuery): Promise<SessionHistoryReadResponse>;
  write(
    operation: SessionHistoryWriteOperation,
    payload: Record<string, unknown>
  ): Promise<SessionHistoryWriteResponse>;
};

const historyEntriesSchema = z.array(
  z
    .object({
      id: z.string(),
      role: z.enum(['user', 'assistant', 'system']),
      timestamp: z.string(),
    })
    .passthrough()
);
const querySnapshotSchema = z
  .object({
    token: z.string().regex(/^[a-f0-9]{64}$/),
    rows: z.array(z.record(z.string(), z.unknown())),
  })
  .strict();
const transcriptResultSchema = z
  .object({
    total: z.number().int().nonnegative(),
    positions: z.array(z.number().int().nonnegative()),
    entries: historyEntriesSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.positions.length === value.entries.length && value.total >= value.entries.length
  );
const goalResultSchema = z
  .object({
    type: z.literal('goal'),
    threadId: z.string(),
    objective: z.string(),
    status: z.string(),
  })
  .passthrough()
  .nullable();
const replayResultSchema = z
  .object({
    promptText: z.string(),
    stats: z
      .object({
        usedChars: z.number().int().nonnegative(),
        truncated: z.boolean(),
        terminalOmitted: z.boolean(),
        terminalTailApplied: z.boolean(),
        thinkingOmitted: z.boolean(),
        pathsCount: z.number().int().nonnegative(),
        messagesIncluded: z.number().int().nonnegative(),
      })
      .strict(),
    noticeMeta: ResumeFromExternalChatHistoryMetaSchema,
  })
  .strict();
const queryRow = (entry: SessionHistoryInput, visibility = false): HistoryQueryRow =>
  historyQueryRow(
    entry,
    {
      field: (value, key) =>
        value && typeof value === 'object' ? Reflect.get(value, key) : undefined,
      scalar: (value) => value,
      length: (value) => (Array.isArray(value) ? value.length : 0),
      at: (value, index) => (value as unknown[])[index],
    },
    visibility
  );

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
  const readEntries = async (query: SessionHistoryReadQuery) =>
    historyEntriesSchema.parse(await readResult<unknown>(query)) as SessionHistoryInput[];
  const readLegacy = () => readEntries({ kind: 'readAll' });
  const snapshot = async (options?: {
    from?: number;
    to?: number;
    transcriptVisibility?: boolean;
  }) =>
    querySnapshotSchema.parse(await readResult<unknown>({ kind: 'readQuerySnapshot', ...options }));
  const history: SessionHistoryReader = {
    readMetadata: async () => {
      const entries = rpc.coherentInspection
        ? await readEntries({ kind: 'readMetadata' })
        : await readLegacy();
      return readSessionHistoryMetadata({
        readDirectory: () =>
          entries.map((entry, position) => createRoostDirectoryRow(position, entry)),
      });
    },
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
  const unsupported = async (): Promise<never> => {
    throw new Error('Agent execution requires the session history owner');
  };
  return {
    readHistoryEntry: async (turnId) => {
      if (!rpc.coherentInspection) return (await readLegacy()).find((entry) => entry.id === turnId);
      const read = await history.readTurn(turnId);
      if (read.state === 'ready') return read.turn as SessionHistoryInput;
      if (read.state === 'missing') return undefined;
      throw new Error('Owner history entry is unavailable');
    },
    readLatestGoal: async () => {
      if (!rpc.coherentInspection) return resolveLatestSessionGoalFromHistory(await readLegacy());
      const goal = goalResultSchema.parse(await readResult<unknown>({ kind: 'readLatestGoal' }));
      return resolveLatestSessionGoalFromHistory([{ items: goal ? [goal] : [] }]);
    },
    ...(rpc.coherentInspection
      ? {
          readHistoryTranscript: async ({
            limit,
            reverse,
          }: {
            limit?: number;
            reverse?: boolean;
          }) => {
            const value = transcriptResultSchema.parse(
              await readResult<unknown>({ kind: 'readTranscript', limit, reverse })
            );
            return { ...value, entries: value.entries as SessionHistoryInput[] };
          },
        }
      : {}),
    readHistoryQuery: async (options) => {
      if (rpc.coherentInspection) return (await snapshot(options)).rows;
      return (await readLegacy())
        .slice(options?.from ?? 0, options?.to)
        .map((entry) => queryRow(entry, options?.transcriptVisibility));
    },
    readHistorySelection: async (select, options) => {
      if (!rpc.coherentInspection) {
        const entries = await readLegacy();
        return select(entries.map((entry) => queryRow(entry, options?.transcriptVisibility))).map(
          (position) => {
            const entry = entries[position];
            if (!Number.isSafeInteger(position) || !entry)
              throw new Error('Invalid history selection');
            return entry;
          }
        );
      }
      for (let attempt = 0; ; attempt++) {
        try {
          const current = await snapshot(options);
          const positions = select(current.rows);
          return await readEntries({
            kind: 'readSelection',
            positions,
            token: current.token,
            ...options,
          });
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !('code' in error) ||
            error.code !== 'superseded' ||
            attempt >= 2
          )
            throw error;
        }
      }
    },
    ...(!rpc.coherentInspection
      ? {
          foldHistory: async <T>(
            create: () => T,
            visit: (state: T, entry: SessionHistoryInput) => void
          ) => {
            const state = create();
            for (const entry of await readLegacy()) visit(state, entry);
            return state;
          },
        }
      : {}),
    readHistoryReplay: async (excludeTurnId) =>
      rpc.coherentInspection
        ? replayResultSchema.parse(
            await readResult<unknown>({ kind: 'readReplayPrompt', excludeTurnId })
          )
        : buildReplayPromptFromHistory({ history: await readLegacy(), excludeTurnId }),
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
