import { describe, expect, it } from 'vitest';
import { Loro } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import { sessionDocSchema } from '@lody/shared';

import type {
  LodyOperationItemResult,
  OperationProgressContent,
  OperationProgressStatus,
  SessionHistoryInput,
  SessionId,
  StoredLodyOperation,
} from '@lody/shared';
import {
  buildOperationProgressContent,
  mergeOperationProgressContent,
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

  it('does not freeze a target as cancelled merely because the root was cancelled', () => {
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
      { target: { sessionId: 'session-1', userTurnId: 'turn-1' }, status: 'created' },
    ]);
  });

  it('does not freeze a target as failed merely because the root ended in error', () => {
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
      { target: { sessionId: 'session-1', userTurnId: 'turn-1' }, status: 'created' },
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
      getHistory: async () => history,
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
      getHistory: async () => history,
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
  'preserves a timeout snapshot but applies confirmed %s when metadata is unavailable',
  async (status) => {
    let history: SessionHistoryInput[] = [];
    const doc = {
      getHistory: async () => history,
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
        items: [{ target, status: status === 'failed' ? 'running' : status }],
      },
    ]);
    // The same preallocated id without prior materialization evidence is not a card.
    history = [];
    await upsertOperationProgressHistory(doc, baseOperation([terminal]), now);
    expect(history).toEqual([]);
  }
);

it.each(['succeeded', 'failed', 'cancelled'] as const)(
  'persists created/running/%s through the real Loro history validator and snapshot reload',
  async (terminalStatus) => {
    const doc = new Loro();
    const mirror = new Mirror({
      doc,
      schema: sessionDocSchema,
      initialState: { session: { id: 'requester-1' as SessionId }, history: [], mq: [] },
      throwOnValidationError: true,
      validateOnUpdate: true,
      strict: false,
    });
    const sessionDoc = {
      getHistory: async () => mirror.getState().history,
      updateHistory: async (updater: (history: SessionHistoryInput[]) => SessionHistoryInput[]) => {
        mirror.setState((state) => ({ ...state, history: updater(state.history) }));
      },
    };
    const target = { sessionId: 'child-1' as SessionId, userTurnId: 'child-turn-1' };
    const operation = baseOperation([{ status: 'active', target, inputDurable: true }]);
    const now = () => Date.parse('2026-01-01T00:00:01.000Z');
    try {
      for (const status of ['created', 'running', terminalStatus] as const) {
        const item: LodyOperationItemResult =
          status === 'succeeded'
            ? { status, target, assistantTurnId: 'child-answer' }
            : status === 'failed'
              ? {
                  status,
                  target,
                  error: { code: 'TARGET_FAILED', message: 'Failed', retryable: false },
                }
              : status === 'cancelled'
                ? { status, target }
                : { status: 'active', target, inputDurable: true };
        const updated = { ...operation, items: [item] };
        await upsertOperationProgressHistory(
          sessionDoc,
          updated,
          now,
          new Map([[getOperationProgressTargetKey(target), status]])
        );
        const revivedDoc = new Loro();
        revivedDoc.import(doc.export({ mode: 'snapshot' }));
        const revived = new Mirror({
          doc: revivedDoc,
          schema: sessionDocSchema,
          throwOnValidationError: true,
          strict: false,
        });
        try {
          expect(revived.getState().history).toHaveLength(1);
          expect(revived.getState().history[0]).toMatchObject({
            id: getOperationProgressTurnId(operation.requesterSessionId, operation.operationId),
            role: 'system',
            items: [
              {
                type: 'operation_progress',
                operationId: operation.operationId,
                operationKind: 'session_create_many',
                items: [{ target, status }],
              },
            ],
          });
        } finally {
          revived.dispose();
        }
      }
    } finally {
      mirror.dispose();
    }
  }
);

it.each(['cancelled', 'error'] as const)(
  'preserves fresh target evidence after root %s without treating prior cards as fresh',
  async (completionType) => {
    const target = { sessionId: 'child-1' as SessionId, userTurnId: 'turn-1' };
    const operation: StoredLodyOperation = {
      ...baseOperation([{ status: 'active', target, inputDurable: true }]),
      state: 'finished',
      completion:
        completionType === 'cancelled'
          ? { type: 'cancelled' }
          : {
              type: 'error',
              error: { code: 'COORDINATOR_FAILED', message: 'Unavailable', retryable: false },
            },
    };
    const now = () => Date.parse('2026-01-01T00:00:01.000Z');
    let history: SessionHistoryInput[] = [];
    const doc = {
      getHistory: async () => history,
      updateHistory: async (update: (history: SessionHistoryInput[]) => SessionHistoryInput[]) => {
        history = update(history);
      },
    };
    const statusOf = () => {
      const content = history[0]?.items?.[0];
      return content?.type === 'operation_progress' ? content.items[0]?.status : undefined;
    };
    for (const status of ['running', 'succeeded', 'failed', 'cancelled'] as const) {
      expect(
        buildOperationProgressContent(
          operation,
          new Map([[getOperationProgressTargetKey(target), status]])
        )?.items
      ).toEqual([{ target, status }]);
    }
    // A failed best-effort cancellation must not freeze the card as cancelled.
    await upsertOperationProgressHistory(
      doc,
      operation,
      now,
      new Map([[getOperationProgressTargetKey(target), 'running']])
    );
    expect(statusOf()).toBe('running');
    await upsertOperationProgressHistory(
      doc,
      operation,
      now,
      new Map([[getOperationProgressTargetKey(target), 'succeeded']])
    );
    expect(statusOf()).toBe('succeeded');

    history = [];
    await upsertOperationProgressHistory(
      doc,
      operation,
      now,
      new Map([[getOperationProgressTargetKey(target), 'running']])
    );
    await upsertOperationProgressHistory(doc, operation, now);
    expect(statusOf()).toBe('running');
  }
);

it.each(['running', 'succeeded'] as const)(
  'keeps fresh target %s despite a stored TARGET_TIMEOUT',
  async (status) => {
    const target = { sessionId: 'timeout-child' as SessionId, userTurnId: 'timeout-turn' };
    const operation = baseOperation([
      {
        status: 'failed',
        target,
        error: { code: 'TARGET_TIMEOUT', message: 'Deadline reached', retryable: false },
      },
    ]);
    expect(
      buildOperationProgressContent(
        operation,
        new Map([[getOperationProgressTargetKey(target), status]])
      )?.items
    ).toEqual([{ target, status }]);
  }
);

it('preserves all 25 merge transitions, including terminal labels and running-to-created regressions', () => {
  const statuses: OperationProgressStatus[] = [
    'created',
    'running',
    'succeeded',
    'failed',
    'cancelled',
  ];
  const target = { sessionId: 'merge-child' as SessionId, userTurnId: 'merge-turn' };
  for (const before of statuses) {
    for (const after of statuses) {
      const previous = { target, status: before, label: 'original' };
      const incoming = { target, status: after, label: 'updated' };
      const content: OperationProgressContent = {
        type: 'operation_progress',
        operationId: 'merge',
        operationKind: 'session_create',
        items: [previous],
      };
      const keepPrevious =
        ['succeeded', 'failed', 'cancelled'].includes(before) ||
        (before === 'running' && after === 'created');
      expect(
        mergeOperationProgressContent(content, { ...content, items: [incoming] }).items,
        `${before} -> ${after}`
      ).toEqual([keepPrevious ? previous : incoming]);
    }
  }
});

it('keeps the original history object for identical progress snapshots', async () => {
  let history: SessionHistoryInput[] = [];
  const doc = {
    getHistory: async () => history,
    updateHistory: async (update: (value: SessionHistoryInput[]) => SessionHistoryInput[]) => {
      history = update(history);
    },
  };
  const operation = baseOperation([
    {
      status: 'active',
      inputDurable: true,
      target: { sessionId: 'unchanged-child' as SessionId, userTurnId: 'unchanged-turn' },
    },
  ]);
  await upsertOperationProgressHistory(doc, operation, () => 0);
  const first = history;
  await upsertOperationProgressHistory(doc, operation, () => 1);
  expect(history).toBe(first);
});

it('compacts concurrent same-id inserts after a real two-replica merge without losing newer states', async () => {
  const seedDoc = new Loro();
  const seed = new Mirror({
    doc: seedDoc,
    schema: sessionDocSchema,
    initialState: { session: { id: 'requester-1' as SessionId }, history: [], mq: [] },
    strict: false,
  });
  const base = seedDoc.export({ mode: 'snapshot' });
  seed.dispose();
  const leftDoc = new Loro();
  leftDoc.import(base);
  const rightDoc = new Loro();
  rightDoc.import(base);
  const left = new Mirror({
    doc: leftDoc,
    schema: sessionDocSchema,
    strict: false,
    throwOnValidationError: true,
  });
  const right = new Mirror({
    doc: rightDoc,
    schema: sessionDocSchema,
    strict: false,
    throwOnValidationError: true,
  });
  const adapter = (mirror: typeof left) => ({
    handle: { doc: mirror === left ? leftDoc : rightDoc },
    getHistory: async () => mirror.getState().history,
    updateHistory: async (update: (history: SessionHistoryInput[]) => SessionHistoryInput[]) => {
      mirror.setState((state) => ({ ...state, history: update(state.history) }));
    },
  });
  const target = { sessionId: 'concurrent-child' as SessionId, userTurnId: 'same-turn' };
  const created = baseOperation([{ status: 'active', inputDurable: true, target }]);
  const succeeded = baseOperation([{ status: 'succeeded', target, assistantTurnId: 'answer' }]);
  try {
    await upsertOperationProgressHistory(adapter(left), created, () => 0);
    await upsertOperationProgressHistory(adapter(right), succeeded, () => 0);
    leftDoc.import(rightDoc.export({ mode: 'snapshot' }));
    // Mirror processes remote events before its next state read.
    expect(left.getState().history).toHaveLength(2);
    await expect(
      upsertOperationProgressHistory(
        {
          handle: { doc: leftDoc },
          getHistory: async () => left.getState().history,
          updateHistory: async () => {
            throw new Error('interrupted after durable aliasing');
          },
        },
        created,
        () => 1
      )
    ).rejects.toThrow('interrupted after durable aliasing');
    // A peer can recover the intermediate state without losing either snapshot.
    rightDoc.import(leftDoc.export({ mode: 'snapshot' }));
    expect(right.getState().history).toHaveLength(2);
    expect(new Set(right.getState().history.map((row) => row.id)).size).toBe(2);
    await upsertOperationProgressHistory(adapter(left), created, () => 1);
    expect(left.getState().history).toHaveLength(1);
    expect(left.getState().history[0]?.items).toMatchObject([
      { type: 'operation_progress', items: [{ target, status: 'succeeded' }] },
    ]);
    rightDoc.import(leftDoc.export({ mode: 'snapshot' }));
    expect(right.getState().history).toHaveLength(1);
    expect(right.getState().history[0]?.items).toMatchObject([
      { type: 'operation_progress', items: [{ target, status: 'succeeded' }] },
    ]);
  } finally {
    left.dispose();
    right.dispose();
  }
});

it('preserves a published label when a later snapshot omits it', () => {
  const target = { sessionId: 'labelled-child' as SessionId, userTurnId: 'turn-1' };
  const content: OperationProgressContent = {
    type: 'operation_progress',
    operationKind: 'session_create',
    operationId: 'label-test',
    items: [{ target, status: 'created', label: 'Keep this label' }],
  };
  expect(
    mergeOperationProgressContent(content, {
      ...content,
      items: [{ target, status: 'running' }],
    }).items
  ).toEqual([{ target, status: 'running', label: 'Keep this label' }]);
});

it('does not notify real Mirror subscribers when progress is unchanged or absent', async () => {
  const mirror = new Mirror({
    doc: new Loro(),
    schema: sessionDocSchema,
    initialState: { session: { id: 'requester-1' as SessionId }, history: [], mq: [] },
    strict: false,
  });
  let notifications = 0;
  const unsubscribe = mirror.subscribe(() => {
    notifications++;
  });
  const doc = {
    getHistory: async () => mirror.getState().history,
    updateHistory: async (update: (history: SessionHistoryInput[]) => SessionHistoryInput[]) => {
      mirror.setState((state) => ({ ...state, history: update(state.history) }));
    },
  };
  const target = { sessionId: 'child' as SessionId, userTurnId: 'child-turn' };
  try {
    await upsertOperationProgressHistory(doc, baseOperation([]), () => 0);
    expect(notifications).toBe(0);
    const operation = baseOperation([{ status: 'active', inputDurable: true, target }]);
    await upsertOperationProgressHistory(doc, operation, () => 0);
    expect(notifications).toBe(1);
    await upsertOperationProgressHistory(doc, operation, () => 1);
    expect(notifications).toBe(1);
    await upsertOperationProgressHistory(
      doc,
      operation,
      () => 2,
      new Map([[getOperationProgressTargetKey(target), 'running']])
    );
    expect(notifications).toBe(2);
  } finally {
    unsubscribe();
    mirror.dispose();
  }
});
