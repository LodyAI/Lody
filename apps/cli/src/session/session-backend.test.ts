import { describe, expect, it, vi } from 'vitest';
import type {
  MessageQueueItem,
  SessionHistoryInput,
  SessionId,
  SessionQueuePromotionRecord,
} from '@lody/shared';
import type { SessionDocument } from '@/lib/loro/doc';
import {
  createSessionBackend,
  SessionBackendUnavailableError,
  resolveSessionBackendKind,
} from './session-backend';

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

const createBackendHarness = () => {
  const receipts: string[] = [];
  let promotionRecord: SessionQueuePromotionRecord | undefined;
  const sessionDoc = {
    sessionId: 'session-1' as SessionId,
    sessionData: {
      history: {
        readAll: () => {
          throw new Error('full history read is forbidden in this retry');
        },
        readTurn: vi.fn(async () => ({ state: 'missing' as const })),
        count: vi.fn(async () => 0),
        readDirectory: vi.fn(async () => []),
      },
      commands: {
        appendTurn: vi.fn(async () => undefined),
        applyHistoryAction: vi.fn(async () => ({ matched: true })),
        respondPermission: vi.fn(async () => true),
      },
    },
    agentWrites: {
      openAssistantTurn: vi.fn(async () => undefined),
      applyAgentBatch: vi.fn(async () => undefined),
    },
    setPlan: vi.fn(async () => undefined),
    appendUserTurn: vi.fn(async () => undefined),
    publishUserTurnActivation: vi.fn(async () => undefined),
    getMessageQueue: vi.fn(async () => [queueItem]),
    peekReadyMessageQueue: vi.fn(async () => queueItem),
    removeMessageQueueItem: vi.fn(async () => undefined),
    getMetaState: vi.fn(async () => undefined),
    getQueuePromotionRecord: vi.fn(async () => promotionRecord),
    setQueuePromotionRecord: vi.fn(
      async (_operationId: string, record: SessionQueuePromotionRecord | undefined) => {
        promotionRecord = record;
        if (!record) return;
        receipts.push(record.state);
      }
    ),
    getSteerTurnStatuses: vi.fn(async () => undefined),
    replaceSteerTurnStatuses: vi.fn(async () => undefined),
  } as unknown as SessionDocument;
  return { sessionDoc, receipts };
};

describe('session backend selection', () => {
  it('defaults legacy metadata to Loro and keeps one backend per opened document', () => {
    const { sessionDoc } = createBackendHarness();
    const first = createSessionBackend(sessionDoc);

    expect(resolveSessionBackendKind(undefined)).toBe('loro');
    expect(createSessionBackend(sessionDoc, { historyBackend: 'loro' })).toBe(first);
    expect(() => createSessionBackend(sessionDoc, { historyBackend: 'roost' })).toThrow(
      /backend changed/
    );
  });

  it('fails closed when a Roost document has no registered adapter', () => {
    const { sessionDoc } = createBackendHarness();
    expect(() => createSessionBackend(sessionDoc, { historyBackend: 'roost' })).toThrow(
      SessionBackendUnavailableError
    );
  });
});

describe('Loro queue promotion', () => {
  it('uses caller-provided history evidence instead of scanning the full conversation', async () => {
    const { sessionDoc, receipts } = createBackendHarness();
    const backend = createSessionBackend(sessionDoc);

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
    const backend = createSessionBackend(sessionDoc);

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
});
