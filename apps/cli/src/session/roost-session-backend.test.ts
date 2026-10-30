import { describe, expect, it, vi } from 'vitest';
import type {
  MessageQueueItem,
  SessionHistoryInput,
  SessionId,
  SessionQueuePromotionRecord,
  SessionSteerOperationRecord,
} from '@lody/shared';
import { SessionHistoryReadQuerySchema, type SessionHistoryReadResponse } from '@lody/shared';
import { createRoostRpcSessionServices } from './roost-rpc-session';
import {
  createRoostHistoryReader,
  historyQueryRow,
  readSessionHistoryMetadata,
  type RoostHistoryChange,
  type RoostHistorySegment,
  type RoostSessionData,
} from '@lody/shared/session-data';
import type { SessionDocument } from '@/lib/loro/doc';
import type { SessionAgentWrites } from '@/lib/loro/session-agent-writes';
import {
  createRoostSessionBackendFactory,
  RoostSessionBackend,
  type RoostSessionBackendServices,
} from './roost-session-backend';

const entry: SessionHistoryInput = {
  id: 'user-1',
  role: 'user',
  timestamp: '2026-10-03T00:00:00.000Z',
  status: 'pending',
  items: [{ type: 'text', text: 'hello' }],
  fileDiff: [],
};

function createFixture() {
  let segments: RoostHistorySegment[] = [];
  const listeners = new Set<(change: RoostHistoryChange) => void>();
  const notify = (change: RoostHistoryChange) => {
    for (const listener of listeners) listener(change);
  };
  const history = createRoostHistoryReader({
    readProjectedMessages: async () => segments,
    observe: (listener) => {
      listeners.add(listener);
      return {
        initial: Promise.resolve(segments),
        unsubscribe: () => listeners.delete(listener),
      };
    },
  });

  const promotionRecords = new Map<string, SessionQueuePromotionRecord>();
  const steerRecords = new Map<string, SessionSteerOperationRecord>();
  const queue: MessageQueueItem[] = [
    {
      $cid: 'queue-1',
      task: 'hello',
      userId: 'user-1',
      userTurnId: 'user-1',
      operationId: 'queue:user-1',
      timestamp: entry.timestamp,
      acpSessionConfig: {},
    } as unknown as MessageQueueItem,
  ];
  let activation: string | undefined;
  const commands = {
    appendTurn: vi.fn(async (turn: SessionHistoryInput) => {
      segments = [
        ...segments,
        {
          businessId: turn.id,
          segmentId: `segment-${segments.length}`,
          content: structuredClone(turn),
          nextSeq: 1n,
          sealed: turn.finished === true,
        },
      ];
      notify({ kind: 'structure', from: segments.length - 1, to: segments.length });
    }),
    applyHistoryAction: vi.fn(async () => ({ matched: false })),
    applyHistoryImport: vi.fn(async () => ({ status: 'accepted' as const, appended: 0 })),
    respondPermission: vi.fn(async () => false),
    replaceEditableTail: vi.fn(async () => ({
      status: 'rejected' as const,
      reason: { code: 'unsupported' as const },
    })),
  };
  const sessionData = {
    sessionId: 'roost-test' as SessionId,
    history,
    commands,
    snapshots: {
      capture: vi.fn(async () => ({ history: [] })),
      copyFrom: vi.fn(async () => undefined),
    },
  } as unknown as RoostSessionData;
  const agentWrites = {
    openAssistantTurn: vi.fn(async () => undefined),
    applyAgentBatch: vi.fn(async () => undefined),
  } as unknown as SessionAgentWrites;
  const control = {
    sessionId: 'roost-test' as SessionId,
    publishUserTurnActivation: vi.fn(async (turnId: string) => {
      activation = turnId;
    }),
    getMessageQueue: vi.fn(async () => [...queue]),
    peekReadyMessageQueue: vi.fn(async () => queue[0] ?? null),
    removeMessageQueueItem: vi.fn(async (cid: string) => {
      const index = queue.findIndex((item) => item.$cid === cid);
      if (index >= 0) queue.splice(index, 1);
    }),
    getMetaState: vi.fn(async () => undefined),
    getQueuePromotionRecord: vi.fn(async (id: string) => promotionRecords.get(id)),
    setQueuePromotionRecord: vi.fn(
      async (id: string, record: SessionQueuePromotionRecord | undefined) => {
        if (record) promotionRecords.set(id, record);
        else promotionRecords.delete(id);
      }
    ),
    getSteerTurnStatuses: vi.fn(async () => undefined),
    replaceSteerTurnStatuses: vi.fn(async () => undefined),
    getSteerOperationRecord: vi.fn(async (id: string) => steerRecords.get(id)),
    getSteerOperationLedger: vi.fn(async () => undefined),
    setSteerOperationRecord: vi.fn(
      async (id: string, record: SessionSteerOperationRecord | undefined) => {
        if (record) steerRecords.set(id, record);
        else steerRecords.delete(id);
      }
    ),
    applyAcpRuntimeConfigPatch: vi.fn(() => true),
    flushLocalWrites: vi.fn(async () => undefined),
    waitUntilSynced: vi.fn(async () => true),
  } as unknown as SessionDocument;
  const services: RoostSessionBackendServices = {
    sessionData,
    agentWrites,
    setPlan: vi.fn(async () => undefined),
  };
  return {
    backend: new RoostSessionBackend(control, services),
    factory: createRoostSessionBackendFactory(async () => services),
    control,
    commands,
    services,
    queue,
    getActivation: () => activation,
  };
}

describe('RoostSessionBackend', () => {
  it('routes history writes through Roost services and control writes through SessionDocument', async () => {
    const fixture = createFixture();
    await fixture.backend.appendHistoryTurn(entry);
    expect(await fixture.backend.readHistory()).toMatchObject([entry]);
    const queuedItem = {
      ...fixture.queue[0]!,
      userTurnId: 'user-2',
      operationId: 'queue:user-2',
    };

    const result = await fixture.backend.promoteQueuedTurn({
      item: queuedItem,
      entry: { ...entry, id: 'user-2' },
      operationId: 'queue:user-2',
    });

    expect(result.status).toBe('applied');
    expect(fixture.commands.appendTurn).toHaveBeenCalledTimes(2);
    expect(fixture.getActivation()).toBe('user-2');
    expect(fixture.queue).toHaveLength(0);
    expect(fixture.control.setQueuePromotionRecord).toHaveBeenCalled();
  });

  it('exposes an explicit factory without registering or changing the default selector', async () => {
    const fixture = createFixture();
    const backend = await fixture.factory(fixture.control, { historyBackend: 'roost' });
    expect(backend).toBeInstanceOf(RoostSessionBackend);
    expect(backend.kind).toBe('roost');
  });
});

describe('Roost owner RPC reader', () => {
  it('observes Native owner checkpoints without control updates and leaves writes available while waiting', async () => {
    vi.useFakeTimers();
    const doc = { sessionId: 'native-observed-session' } as SessionDocument;
    const waiting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<SessionHistoryReadResponse>();
    const changes: unknown[] = [];
    let writeCompleted = false;
    const services = createRoostRpcSessionServices(doc, {
      read: async (query) => {
        if (query.kind === 'watchChanges') {
          waiting.resolve();
          return release.promise;
        }
        return {
          type: 'session/history-read_response',
          sessionId: doc.sessionId,
          success: true,
          historyRevision: 1,
          historyCount: 0,
          result: {
            checkpoint: 'native-scope:1',
            startPosition: 0,
            totalCount: 0,
            rows: [],
            hasMoreOlder: false,
            cursor: null,
          },
        };
      },
      write: async (operation) => {
        writeCompleted = true;
        return {
          type: 'session/history-write_response',
          sessionId: doc.sessionId,
          operation,
          success: true,
          historyRevision: 2,
          historyCount: 1,
          historyChange: { kind: 'structure', from: 0, to: 1 },
        };
      },
    });
    const observation = services.sessionData.history.observe((change) => changes.push(change));
    try {
      await observation.initial;
      await waiting.promise;
      await services.sessionData.commands.appendTurn(entry as never);
      expect(writeCompleted).toBe(true);
      const notified = Promise.withResolvers<void>();
      const second = services.sessionData.history.observe((change) => {
        if (change.kind === 'changed') notified.resolve();
      });
      await second.initial;
      release.resolve({
        type: 'session/history-read_response',
        sessionId: doc.sessionId,
        success: true,
        historyRevision: 3,
        historyCount: 1,
        result: { state: 'ready', checkpoint: 'native-scope:3', ids: ['owner-turn'] },
      });
      await notified.promise;
      expect(changes).toContainEqual({ kind: 'changed', ids: ['owner-turn'] });
      second.unsubscribe();
      observation.unsubscribe();
      await services.dispose?.();
      await vi.runOnlyPendingTimersAsync();
    } finally {
      observation.unsubscribe();
      await services.dispose?.();
      vi.useRealTimers();
    }
  });

  it('clips open-ended directory reads and batches within the negotiated RPC limit', async () => {
    const doc = {
      sessionId: 'remote-session',
      subscribeRoostHistoryCursor: () => () => {},
    } as unknown as SessionDocument;
    const rows = Array.from({ length: 1001 }, (_, index) => ({
      position: index,
      state: 'ready',
      turnId: `remote-${index}`,
      scalars: { role: 'user' },
    }));
    const services = createRoostRpcSessionServices(doc, {
      read: async (query) => {
        const parsed = SessionHistoryReadQuerySchema.parse(query);
        return {
          type: 'session/history-read_response',
          sessionId: doc.sessionId,
          success: true,
          historyRevision: 2,
          historyCount: rows.length,
          result:
            parsed.kind === 'count'
              ? rows.length
              : parsed.kind === 'readDirectory'
                ? rows.slice(parsed.from, parsed.to)
                : undefined,
        };
      },
      write: async () => {
        throw new Error('Read-only transport');
      },
    });
    expect(await services.sessionData.history.readDirectory(0, Number.MAX_SAFE_INTEGER)).toEqual(
      rows
    );
    expect(await services.sessionData.history.readDirectory(999, Number.MAX_SAFE_INTEGER)).toEqual(
      rows.slice(999)
    );
    await services.dispose?.();
  });

  it('restarts a multi-page observation when its owner revision changes', async () => {
    const doc = {
      sessionId: 'remote-revision',
      subscribeRoostHistoryCursor: () => () => {},
    } as unknown as SessionDocument;
    let revision = 1;
    const services = createRoostRpcSessionServices(doc, {
      read: async (query): Promise<SessionHistoryReadResponse> => {
        const parsed = SessionHistoryReadQuerySchema.parse(query);
        const result =
          parsed.kind === 'count'
            ? 501
            : parsed.kind === 'readDirectory'
              ? Array.from({ length: parsed.to - parsed.from }, (_, index) => ({
                  position: parsed.from + index,
                  state: 'ready',
                  turnId: `v${revision}-${parsed.from + index}`,
                }))
              : undefined;
        const reply = {
          type: 'session/history-read_response' as const,
          sessionId: doc.sessionId,
          success: true,
          historyRevision: revision,
          historyCount: 501,
          result,
        };
        if (parsed.kind === 'readDirectory' && parsed.from === 0) revision = 2;
        return reply;
      },
      write: async () => {
        throw new Error('Read-only transport');
      },
    });
    expect(await services.sessionData.history.readDirectory(0, Number.MAX_SAFE_INTEGER)).toEqual(
      Array.from({ length: 501 }, (_, position) => ({
        position,
        state: 'ready',
        turnId: `v2-${position}`,
      }))
    );
    await services.dispose?.();
  });
});

it.each(['body', 'generation'] as const)(
  'fences query selection and streamed folds across an owner %s change',
  async (change) => {
    const doc = { sessionId: 'selective-owner' } as SessionDocument;
    let revision = 1,
      scope = 1,
      raced = false;
    const rows = [
      { ...entry, id: 'old', userId: 'author', items: [{ type: 'text' as const, text: 'before' }] },
      { ...entry, id: 'target' },
    ];
    const querySnapshot = () =>
      rows.map((row) =>
        historyQueryRow(row, {
          field: (value, key) =>
            value && typeof value === 'object' ? Reflect.get(value, key) : undefined,
          scalar: (value) => value,
          length: (value) => (Array.isArray(value) ? value.length : 0),
          at: (value, index) => (value as unknown[])[index],
        })
      );
    const services = createRoostRpcSessionServices(doc, {
      inspection: true,
      read: async (input) => {
        const parsed = SessionHistoryReadQuerySchema.parse(input);
        let result: unknown;
        if (parsed.kind === 'count')
          result = parsed.withCheckpoint
            ? { count: rows.length, checkpoint: `scope-${scope}` }
            : rows.length;
        else if (parsed.kind === 'readQuery')
          result = querySnapshot().slice(parsed.from, parsed.to);
        else if (parsed.kind === 'readRange') {
          if (!raced) {
            raced = true;
            scope++;
            if (change === 'body') revision++;
            rows[0]!.items = [{ type: 'text', text: 'after' }];
          }
          if (parsed.atCheckpoint !== `scope-${scope}`)
            return {
              type: 'session/history-read_response',
              sessionId: doc.sessionId,
              success: false,
              retryReason: 'superseded',
              error: 'superseded',
            };
          result = rows.slice(parsed.from, parsed.to).map((turn) => ({ state: 'ready', turn }));
        } else throw new Error('Unexpected whole-history or body query');
        return {
          type: 'session/history-read_response',
          sessionId: doc.sessionId,
          success: true,
          historyRevision: revision,
          result,
        };
      },
      write: async () => {
        throw new Error('read-only');
      },
    });
    const selected = await services.readHistorySelection?.((query) =>
      query.flatMap((row, index) => (row.id === 'old' ? [index] : []))
    );
    expect(selected).toEqual([rows[0]]);
    expect(raced).toBe(true);
    const folded = await services.foldHistory?.(
      () => [] as string[],
      (state, row) => state.push(row.id)
    );
    expect(folded).toEqual(['old', 'target']);
    await services.dispose?.();
  }
);

it('retains older-owner attribution, configuration and schedule metadata without a whole array', async () => {
  const doc = { sessionId: 'older-selective-owner' } as SessionDocument;
  const row = {
    ...entry,
    userId: 'older-author',
    scheduleRun: { scheduleId: 'schedule' },
    inputConfig: { modelId: 'selected-model' },
  };
  const services = createRoostRpcSessionServices(doc, {
    read: async (input) => {
      let result: unknown;
      if (input.kind === 'count') result = 1;
      else if (input.kind === 'readLatestPage')
        result = { totalCount: 1, checkpoint: 'older-owner:1' };
      else if (input.kind === 'readDirectory')
        result = [
          {
            position: 0,
            state: 'ready',
            turnId: row.id,
            scalars: { id: row.id, role: row.role, timestamp: row.timestamp },
          },
        ];
      else if (input.kind === 'readRange') result = [{ state: 'ready', turn: row }];
      else throw new Error('Unsupported old-owner query');
      return {
        type: 'session/history-read_response',
        sessionId: doc.sessionId,
        success: true,
        historyRevision: 1,
        result,
      };
    },
    write: async () => {
      throw new Error('read-only');
    },
  });
  expect(await readSessionHistoryMetadata(services.sessionData.history)).toMatchObject([
    { id: row.id, userId: 'older-author', scheduleRun: { scheduleId: 'schedule' } },
  ]);
  await services.dispose?.();
});
