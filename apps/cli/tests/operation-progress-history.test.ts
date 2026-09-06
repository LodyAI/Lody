import { describe, expect, it } from 'vitest';

import type {
  LodyOperationItemResult,
  SessionHistoryInput,
  SessionId,
  StoredLodyOperation,
} from '@lody/shared';
import {
  buildOperationProgressContent,
  getOperationProgressTargetKey,
  getOperationProgressTurnId,
  upsertOperationProgressHistory,
} from '../src/orchestration/operation-progress-history';

const baseOperation = (items: LodyOperationItemResult[]): StoredLodyOperation => ({
  workspaceId: 'workspace-1' as StoredLodyOperation['workspaceId'],
  ownerMachineId: 'machine-1' as StoredLodyOperation['ownerMachineId'],
  requesterSessionId: 'requester-1' as SessionId,
  requesterUserId: 'user-1',
  operationId: 'op-1',
  kind: 'session_create_many',
  fingerprint: 'fingerprint',
  canonicalCommand: {},
  frozenContinuationConfig: { inputConfig: {} },
  initiatorChainDepth: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  deadlineAt: '2026-01-02T00:00:00.000Z',
  state: 'active',
  items,
});

describe('operation progress history', () => {
  it('maps create operation items to UI progress statuses without exposing preallocated ids', () => {
    const runningTarget = { sessionId: 'session-running' as SessionId, userTurnId: 'turn-running' };
    const operation = baseOperation([
      {
        status: 'active',
        label: 'preallocated target',
        target: { sessionId: 'session-preallocated' as SessionId, userTurnId: 'turn-preallocated' },
        inputDurable: false,
      },
      {
        status: 'active',
        label: 'created target',
        target: { sessionId: 'session-created' as SessionId, userTurnId: 'turn-created' },
        inputDurable: true,
      },
      {
        status: 'active',
        label: 'running target',
        target: runningTarget,
        inputDurable: true,
      },
      {
        status: 'succeeded',
        target: { sessionId: 'session-succeeded' as SessionId, userTurnId: 'turn-succeeded' },
        assistantTurnId: 'assistant-1',
      },
      {
        status: 'failed',
        target: { sessionId: 'session-failed' as SessionId, userTurnId: 'turn-failed' },
        error: { code: 'TARGET_FAILED', message: 'failed', retryable: false },
      },
      { status: 'failed', error: { code: 'INVALID_ITEM', message: 'invalid', retryable: false } },
    ]);

    expect(
      buildOperationProgressContent(
        operation,
        new Map([
          [getOperationProgressTargetKey(runningTarget), 'running'],
          [
            getOperationProgressTargetKey({
              sessionId: 'session-failed' as SessionId,
              userTurnId: 'turn-failed',
            }),
            'failed',
          ],
        ])
      )
    ).toEqual({
      type: 'operation_progress',
      operationId: 'op-1',
      operationKind: 'session_create_many',
      items: [
        {
          label: 'created target',
          target: { sessionId: 'session-created', userTurnId: 'turn-created' },
          status: 'created',
        },
        {
          label: 'running target',
          target: { sessionId: 'session-running', userTurnId: 'turn-running' },
          status: 'running',
        },
        {
          target: { sessionId: 'session-succeeded', userTurnId: 'turn-succeeded' },
          status: 'succeeded',
        },
        {
          target: { sessionId: 'session-failed', userTurnId: 'turn-failed' },
          status: 'failed',
        },
      ],
    });
  });

  it('renders active create targets as cancelled when the operation is cancelled', () => {
    const operation: StoredLodyOperation = {
      ...baseOperation([
        {
          status: 'active',
          target: { sessionId: 'session-1' as SessionId, userTurnId: 'turn-1' },
          inputDurable: true,
        },
      ]),
      state: 'finished',
      completion: { type: 'cancelled', partial: { items: [] } },
      finishedAt: '2026-01-01T00:01:00.000Z',
    };

    expect(buildOperationProgressContent(operation)?.items).toEqual([
      { target: { sessionId: 'session-1', userTurnId: 'turn-1' }, status: 'cancelled' },
    ]);
  });

  it('renders active create targets as failed when the operation ends in a terminal error', () => {
    const operation: StoredLodyOperation = {
      ...baseOperation([
        {
          status: 'active',
          target: { sessionId: 'session-1' as SessionId, userTurnId: 'turn-1' },
          inputDurable: true,
        },
      ]),
      state: 'finished',
      completion: {
        type: 'error',
        error: { code: 'COORDINATOR_FAILED', message: 'deadline failed', retryable: false },
      },
      finishedAt: '2026-01-01T00:01:00.000Z',
    };

    expect(buildOperationProgressContent(operation)?.items).toEqual([
      { target: { sessionId: 'session-1', userTurnId: 'turn-1' }, status: 'failed' },
    ]);
  });

  it('omits failed terminal targets without materialization evidence', () => {
    const operation = baseOperation([
      {
        status: 'failed',
        target: { sessionId: 'session-never-created' as SessionId, userTurnId: 'turn-1' },
        error: { code: 'TARGET_TIMEOUT', message: 'timeout', retryable: false },
      },
    ]);

    expect(buildOperationProgressContent(operation)).toBeNull();
  });

  it('updates one stable system history entry instead of appending progress turns', async () => {
    let history: SessionHistoryInput[] = [
      {
        id: 'user-1',
        role: 'user',
        timestamp: '2026-01-01T00:00:00.000Z',
        items: [{ type: 'text', text: 'create sessions' }],
        fileDiff: [],
      },
    ];
    const doc = {
      updateHistory: async (updater: (input: SessionHistoryInput[]) => SessionHistoryInput[]) => {
        history = updater(history);
      },
    };
    const initial = baseOperation([
      {
        status: 'active',
        target: { sessionId: 'session-1' as SessionId, userTurnId: 'turn-1' },
        inputDurable: false,
      },
    ]);
    await upsertOperationProgressHistory(doc, initial, () =>
      Date.parse('2026-01-01T00:00:01.000Z')
    );
    await upsertOperationProgressHistory(
      doc,
      {
        ...initial,
        items: [
          {
            status: 'active',
            target: { sessionId: 'session-1' as SessionId, userTurnId: 'turn-1' },
            inputDurable: true,
          },
        ],
      },
      () => Date.parse('2026-01-01T00:00:02.000Z')
    );
    await upsertOperationProgressHistory(
      doc,
      {
        ...initial,
        items: [
          {
            status: 'active',
            target: { sessionId: 'session-1' as SessionId, userTurnId: 'turn-1' },
            inputDurable: true,
          },
        ],
      },
      () => Date.parse('2026-01-01T00:00:03.000Z'),
      new Map([
        [
          getOperationProgressTargetKey({
            sessionId: 'session-1' as SessionId,
            userTurnId: 'turn-1',
          }),
          'running',
        ],
      ])
    );

    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({
      id: getOperationProgressTurnId('requester-1' as SessionId, 'op-1'),
      role: 'system',
      userId: 'user-1',
      timestamp: '2026-01-01T00:00:02.000Z',
      finished: true,
      items: [
        {
          type: 'operation_progress',
          operationId: 'op-1',
          operationKind: 'session_create_many',
          items: [{ target: { sessionId: 'session-1', userTurnId: 'turn-1' }, status: 'running' }],
        },
      ],
    });
  });

  it('monotonically merges progress without removing previously published targets', async () => {
    let history: SessionHistoryInput[] = [
      {
        id: getOperationProgressTurnId('requester-1' as SessionId, 'op-1'),
        role: 'system',
        userId: 'user-1',
        timestamp: '2026-01-01T00:00:01.000Z',
        fileDiff: [],
        finished: true,
        items: [
          {
            type: 'operation_progress',
            operationId: 'op-1',
            operationKind: 'session_create_many',
            items: [
              {
                target: { sessionId: 'session-1' as SessionId, userTurnId: 'turn-1' },
                status: 'running',
              },
              {
                target: { sessionId: 'session-2' as SessionId, userTurnId: 'turn-2' },
                status: 'succeeded',
              },
            ],
          },
        ],
      },
    ];
    const doc = {
      updateHistory: async (updater: (input: SessionHistoryInput[]) => SessionHistoryInput[]) => {
        history = updater(history);
      },
    };

    await upsertOperationProgressHistory(
      doc,
      baseOperation([
        {
          status: 'active',
          target: { sessionId: 'session-1' as SessionId, userTurnId: 'turn-1' },
          inputDurable: true,
        },
        {
          status: 'active',
          target: { sessionId: 'session-3' as SessionId, userTurnId: 'turn-3' },
          inputDurable: false,
        },
      ]),
      () => Date.parse('2026-01-01T00:00:02.000Z')
    );

    expect(history[0]?.timestamp).toBe('2026-01-01T00:00:01.000Z');
    expect(history[0]?.items).toEqual([
      {
        type: 'operation_progress',
        operationId: 'op-1',
        operationKind: 'session_create_many',
        items: [
          {
            target: { sessionId: 'session-1', userTurnId: 'turn-1' },
            status: 'running',
          },
          {
            target: { sessionId: 'session-2', userTurnId: 'turn-2' },
            status: 'succeeded',
          },
        ],
      },
    ]);
  });
});

it.each(['failed', 'cancelled'] as const)(
  'finishes a previously published card as %s when target metadata is unavailable',
  async (status) => {
    let history: SessionHistoryInput[] = [];
    const doc = {
      updateHistory: async (updater: (input: SessionHistoryInput[]) => SessionHistoryInput[]) => {
        history = updater(history);
      },
    };
    const target = { sessionId: 'materialized-child' as SessionId, userTurnId: 'child-turn' };
    const now = () => Date.parse('2026-01-01T00:00:01.000Z');
    await upsertOperationProgressHistory(
      doc,
      baseOperation([{ status: 'active', target, inputDurable: true }]),
      now,
      new Map([[getOperationProgressTargetKey(target), 'running']])
    );
    const terminal: LodyOperationItemResult =
      status === 'failed'
        ? {
            status,
            target,
            error: { code: 'TARGET_TIMEOUT', message: 'Target unavailable', retryable: false },
          }
        : { status, target };
    await upsertOperationProgressHistory(doc, baseOperation([terminal]), now);
    expect(history).toHaveLength(1);
    expect(history[0]?.items).toEqual([
      {
        type: 'operation_progress',
        operationId: 'op-1',
        operationKind: 'session_create_many',
        items: [{ target, status }],
      },
    ]);
    // The same preallocated id without prior materialization evidence is not a card.
    history = [];
    await upsertOperationProgressHistory(doc, baseOperation([terminal]), now);
    expect(history).toEqual([]);
  }
);
