import { describe, expect, it, vi } from 'vitest';
import type {
  MessageQueueItem,
  SessionHistoryInput,
  SessionId,
  SessionQueuePromotionRecord,
  SessionSteerOperationRecord,
} from '@lody/shared';
import {
  createRoostHistoryReader,
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
