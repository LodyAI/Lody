import { describe, expect, it, vi } from 'vitest';
import type {
  MessageQueueItem,
  SessionHistoryInput,
  SessionId,
  SessionQueuePromotionRecord,
} from '@lody/shared';
import { LoroDoc } from 'loro-crdt';
import { LoroRepo } from 'loro-repo';
import { subscribeSessionChanges } from '@/lib/loro/doc';
import { SessionDocument } from '@/lib/loro/doc';
import {
  createSessionBackend,
  registerSessionBackendFactory,
  SessionBackendUnavailableError,
  resolveSessionBackendKind,
  type SessionBackend,
} from './session-backend';
import {
  defineSessionBackendContract,
  type QueuePromotionFailurePoint,
} from '../../tests/session-backend-contract';

const queueItem = {
  $cid: 'queue-cid-1',
  task: 'hello',
  userId: 'user-1',
  userTurnId: 'turn-1',
  operationId: 'queue:turn-1',
  timestamp: '2026-09-30T00:00:00.000Z',
  acpSessionConfig: {},
} as unknown as MessageQueueItem;

const userEntry: SessionHistoryInput = {
  id: 'turn-1',
  role: 'user',
  timestamp: queueItem.timestamp,
  userId: 'user-1',
  status: 'pending',
  items: [{ type: 'text', text: 'hello' }],
};

const otherQueueItem = {
  ...queueItem,
  $cid: 'queue-cid-2',
  userTurnId: 'turn-2',
  operationId: 'queue:turn-2',
} as MessageQueueItem;

const createBackendHarness = (options: { failOnceAt?: QueuePromotionFailurePoint } = {}) => {
  const receipts: string[] = [];
  let historyRows: SessionHistoryInput[] = [];
  let queueRows: MessageQueueItem[] = [queueItem];
  let activation: string | undefined;
  const promotionRecords = new Map<string, SessionQueuePromotionRecord>();
  let failureConsumed = false;
  const failOnce = (point: QueuePromotionFailurePoint) => {
    if (options.failOnceAt !== point || failureConsumed) return;
    failureConsumed = true;
    throw new Error(`injected failure at ${point}`);
  };
  const sessionDoc = {
    sessionId: 'session-1' as SessionId,
    sessionData: {
      history: {
        readAll: () => {
          throw new Error('full history read is forbidden in this retry');
        },
        readTurn: vi.fn(async (turnId: string) => {
          const turn = [...historyRows].reverse().find((entry) => entry.id === turnId);
          return turn ? { state: 'ready' as const, turn } : { state: 'missing' as const };
        }),
        count: vi.fn(async () => historyRows.length),
        readDirectory: vi.fn(async () =>
          historyRows.map((turn, index) => ({
            turnId: turn.id,
            index,
            scalars: { role: turn.role },
          }))
        ),
      },
      commands: {
        appendTurn: vi.fn(async (entry: SessionHistoryInput) => {
          historyRows = [...historyRows, entry];
          failOnce('history_acceptance');
        }),
        applyHistoryAction: vi.fn(async () => ({ matched: true })),
        respondPermission: vi.fn(async () => true),
        replaceEditableTail: vi.fn(async () => ({ status: 'accepted' as const })),
      },
      snapshots: {
        capture: vi.fn(async () => ({ history: historyRows })),
        copyFrom: vi.fn(async (_snapshot: unknown, selection: readonly SessionHistoryInput[]) => {
          historyRows = [...selection];
        }),
      },
    },
    agentWrites: {
      openAssistantTurn: vi.fn(async () => undefined),
      applyAgentBatch: vi.fn(async () => undefined),
    },
    setPlan: vi.fn(async () => undefined),
    appendUserTurn: vi.fn(async (entry: SessionHistoryInput) => {
      historyRows = [...historyRows, entry];
    }),
    publishUserTurnActivation: vi.fn(async (turnId: string) => {
      activation = turnId;
      failOnce('activation_publication');
    }),
    getMessageQueue: vi.fn(async () => [...queueRows]),
    peekReadyMessageQueue: vi.fn(async () => queueRows[0] ?? null),
    removeMessageQueueItem: vi.fn(async (cid: string) => {
      queueRows = queueRows.filter((item) => item.$cid !== cid);
      failOnce('queue_consumption');
    }),
    getMetaState: vi.fn(async () => undefined),
    getQueuePromotionRecord: vi.fn(async (operationId: string) =>
      promotionRecords.get(operationId)
    ),
    setQueuePromotionRecord: vi.fn(
      async (_operationId: string, record: SessionQueuePromotionRecord | undefined) => {
        if (!record) {
          promotionRecords.delete(_operationId);
          return;
        }
        promotionRecords.set(_operationId, record);
        receipts.push(record.state);
        if (record.state === 'prepared') failOnce('prepared_receipt');
        if (record.state === 'history_accepted') failOnce('history_receipt');
        if (record.state === 'activation_published') failOnce('activation_receipt');
        if (record.state === 'queue_consumed') failOnce('consumed_receipt');
      }
    ),
    getSteerTurnStatuses: vi.fn(async () => undefined),
    replaceSteerTurnStatuses: vi.fn(async () => undefined),
  } as unknown as SessionDocument;
  return {
    sessionDoc,
    receipts,
    getHistoryRows: () => [...historyRows],
    getQueueRows: () => [...queueRows],
    getActivation: () => activation,
    getPromotionRecord: (operationId: string) => promotionRecords.get(operationId),
    setQueueRows: (rows: MessageQueueItem[]) => {
      queueRows = [...rows];
    },
  };
};

const createRealLoroBackendFixture = async (
  options: { failOnceAt?: QueuePromotionFailurePoint } = {}
) => {
  const repo = await LoroRepo.create({});
  const sessionDoc = new SessionDocument(
    repo,
    'loro-backend-contract' as SessionId,
    async () => undefined
  );
  await sessionDoc.initOffline(undefined, { historyBackend: 'loro' });
  const backend = await createSessionBackend(sessionDoc, { historyBackend: 'loro' });
  await sessionDoc.pushMessageQueue(queueItem);
  await sessionDoc.pushMessageQueue(otherQueueItem);

  let failureConsumed = false;
  const failOnce = (point: QueuePromotionFailurePoint) => {
    if (options.failOnceAt !== point || failureConsumed) return;
    failureConsumed = true;
    throw new Error(`injected failure at ${point}`);
  };

  const receiptFailureState: Partial<
    Record<QueuePromotionFailurePoint, SessionQueuePromotionRecord['state']>
  > = {
    prepared_receipt: 'prepared',
    history_receipt: 'history_accepted',
    activation_receipt: 'activation_published',
    consumed_receipt: 'queue_consumed',
  };
  const receiptFailurePoint = options.failOnceAt;
  if (receiptFailurePoint && receiptFailureState[receiptFailurePoint]) {
    const targetState = receiptFailureState[receiptFailurePoint];
    const original = sessionDoc.setQueuePromotionRecord.bind(sessionDoc);
    vi.spyOn(sessionDoc, 'setQueuePromotionRecord').mockImplementation(async (id, record) => {
      await original(id, record);
      if (record?.state === targetState) failOnce(receiptFailurePoint);
    });
  }

  if (options.failOnceAt === 'history_acceptance') {
    const commands = sessionDoc.sessionData.commands;
    const original = commands.appendTurn.bind(commands);
    vi.spyOn(commands, 'appendTurn').mockImplementation(async (entry) => {
      await original(entry);
      failOnce('history_acceptance');
    });
  }

  if (options.failOnceAt === 'activation_publication') {
    const original = sessionDoc.publishUserTurnActivation.bind(sessionDoc);
    vi.spyOn(sessionDoc, 'publishUserTurnActivation').mockImplementation(async (turnId) => {
      await original(turnId);
      failOnce('activation_publication');
    });
  }

  if (options.failOnceAt === 'queue_consumption') {
    const original = sessionDoc.removeMessageQueueItem.bind(sessionDoc);
    vi.spyOn(sessionDoc, 'removeMessageQueueItem').mockImplementation(async (cid) => {
      await original(cid);
      failOnce('queue_consumption');
    });
  }

  return {
    backend,
    queueItem,
    entry: userEntry,
    readCopies: async (turnId: string) =>
      (await backend.readHistory()).filter((row) => row.id === turnId),
    readQueueCids: async () => (await backend.getMessageQueue()).map((item) => item.$cid),
    readActivation: async () => (await backend.getMetaState())?.latestUserMsgId,
    readPromotionRecord: (operationId: string) => backend.getQueuePromotionRecord(operationId),
    dispose: async () => {
      await sessionDoc.destroy({ preserveStatus: true });
      await repo.destroy();
    },
  };
};

defineSessionBackendContract('Loro', async (options) => {
  const harness = createBackendHarness(options);
  harness.setQueueRows([queueItem, otherQueueItem]);
  const backend = await createSessionBackend(harness.sessionDoc);
  return {
    backend,
    queueItem,
    entry: userEntry,
    readCopies: async (turnId) => harness.getHistoryRows().filter((entry) => entry.id === turnId),
    readQueueCids: async () => harness.getQueueRows().map((item) => item.$cid),
    readActivation: async () => harness.getActivation(),
    readPromotionRecord: async (operationId) => harness.getPromotionRecord(operationId),
  };
});

defineSessionBackendContract('Loro with real CRDT history', createRealLoroBackendFixture);

describe('session backend selection', () => {
  it('routes document subscriptions through the bound backend history port', () => {
    const listener = vi.fn();
    const unsubscribeControl = vi.fn();
    const unsubscribeHistory = vi.fn();
    const backend = {
      subscribeHistory: vi.fn(() => unsubscribeHistory),
    } as unknown as Pick<SessionBackend, 'subscribeHistory'>;
    const sessionDoc = {
      backend,
      subscribeAll: vi.fn(),
      subscribeControl: vi.fn(() => unsubscribeControl),
      getSessionBackend() {
        return this.backend;
      },
    } as unknown as SessionDocument;

    const unsubscribe = subscribeSessionChanges(sessionDoc, listener);

    expect(sessionDoc.subscribeAll).not.toHaveBeenCalled();
    expect(sessionDoc.subscribeControl).toHaveBeenCalledWith(listener);
    expect(backend.subscribeHistory).toHaveBeenCalledWith(listener);
    unsubscribe();
    expect(unsubscribeControl).toHaveBeenCalledOnce();
    expect(unsubscribeHistory).toHaveBeenCalledOnce();
  });

  it('defaults legacy metadata to Loro and keeps one backend per opened document', async () => {
    const { sessionDoc } = createBackendHarness();
    const first = await createSessionBackend(sessionDoc);

    expect(resolveSessionBackendKind(undefined)).toBe('loro');
    expect(await createSessionBackend(sessionDoc, { historyBackend: 'loro' })).toBe(first);
    await expect(createSessionBackend(sessionDoc, { historyBackend: 'roost' })).rejects.toThrow(
      /backend changed/
    );
  });

  it('fails closed when a Roost document has no registered adapter', async () => {
    const { sessionDoc } = createBackendHarness();
    await expect(
      createSessionBackend(sessionDoc, { historyBackend: 'roost' })
    ).rejects.toBeInstanceOf(SessionBackendUnavailableError);
  });

  it('uses a registered async factory once per opened session', async () => {
    const { sessionDoc } = createBackendHarness();
    const backend = { kind: 'roost' } as unknown as SessionBackend;
    const factory = vi.fn(async () => backend);
    const unregister = registerSessionBackendFactory('roost', factory);
    try {
      const [first, second] = await Promise.all([
        createSessionBackend(sessionDoc, { historyBackend: 'roost' }),
        createSessionBackend(sessionDoc, { historyBackend: 'roost' }),
      ]);
      expect(first).toBe(backend);
      expect(second).toBe(backend);
      expect(factory).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });

  it('retries factory initialization after a failed open', async () => {
    const { sessionDoc } = createBackendHarness();
    const backend = { kind: 'roost' } as unknown as SessionBackend;
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new Error('open failed'))
      .mockResolvedValue(backend);
    const unregister = registerSessionBackendFactory('roost', factory);
    try {
      await expect(createSessionBackend(sessionDoc, { historyBackend: 'roost' })).rejects.toThrow(
        'open failed'
      );
      await expect(createSessionBackend(sessionDoc, { historyBackend: 'roost' })).resolves.toBe(
        backend
      );
      expect(factory).toHaveBeenCalledTimes(2);
    } finally {
      unregister();
    }
  });

  it('binds an explicitly selected backend before an offline document can default to Loro', async () => {
    const sessionId = 'explicit-backend-session' as SessionId;
    const sessionDoc = new SessionDocument(
      {
        openPersistedDoc: vi.fn(async () => ({ doc: new LoroDoc() })),
        getDocMeta: vi.fn(async () => undefined),
        upsertDocMeta: vi.fn(async () => undefined),
        flush: vi.fn(async () => undefined),
      } as never,
      sessionId,
      vi.fn(async () => undefined),
      { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
    );
    const backend = {
      kind: 'roost',
      initialize: vi.fn(async () => undefined),
    } as unknown as SessionBackend;
    const factory = vi.fn(() => backend);
    const unregister = registerSessionBackendFactory('roost', factory);
    try {
      await sessionDoc.initOffline(undefined, { historyBackend: 'roost' });
      expect(factory).toHaveBeenCalledWith(sessionDoc, { historyBackend: 'roost' });
      expect(sessionDoc.getSessionBackend()).toBe(backend);
    } finally {
      unregister();
      await sessionDoc.destroy({ preserveStatus: true });
    }
  });

  it('does not compose a Loro history surface for an explicitly selected Roost document', async () => {
    const sessionId = 'roost-without-loro-history' as SessionId;
    const sessionDoc = new SessionDocument(
      {
        openPersistedDoc: vi.fn(async () => ({ doc: new LoroDoc() })),
        getDocMeta: vi.fn(async () => undefined),
        upsertDocMeta: vi.fn(async () => undefined),
        flush: vi.fn(async () => undefined),
      } as never,
      sessionId,
      vi.fn(async () => undefined),
      { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
    );
    const backend = {
      kind: 'roost',
      initialize: vi.fn(async () => undefined),
    } as unknown as SessionBackend;
    const unregister = registerSessionBackendFactory('roost', () => backend);
    try {
      await sessionDoc.initOffline(undefined, { historyBackend: 'roost' });
      expect(() => sessionDoc.sessionData).toThrow(/not initialized/);
      expect(sessionDoc.getSessionBackend()).toBe(backend);
    } finally {
      unregister();
      await sessionDoc.destroy({ preserveStatus: true });
    }
  });
});

describe('Loro queue promotion', () => {
  it('uses caller-provided history evidence instead of scanning the full conversation', async () => {
    const { sessionDoc, receipts } = createBackendHarness();
    const backend = await createSessionBackend(sessionDoc);

    const result = await backend.promoteQueuedTurn({
      item: queueItem,
      entry: userEntry,
      existingEntry: userEntry,
      operationId: 'queue:turn-1',
    });

    expect(result).toMatchObject({ status: 'already-applied', operationId: 'queue:turn-1' });
    expect(sessionDoc.sessionData.commands.appendTurn).not.toHaveBeenCalled();
    expect(sessionDoc.sessionData.history.readTurn).not.toHaveBeenCalled();
    expect(sessionDoc.removeMessageQueueItem).toHaveBeenCalledWith('queue-cid-1');
    expect(receipts).toEqual(['activation_published', 'queue_consumed']);
  });

  it('resumes after activation failure without appending the user turn twice', async () => {
    const { sessionDoc, receipts } = createBackendHarness();
    const publish = vi
      .spyOn(sessionDoc, 'publishUserTurnActivation')
      .mockRejectedValueOnce(new Error('activation unavailable'))
      .mockResolvedValue(undefined);
    const backend = await createSessionBackend(sessionDoc);

    await expect(
      backend.promoteQueuedTurn({
        item: queueItem,
        entry: userEntry,
        operationId: 'queue:turn-1',
      })
    ).rejects.toThrow('activation unavailable');

    await backend.promoteQueuedTurn({
      item: queueItem,
      entry: userEntry,
      existingEntry: userEntry,
      operationId: 'queue:turn-1',
    });

    expect(sessionDoc.sessionData.commands.appendTurn).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(receipts).toEqual([
      'prepared',
      'history_accepted',
      'activation_published',
      'queue_consumed',
    ]);
  });

  it('keeps unrelated queue rows in place when consuming the promoted row', async () => {
    const { sessionDoc, setQueueRows } = createBackendHarness();
    setQueueRows([queueItem, otherQueueItem]);
    const backend = await createSessionBackend(sessionDoc);

    await backend.promoteQueuedTurn({
      item: queueItem,
      entry: userEntry,
      operationId: 'queue:turn-1',
    });

    await expect(backend.getMessageQueue()).resolves.toEqual([otherQueueItem]);
  });
});
