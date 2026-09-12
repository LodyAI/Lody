import { describe, expect, it, vi } from 'vitest';
import { Loro } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import {
  getSessionRoomId,
  sessionDocSchema,
  type SessionHistoryInput,
  type SessionId,
  type StoredLodyOperation,
} from '@lody/shared';
import { LodyOperationCoordinator } from '../src/orchestration/operation-coordinator';

// Use real Mirror notifications: an array-only history mock hides this feedback loop.
describe('nested operation progress feedback', () => {
  it('quiesces for A -> B -> C and still publishes subsequent child completion', async () => {
    vi.useFakeTimers();
    const makeDoc = (id: string) => {
      const mirror = new Mirror({
        doc: new Loro(),
        schema: sessionDocSchema,
        initialState: { session: { id: id as SessionId }, history: [], mq: [] },
        strict: false,
      });
      mirror.setState((state) => ({
        ...state,
        history: [
          {
            id: `turn-${id}`,
            role: 'user',
            status: 'processing',
            timestamp: '2026-01-01T00:00:00.000Z',
            items: [],
            fileDiff: [],
          },
        ],
      }));
      return {
        mirror,
        // `subscribeSessionChanges` needs the session-data surface; the fake
        // drives change notification through the raw Mirror's subscribe, so the
        // history observation is inert.
        sessionData: {
          history: {
            count: async () => 0,
            readAt: async () => ({ state: 'missing' as const }),
            readTurn: async () => ({ state: 'missing' as const }),
            readRange: async () => [],
            readDirectory: async () => [],
            observe: () => ({ initial: Promise.resolve([]), unsubscribe: () => {} }),
          },
          commands: {},
          durability: { waitDurable: async () => {} },
        },
        getHistory: async () => mirror.getState().history,
        updateHistory: async (
          update: (history: SessionHistoryInput[]) => SessionHistoryInput[]
        ) => {
          mirror.setState((state) => ({ ...state, history: update(state.history) }));
        },
      };
    };
    const docs = new Map(['A', 'B', 'C'].map((id) => [id, makeDoc(id)]));
    const operation = (parent: string, child: string): StoredLodyOperation => ({
      workspaceId: 'workspace-1' as StoredLodyOperation['workspaceId'],
      ownerMachineId: 'machine-1' as StoredLodyOperation['ownerMachineId'],
      requesterSessionId: parent as SessionId,
      requesterUserId: 'user-1',
      operationId: `op-${parent}`,
      kind: 'session_create',
      fingerprint: parent,
      canonicalCommand: {},
      frozenContinuationConfig: { inputConfig: {} },
      initiatorChainDepth: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      deadlineAt: '2026-01-02T00:00:00.000Z',
      state: 'finished',
      items: [
        {
          status: 'active',
          inputDurable: true,
          target: { sessionId: child as SessionId, userTurnId: `turn-${child}` },
        },
      ],
    });
    const pending = [operation('A', 'B'), operation('B', 'C')];
    const settled = new Set<string>();
    let scans = 0;
    let coordinator: LodyOperationCoordinator;
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const store = {
      recoverOrphanedDeliveryClaims: () => 0,
      abandonDeliveryClaimsOwnedBy: () => 0,
      listActive: () => {
        // Deterministic safety guard makes the broken version fail, never hang the runner.
        if (++scans === 20) coordinator.stop();
        return [];
      },
      listPendingProgress: () => pending.filter((op) => !settled.has(op.operationId)),
      listPendingDeliveries: () => [],
      close: () => {},
      settleProgress: (_requester: unknown, id: string) => settled.add(id),
    };
    coordinator = new LodyOperationCoordinator({
      workspaceId: pending[0]!.workspaceId,
      machineId: pending[0]!.ownerMachineId,
      userId: 'user-1',
      storePath: '/unused/operations.sqlite3',
      storeFactory: () => store as never,
      operationStoreWatchFactory: () => ({ close: () => {} }),
      now: () => Date.parse('2026-01-01T01:00:00.000Z'),
      workspaceDocument: {
        repo: {
          watch: () => ({ unsubscribe: () => {} }),
          flush: async () => {},
          getDocMeta: async (room: string) => {
            const id = [...docs.keys()].find(
              (candidate) => getSessionRoomId(candidate as SessionId) === room
            );
            return { meta: { id, processingUserMsgId: `turn-${id}` } };
          },
        },
        getOrCreateSessionDoc: async (id: string) => docs.get(id),
      } as never,
      executionService: { getExecutionSnapshot: () => ({}) } as never,
      dispatchWatcher: {} as never,
      materializeTarget: async () => {},
      logger: logger as never,
    });
    const drain = async () => {
      // Each barrier captures the queued reconciliation chain. No timer or sleep advances it.
      for (let i = 0; i < 25; i++) await coordinator.idle();
    };
    try {
      coordinator.start();
      await drain();
      expect(scans).toBe(2);
      expect([...docs.values()].map((doc) => doc.mirror.getState().history.length)).toEqual([
        2, 2, 1,
      ]);
      const child = docs.get('C')!;
      await child.updateHistory((history) => [
        ...history,
        {
          id: 'answer-C',
          role: 'assistant',
          userTurnId: 'turn-C',
          finished: true,
          timestamp: '2026-01-01T01:00:00.000Z',
          items: [],
          fileDiff: [],
        },
      ]);
      await drain();
      expect(scans).toBe(4);
      const card = docs
        .get('B')!
        .mirror.getState()
        .history.flatMap((entry) => entry.items ?? [])
        .find((item) => item.type === 'operation_progress');
      expect(card).toMatchObject({ items: [{ status: 'succeeded' }] });
      expect(settled).toEqual(new Set(['op-B']));
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      coordinator.stop();
      for (const doc of docs.values()) doc.mirror.dispose();
      vi.useRealTimers();
    }
  });
});
