import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LODY_OPERATION_COMPLETION_MAX_BYTES,
  type SessionId,
  type WorkspaceId,
  type MachineId,
} from '@lody/shared';

import {
  canonicalizeLodyCommand,
  isOperationStoreBusyError,
  LodyOperationStore,
  LodyOperationStoreError,
  runWithOperationStoreBusyRetry,
} from './operation-store';

const roots = new Set<string>();

const makeStore = async (now: () => number = () => Date.parse('2026-07-20T00:00:00Z')) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lody-operation-store-'));
  roots.add(root);
  return new LodyOperationStore(path.join(root, 'operations.sqlite3'), now);
};

const baseInput = () => ({
  workspaceId: 'workspace-1' as WorkspaceId,
  ownerMachineId: 'machine-1' as MachineId,
  requesterSessionId: 'requester-1' as SessionId,
  requesterUserId: 'user-1',
  operationId: 'review-round-1',
  kind: 'session_chat' as const,
  canonicalCommand: { prompt: 'review', target: 'target-1' },
  frozenContinuationConfig: {
    agentConfigId: 'agent-1',
    inputConfig: { cliType: 'builtin' as const, agentType: 'codex', chainDepth: 0 },
  },
  initiatorChainDepth: 0,
  createdAt: '2026-07-20T00:00:00.000Z',
  deadlineAt: '2026-07-21T00:00:00.000Z',
  items: [
    {
      status: 'active' as const,
      target: { sessionId: 'target-1' as SessionId, userTurnId: 'turn-1' },
      inputDurable: false,
    },
  ],
});

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe('LodyOperationStore', () => {
  it('restricts the store directory and database to the local account', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lody-operation-store-permissions-'));
    roots.add(root);
    await chmod(root, 0o755);
    const dbPath = path.join(root, 'operations.sqlite3');
    const store = new LodyOperationStore(dbPath);
    try {
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(dbPath)).mode & 0o777).toBe(0o600);
    } finally {
      store.close();
    }
  });

  it('marks an existing legacy pending Delivery as execution-uncertain', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lody-operation-store-migration-'));
    roots.add(root);
    const dbPath = path.join(root, 'operations.sqlite3');
    const legacy = new Database(dbPath);
    try {
      legacy.exec(`
        CREATE TABLE operations (
          workspace_id TEXT NOT NULL,
          owner_machine_id TEXT NOT NULL,
          requester_session_id TEXT NOT NULL,
          requester_user_id TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          canonical_command_json TEXT NOT NULL,
          frozen_config_json TEXT NOT NULL,
          initiator_chain_depth INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          deadline_at TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('active', 'finished')),
          items_json TEXT NOT NULL,
          completion_json TEXT,
          finished_at TEXT,
          PRIMARY KEY (requester_session_id, operation_id)
        );
        CREATE TABLE deliveries (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id TEXT NOT NULL,
          requester_session_id TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          delivery_id TEXT NOT NULL UNIQUE,
          system_turn_id TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK (state IN ('pending', 'consumed')),
          initiator_chain_depth INTEGER NOT NULL,
          completion_json TEXT NOT NULL,
          consumed_at TEXT,
          FOREIGN KEY (requester_session_id, operation_id)
            REFERENCES operations (requester_session_id, operation_id)
            ON DELETE CASCADE
        );
        INSERT INTO operations (
          workspace_id, owner_machine_id, requester_session_id, requester_user_id,
          operation_id, kind, fingerprint, canonical_command_json, frozen_config_json,
          initiator_chain_depth, created_at, deadline_at, state, items_json,
          completion_json, finished_at
        ) VALUES (
          'workspace-1', 'machine-1', 'legacy-requester', 'user-1',
          'legacy-operation', 'session_chat', 'legacy-fingerprint', '{}',
          '{"inputConfig":{}}', 0, '2026-07-20T00:00:00.000Z',
          '2026-07-20T01:00:00.000Z', 'finished', '[]',
          '{"type":"cancelled"}', '2026-07-20T00:01:00.000Z'
        );
        INSERT INTO deliveries (
          workspace_id, requester_session_id, operation_id, delivery_id,
          system_turn_id, state, initiator_chain_depth, completion_json
        ) VALUES (
          'workspace-1', 'legacy-requester', 'legacy-operation',
          'operation:legacy-requester:legacy-operation:completion',
          'operation-completion:legacy-requester:legacy-operation',
          'pending', 0, '{"type":"cancelled"}'
        );
      `);
    } finally {
      legacy.close();
    }

    const migrated = new LodyOperationStore(dbPath);
    try {
      migrated.accept(baseInput());
      migrated.finish('requester-1' as SessionId, 'review-round-1', { type: 'cancelled' });
      expect(migrated.listPendingDeliveries('workspace-1' as WorkspaceId)).toEqual([
        expect.objectContaining({
          operationId: 'legacy-operation',
          attemptCount: 0,
          executionPhase: 'uncertain',
        }),
        expect.objectContaining({ attemptCount: 0, executionPhase: 'ready', state: 'pending' }),
      ]);
    } finally {
      migrated.close();
    }

    const legacyReader = new Database(dbPath, { readonly: true });
    try {
      const columns = legacyReader.pragma('table_info(deliveries)') as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual([
        'sequence',
        'workspace_id',
        'requester_session_id',
        'operation_id',
        'delivery_id',
        'system_turn_id',
        'state',
        'initiator_chain_depth',
        'completion_json',
        'consumed_at',
      ]);
      expect(
        legacyReader
          .prepare(
            'SELECT execution_phase, attempt_count, active_claim_id, active_claim_worker_boot_id FROM delivery_execution_state WHERE requester_session_id = ? AND operation_id = ?'
          )
          .get('legacy-requester', 'legacy-operation')
      ).toEqual({
        execution_phase: 'uncertain',
        attempt_count: 0,
        active_claim_id: null,
        active_claim_worker_boot_id: null,
      });
    } finally {
      legacyReader.close();
    }

    const reopened = new LodyOperationStore(dbPath);
    try {
      expect(
        reopened.getDelivery('legacy-requester' as SessionId, 'legacy-operation')
      ).toMatchObject({ state: 'pending', attemptCount: 0, executionPhase: 'uncertain' });
    } finally {
      reopened.close();
    }
  });

  it('accepts once and returns the same Operation for canonical-equivalent retries', async () => {
    const store = await makeStore();
    try {
      const first = store.accept(baseInput());
      const retry = store.accept({
        ...baseInput(),
        canonicalCommand: { target: 'target-1', prompt: 'review' },
      });

      expect(first.created).toBe(true);
      expect(retry.created).toBe(false);
      expect(retry.operation.operationId).toBe('review-round-1');
      expect(store.snapshot(retry.operation)).toMatchObject({ state: 'active' });
    } finally {
      store.close();
    }
  });

  it('round-trips a frozen create dispatch config including the task tools gate', async () => {
    const store = await makeStore();
    try {
      const accepted = store.accept({
        ...baseInput(),
        kind: 'session_create',
        frozenContinuationConfig: {
          agentConfigId: 'agent-1',
          inputConfig: { cliType: 'builtin' as const, agentType: 'codex', chainDepth: 0 },
          targetDispatchConfigs: [
            {
              modeId: 'default',
              modelId: 'gpt-5',
              configOptionValues: { fast: true },
              taskToolsEnabled: false,
              inheritSessionDefaults: false as const,
            },
          ],
        },
      });

      expect(accepted.created).toBe(true);
      expect(accepted.operation.frozenContinuationConfig.targetDispatchConfigs).toEqual([
        {
          modeId: 'default',
          modelId: 'gpt-5',
          configOptionValues: { fast: true },
          taskToolsEnabled: false,
          inheritSessionDefaults: false,
        },
      ]);
    } finally {
      store.close();
    }
  });

  it('rejects operation id reuse with different semantic input', async () => {
    const store = await makeStore();
    try {
      store.accept(baseInput());
      expect(() =>
        store.accept({ ...baseInput(), canonicalCommand: { prompt: 'implement' } })
      ).toThrowError(
        expect.objectContaining<LodyOperationStoreError>({ code: 'OPERATION_ID_REUSED' })
      );
    } finally {
      store.close();
    }
  });

  it('scopes lookup to the requester Session', async () => {
    const store = await makeStore();
    try {
      store.accept(baseInput());
      expect(() => store.get('another-session' as SessionId, 'review-round-1')).toThrowError(
        expect.objectContaining<LodyOperationStoreError>({ code: 'OPERATION_NOT_FOUND' })
      );
    } finally {
      store.close();
    }
  });

  it('atomically creates one pending Delivery when finishing', async () => {
    const store = await makeStore();
    try {
      store.accept(baseInput());
      const completion = {
        type: 'result' as const,
        value: {
          items: [
            {
              status: 'succeeded' as const,
              target: { sessionId: 'target-1' as SessionId, userTurnId: 'turn-1' },
              assistantTurnId: 'assistant:turn-1',
            },
          ],
        },
      };
      store.finish('requester-1' as SessionId, 'review-round-1', completion);
      store.finish('requester-1' as SessionId, 'review-round-1', completion);

      expect(store.get('requester-1' as SessionId, 'review-round-1')).toMatchObject({
        state: 'finished',
        completion,
      });
      expect(store.listPendingDeliveries('workspace-1' as WorkspaceId)).toEqual([
        expect.objectContaining({
          deliveryId: 'operation:requester-1:review-round-1:completion',
          systemTurnId: 'operation-completion:requester-1:review-round-1',
          state: 'pending',
        }),
      ]);
    } finally {
      store.close();
    }
  });

  it('consumes only the active Delivery claim atomically', async () => {
    const store = await makeStore();
    try {
      store.accept(baseInput());
      store.finish('requester-1' as SessionId, 'review-round-1', { type: 'cancelled' });

      expect(
        store.claimDeliveryExecution('requester-1' as SessionId, 'review-round-1', {
          claimId: 'attempt-1',
          workerBootId: 'daemon-1',
        })
      ).toMatchObject({ status: 'claimed', delivery: { attemptCount: 0 } });
      expect(
        store.prepareClaimedDeliveryExecution(
          'requester-1' as SessionId,
          'review-round-1',
          'daemon-1',
          'stale-attempt'
        )
      ).toMatchObject({ prepared: false, delivery: { attemptCount: 0 } });
      expect(
        store.prepareClaimedDeliveryExecution(
          'requester-1' as SessionId,
          'review-round-1',
          'daemon-1',
          'attempt-1'
        )
      ).toMatchObject({ prepared: true, delivery: { attemptCount: 1 } });
      expect(
        store.consumeClaimedDelivery(
          'requester-1' as SessionId,
          'review-round-1',
          'daemon-1',
          'stale-attempt'
        )
      ).toMatchObject({ consumed: false, delivery: { state: 'pending' } });

      expect(
        store.consumeClaimedDelivery(
          'requester-1' as SessionId,
          'review-round-1',
          'daemon-1',
          'attempt-1'
        )
      ).toMatchObject({
        consumed: true,
        delivery: { state: 'consumed' },
      });
      expect(store.listPendingDeliveries('workspace-1' as WorkspaceId)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('fences terminal finalization without spending an execution attempt', async () => {
    const store = await makeStore();
    try {
      store.accept(baseInput());
      store.finish('requester-1' as SessionId, 'review-round-1', { type: 'cancelled' });

      expect(
        store.claimDeliveryFinalization('requester-1' as SessionId, 'review-round-1', {
          claimId: 'premature-exhaustion',
          workerBootId: 'worker-a',
          requireAttemptsExhausted: true,
        })
      ).toMatchObject({ status: 'not_ready', delivery: { attemptCount: 0 } });
      expect(
        store.claimDeliveryFinalization('requester-1' as SessionId, 'review-round-1', {
          claimId: 'finalization-a',
          workerBootId: 'worker-a',
        })
      ).toMatchObject({
        status: 'claimed',
        delivery: { attemptCount: 0, activeClaimId: 'finalization-a' },
      });
      expect(
        store.claimDeliveryExecution('requester-1' as SessionId, 'review-round-1', {
          claimId: 'attempt-b',
          workerBootId: 'worker-b',
        })
      ).toMatchObject({
        status: 'in_flight',
        delivery: { attemptCount: 0, activeClaimId: 'finalization-a' },
      });
      expect(
        store.consumeClaimedDelivery(
          'requester-1' as SessionId,
          'review-round-1',
          'worker-b',
          'finalization-a'
        )
      ).toMatchObject({ consumed: false, delivery: { state: 'pending' } });
      expect(
        store.consumeClaimedDelivery(
          'requester-1' as SessionId,
          'review-round-1',
          'worker-a',
          'finalization-a'
        )
      ).toMatchObject({ consumed: true, delivery: { state: 'consumed', attemptCount: 0 } });
    } finally {
      store.close();
    }
  });

  it('recovers an orphaned terminal claim without changing the execution count', async () => {
    const store = await makeStore();
    try {
      store.accept(baseInput());
      store.finish('requester-1' as SessionId, 'review-round-1', { type: 'cancelled' });
      expect(
        store.claimDeliveryFinalization('requester-1' as SessionId, 'review-round-1', {
          claimId: 'finalization-a',
          workerBootId: 'worker-a',
        })
      ).toMatchObject({ status: 'claimed', delivery: { attemptCount: 0 } });

      expect(store.recoverOrphanedDeliveryClaims('workspace-1' as WorkspaceId, 'worker-b')).toBe(1);
      expect(
        store.consumeClaimedDelivery(
          'requester-1' as SessionId,
          'review-round-1',
          'worker-a',
          'finalization-a'
        )
      ).toMatchObject({ consumed: false, delivery: { state: 'pending', attemptCount: 0 } });
      expect(
        store.claimDeliveryExecution('requester-1' as SessionId, 'review-round-1', {
          claimId: 'attempt-b',
          workerBootId: 'worker-b',
        })
      ).toMatchObject({ status: 'claimed', delivery: { attemptCount: 0 } });
    } finally {
      store.close();
    }
  });

  it('quarantines an orphaned claim after provider execution starts', async () => {
    const store = await makeStore();
    try {
      store.accept(baseInput());
      store.finish('requester-1' as SessionId, 'review-round-1', { type: 'cancelled' });
      expect(
        store.claimDeliveryExecution('requester-1' as SessionId, 'review-round-1', {
          claimId: 'attempt-a',
          workerBootId: 'worker-a',
        })
      ).toMatchObject({ status: 'claimed', delivery: { executionPhase: 'claimed' } });
      expect(
        store.prepareClaimedDeliveryExecution(
          'requester-1' as SessionId,
          'review-round-1',
          'worker-a',
          'attempt-a'
        )
      ).toMatchObject({
        prepared: true,
        delivery: { attemptCount: 1, executionPhase: 'prepared' },
      });
      expect(
        store.markClaimedDeliveryExecutionStarted(
          'requester-1' as SessionId,
          'review-round-1',
          'worker-a',
          'attempt-a'
        )
      ).toBe(true);

      expect(store.recoverOrphanedDeliveryClaims('workspace-1' as WorkspaceId, 'worker-b')).toBe(1);
      const recovered = store.getDelivery('requester-1' as SessionId, 'review-round-1');
      expect(recovered).toMatchObject({
        state: 'pending',
        executionPhase: 'uncertain',
        attemptCount: 1,
      });
      expect(recovered).not.toHaveProperty('activeClaimId');
      expect(
        store.claimDeliveryExecution('requester-1' as SessionId, 'review-round-1', {
          claimId: 'attempt-b',
          workerBootId: 'worker-b',
        })
      ).toMatchObject({ status: 'in_flight', delivery: { executionPhase: 'uncertain' } });
    } finally {
      store.close();
    }
  });

  it('permits one prepared Delivery recovery and then exhausts attempts', async () => {
    const store = await makeStore();
    try {
      store.accept(baseInput());
      store.finish('requester-1' as SessionId, 'review-round-1', { type: 'cancelled' });

      expect(
        store.claimDeliveryExecution('requester-1' as SessionId, 'review-round-1', {
          claimId: 'attempt-1',
          workerBootId: 'daemon-1',
        })
      ).toMatchObject({ status: 'claimed', delivery: { attemptCount: 0 } });
      expect(
        store.prepareClaimedDeliveryExecution(
          'requester-1' as SessionId,
          'review-round-1',
          'daemon-1',
          'attempt-1'
        )
      ).toMatchObject({ prepared: true, delivery: { attemptCount: 1 } });
      expect(
        store.releaseDeliveryClaim(
          'requester-1' as SessionId,
          'review-round-1',
          'daemon-1',
          'attempt-1'
        )
      ).toBe(true);
      expect(
        store.claimDeliveryExecution('requester-1' as SessionId, 'review-round-1', {
          claimId: 'attempt-2',
          workerBootId: 'daemon-1',
        })
      ).toMatchObject({ status: 'claimed', delivery: { attemptCount: 1 } });
      expect(
        store.prepareClaimedDeliveryExecution(
          'requester-1' as SessionId,
          'review-round-1',
          'daemon-1',
          'attempt-2'
        )
      ).toMatchObject({ prepared: true, delivery: { attemptCount: 2 } });
      expect(
        store.releaseDeliveryClaim(
          'requester-1' as SessionId,
          'review-round-1',
          'daemon-1',
          'attempt-2'
        )
      ).toBe(true);
      expect(
        store.claimDeliveryExecution('requester-1' as SessionId, 'review-round-1', {
          claimId: 'attempt-3',
          workerBootId: 'daemon-1',
        })
      ).toMatchObject({ status: 'exhausted', delivery: { attemptCount: 2, state: 'pending' } });
      expect(
        store.claimDeliveryFinalization('requester-1' as SessionId, 'review-round-1', {
          claimId: 'finalization-1',
          workerBootId: 'daemon-1',
          requireAttemptsExhausted: true,
        })
      ).toMatchObject({
        status: 'claimed',
        delivery: { attemptCount: 2, activeClaimId: 'finalization-1' },
      });
      expect(
        store.consumeClaimedDelivery(
          'requester-1' as SessionId,
          'review-round-1',
          'daemon-1',
          'finalization-1'
        )
      ).toMatchObject({ consumed: true, delivery: { state: 'consumed', attemptCount: 2 } });
    } finally {
      store.close();
    }
  });

  it('fences concurrent Workers and recovers only attempts from an older boot', async () => {
    const store = await makeStore();
    try {
      store.accept(baseInput());
      store.finish('requester-1' as SessionId, 'review-round-1', { type: 'cancelled' });

      expect(
        store.claimDeliveryExecution('requester-1' as SessionId, 'review-round-1', {
          claimId: 'attempt-a',
          workerBootId: 'worker-a',
        })
      ).toMatchObject({ status: 'claimed', delivery: { attemptCount: 0 } });
      expect(
        store.prepareClaimedDeliveryExecution(
          'requester-1' as SessionId,
          'review-round-1',
          'worker-a',
          'attempt-a'
        )
      ).toMatchObject({ prepared: true, delivery: { attemptCount: 1 } });
      expect(
        store.claimDeliveryExecution('requester-1' as SessionId, 'review-round-1', {
          claimId: 'attempt-b-before-barrier',
          workerBootId: 'worker-b',
        })
      ).toMatchObject({
        status: 'in_flight',
        delivery: {
          attemptCount: 1,
          activeClaimId: 'attempt-a',
          activeClaimWorkerBootId: 'worker-a',
        },
      });
      expect(store.recoverOrphanedDeliveryClaims('workspace-1' as WorkspaceId, 'worker-a')).toBe(0);
      expect(store.recoverOrphanedDeliveryClaims('workspace-1' as WorkspaceId, 'worker-b')).toBe(1);
      expect(
        store.claimDeliveryExecution('requester-1' as SessionId, 'review-round-1', {
          claimId: 'attempt-b',
          workerBootId: 'worker-b',
        })
      ).toMatchObject({
        status: 'claimed',
        delivery: { attemptCount: 1, activeClaimWorkerBootId: 'worker-b' },
      });
      expect(
        store.prepareClaimedDeliveryExecution(
          'requester-1' as SessionId,
          'review-round-1',
          'worker-b',
          'attempt-b'
        )
      ).toMatchObject({ prepared: true, delivery: { attemptCount: 2 } });

      expect(
        store.releaseDeliveryClaim(
          'requester-1' as SessionId,
          'review-round-1',
          'worker-a',
          'attempt-a'
        )
      ).toBe(false);
      expect(
        store.consumeClaimedDelivery(
          'requester-1' as SessionId,
          'review-round-1',
          'worker-a',
          'attempt-a'
        )
      ).toMatchObject({
        consumed: false,
        delivery: { state: 'pending', activeClaimId: 'attempt-b' },
      });
      expect(
        store.claimDeliveryFinalization('requester-1' as SessionId, 'review-round-1', {
          claimId: 'finalization-a',
          workerBootId: 'worker-a',
          requireAttemptsExhausted: true,
        })
      ).toMatchObject({ status: 'in_flight', delivery: { activeClaimId: 'attempt-b' } });
      expect(
        store.consumeClaimedDelivery(
          'requester-1' as SessionId,
          'review-round-1',
          'worker-a',
          'finalization-a'
        )
      ).toMatchObject({ consumed: false, delivery: { state: 'pending' } });
    } finally {
      store.close();
    }
  });

  it('delivers the same caller-chosen operation id independently for two Sessions', async () => {
    const store = await makeStore();
    try {
      const completion = { type: 'cancelled' as const };
      store.accept(baseInput());
      store.accept({
        ...baseInput(),
        requesterSessionId: 'requester-2' as SessionId,
      });

      store.finish('requester-1' as SessionId, 'review-round-1', completion);
      store.finish('requester-2' as SessionId, 'review-round-1', completion);

      expect(store.listPendingDeliveries('workspace-1' as WorkspaceId)).toEqual([
        expect.objectContaining({
          requesterSessionId: 'requester-1',
          deliveryId: 'operation:requester-1:review-round-1:completion',
        }),
        expect.objectContaining({
          requesterSessionId: 'requester-2',
          deliveryId: 'operation:requester-2:review-round-1:completion',
        }),
      ]);
    } finally {
      store.close();
    }
  });

  it('serializes item materialization across local processes and permits stale adoption', async () => {
    let nowMs = 1_000;
    const store = await makeStore(() => nowMs);
    try {
      const accepted = store.accept(baseInput(), { materializationClaimToken: 'acceptor' });
      expect(accepted.claimedItemIndexes).toEqual([0]);
      expect(
        store.claimItemMaterialization(
          'requester-1' as SessionId,
          'review-round-1',
          0,
          'lease-owner'
        )
      ).toEqual({ claimed: false, retryAtMs: 61_000 });

      nowMs = 61_000;
      expect(
        store.claimItemMaterialization(
          'requester-1' as SessionId,
          'review-round-1',
          0,
          'lease-owner'
        )
      ).toEqual({ claimed: true });
      expect(
        store.markItemInputDurable('requester-1' as SessionId, 'review-round-1', 0, 'acceptor')
          .items[0]
      ).toMatchObject({ inputDurable: false });
      expect(
        store.markItemInputDurable('requester-1' as SessionId, 'review-round-1', 0, 'lease-owner')
          .items[0]
      ).toMatchObject({ inputDurable: true });
    } finally {
      store.close();
    }
  });

  it('retains pending Delivery past seven days and cleans only consumed rows', async () => {
    let nowMs = Date.parse('2026-07-20T00:00:00Z');
    const store = await makeStore(() => nowMs);
    try {
      store.accept(baseInput());
      store.finish('requester-1' as SessionId, 'review-round-1', {
        type: 'cancelled',
      });
      nowMs += 8 * 24 * 60 * 60 * 1_000;

      expect(store.get('requester-1' as SessionId, 'review-round-1').state).toBe('finished');
      expect(
        store.claimDeliveryFinalization('requester-1' as SessionId, 'review-round-1', {
          claimId: 'retention-finalization',
          workerBootId: 'daemon-1',
        })
      ).toMatchObject({ status: 'claimed' });
      expect(
        store.consumeClaimedDelivery(
          'requester-1' as SessionId,
          'review-round-1',
          'daemon-1',
          'retention-finalization'
        )
      ).toMatchObject({ consumed: true });
      nowMs += 8 * 24 * 60 * 60 * 1_000;

      expect(() => store.get('requester-1' as SessionId, 'review-round-1')).toThrowError(
        expect.objectContaining<LodyOperationStoreError>({ code: 'OPERATION_NOT_FOUND' })
      );
    } finally {
      store.close();
    }
  });

  it('wins cancellation once and preserves the first terminal completion', async () => {
    const store = await makeStore();
    try {
      store.accept(baseInput());
      const first = store.cancel('requester-1' as SessionId, 'review-round-1');
      const retry = store.cancel('requester-1' as SessionId, 'review-round-1');

      expect(first.didCancel).toBe(true);
      expect(retry.didCancel).toBe(false);
      expect(retry.operation.completion?.type).toBe('cancelled');
      expect(store.listPendingDeliveries('workspace-1' as WorkspaceId)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('shares accepted intent across local processes and adopts it after reopen', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lody-operation-store-shared-'));
    roots.add(root);
    const dbPath = path.join(root, 'operations.sqlite3');
    const acceptingProcess = new LodyOperationStore(dbPath);
    const leaseOwnerProcess = new LodyOperationStore(dbPath);
    try {
      acceptingProcess.accept(baseInput());

      expect(
        leaseOwnerProcess.accept({
          ...baseInput(),
          canonicalCommand: { target: 'target-1', prompt: 'review' },
        })
      ).toMatchObject({ created: false, operation: { operationId: 'review-round-1' } });

      expect(
        leaseOwnerProcess.listActive('workspace-1' as WorkspaceId, 'machine-1' as MachineId)
      ).toEqual([
        expect.objectContaining({
          operationId: 'review-round-1',
          items: [expect.objectContaining({ inputDurable: false })],
        }),
      ]);
    } finally {
      acceptingProcess.close();
      leaseOwnerProcess.close();
    }

    const replacementLeaseOwner = new LodyOperationStore(dbPath);
    try {
      expect(replacementLeaseOwner.get('requester-1' as SessionId, 'review-round-1')).toMatchObject(
        { state: 'active', operationId: 'review-round-1' }
      );
    } finally {
      replacementLeaseOwner.close();
    }
  });

  it('bounds completion text while preserving structure and exact omission bytes', async () => {
    const store = await makeStore();
    try {
      store.accept(baseInput());
      const originalMessage = 'failure '.repeat(20_000);
      const finished = store.finish('requester-1' as SessionId, 'review-round-1', {
        type: 'result',
        value: {
          items: [
            {
              status: 'failed',
              target: { sessionId: 'target-1' as SessionId, userTurnId: 'turn-1' },
              error: { code: 'TARGET_FAILED', message: originalMessage, retryable: false },
            },
          ],
        },
      });
      expect(Buffer.byteLength(JSON.stringify(finished.completion), 'utf8')).toBeLessThanOrEqual(
        LODY_OPERATION_COMPLETION_MAX_BYTES
      );
      expect(finished.completion).toMatchObject({
        type: 'result',
        value: { items: [{ target: { sessionId: 'target-1', userTurnId: 'turn-1' } }] },
        truncation: { truncated: true },
      });
      if (finished.completion?.type !== 'result') throw new Error('expected result');
      const item = finished.completion.value.items[0];
      if (item?.status !== 'failed') throw new Error('expected failed item');
      const keptOriginalBytes = Buffer.byteLength(item.error.message.replace('\n…\n', ''), 'utf8');
      expect(finished.completion.truncation?.omittedBytes).toBe(
        Buffer.byteLength(originalMessage, 'utf8') - keptOriginalBytes
      );
    } finally {
      store.close();
    }
  });

  it('persists bounded assistant output previews on successful items', async () => {
    const store = await makeStore();
    try {
      store.accept(baseInput());
      const originalOutput = 'result 🚀'.repeat(20_000);
      const finished = store.finish('requester-1' as SessionId, 'review-round-1', {
        type: 'result',
        value: {
          items: [
            {
              status: 'succeeded',
              target: { sessionId: 'target-1' as SessionId, userTurnId: 'turn-1' },
              assistantTurnId: 'assistant:turn-1',
              output: { text: originalOutput },
            },
          ],
        },
      });
      if (finished.completion?.type !== 'result') throw new Error('expected result');
      const item = finished.completion.value.items[0];
      if (item?.status !== 'succeeded' || !item.output) {
        throw new Error('expected succeeded output');
      }
      expect(Buffer.byteLength(JSON.stringify(finished.completion), 'utf8')).toBeLessThanOrEqual(
        LODY_OPERATION_COMPLETION_MAX_BYTES
      );
      expect(item.output).toMatchObject({ truncated: true });
      expect(item.output.text).not.toContain('�');
    } finally {
      store.close();
    }
  });
});

describe('canonicalizeLodyCommand', () => {
  it('sorts object keys but preserves array order', () => {
    expect(canonicalizeLodyCommand({ b: 2, a: [{ z: 1, y: 2 }, 3] })).toBe(
      '{"a":[{"y":2,"z":1},3],"b":2}'
    );
  });
});

const readLastCleanupAtMs = (dbPath: string): string | undefined => {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(`SELECT value FROM orchestration_meta WHERE key = 'last_cleanup_at_ms'`)
      .get() as { value: string } | undefined;
    return row?.value;
  } finally {
    db.close();
  }
};

describe('maintenance-free open', () => {
  it('skips open-time repair/cleanup writes but still serves reads and writes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lody-operation-store-maint-'));
    roots.add(root);
    const dbPath = path.join(root, 'operations.sqlite3');
    const now = () => Date.parse('2026-07-20T00:00:00Z');

    const nonOwner = new LodyOperationStore(dbPath, now, { maintenance: false });
    try {
      // No open-time cleanup ran, so the cleanup watermark was never written.
      expect(readLastCleanupAtMs(dbPath)).toBeUndefined();
      // The store is still fully usable for regular operations.
      expect(nonOwner.accept(baseInput()).created).toBe(true);
    } finally {
      nonOwner.close();
    }

    const owner = new LodyOperationStore(dbPath, now);
    try {
      // A default (owner) open performs maintenance and writes the watermark.
      expect(readLastCleanupAtMs(dbPath)).toBe(String(now()));
    } finally {
      owner.close();
    }
  });
});

describe('runWithOperationStoreBusyRetry', () => {
  const busyError = (code: string) => Object.assign(new Error('database is locked'), { code });

  it('retries SQLITE_BUSY with backoff and returns the eventual result', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const result = await runWithOperationStoreBusyRetry(
      () => {
        attempts += 1;
        if (attempts < 3) throw busyError('SQLITE_BUSY');
        return 'ok';
      },
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([100, 300]);
  });

  it('surfaces exhausted busy retries as a retryable STORE_BUSY error', async () => {
    let attempts = 0;
    await expect(
      runWithOperationStoreBusyRetry(
        () => {
          attempts += 1;
          throw busyError('SQLITE_BUSY_SNAPSHOT');
        },
        { sleep: async () => undefined }
      )
    ).rejects.toMatchObject({
      name: 'LodyOperationStoreError',
      code: 'STORE_BUSY',
      retryable: true,
    });
    expect(attempts).toBe(4);
  });

  it('rethrows non-busy errors immediately without sleeping', async () => {
    const sleeps: number[] = [];
    await expect(
      runWithOperationStoreBusyRetry(
        () => {
          throw new LodyOperationStoreError('OPERATION_NOT_FOUND', 'missing', false);
        },
        {
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        }
      )
    ).rejects.toMatchObject({ code: 'OPERATION_NOT_FOUND' });
    expect(sleeps).toEqual([]);
  });

  it('classifies only SQLITE_BUSY-family errors as busy', () => {
    expect(isOperationStoreBusyError(busyError('SQLITE_BUSY'))).toBe(true);
    expect(isOperationStoreBusyError(busyError('SQLITE_BUSY_SNAPSHOT'))).toBe(true);
    expect(isOperationStoreBusyError(busyError('SQLITE_CONSTRAINT'))).toBe(false);
    expect(isOperationStoreBusyError(new Error('database is locked'))).toBe(false);
    expect(isOperationStoreBusyError('database is locked')).toBe(false);
  });
});
