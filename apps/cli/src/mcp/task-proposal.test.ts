import { withHistoryPort } from '../../tests/history-port-fixture';
import { describe, expect, it } from 'vitest';
import { type SessionHistoryInput, type SessionId, type TaskProposalMeta } from '@lody/shared';
import { LodyOperationStoreError } from '@/orchestration/operation-store';

import { publishTaskProposal, type TaskProposalPersistence } from './task-proposal';

const SESSION_ID = 'session-1' as SessionId;
const NOW = Date.parse('2026-07-30T10:00:00.000Z');

const proposalMetaFrom = (history: SessionHistoryInput[]): TaskProposalMeta => {
  const item = history[0]?.items?.[0];
  if (item?.type !== 'system_notice' || item.name !== 'task_proposal' || !item.meta) {
    throw new Error('Expected a task proposal');
  }
  return item.meta;
};

const makePersistence = (initialHistory: SessionHistoryInput[] = []) => {
  let history = initialHistory;
  let commitFailures = 0;
  let flushCount = 0;
  const syncReasons: string[] = [];

  const manager: TaskProposalPersistence = {
    repo: {
      async flush() {
        flushCount += 1;
      },
    },
    async getOrCreateSessionDoc() {
      return withHistoryPort({
        roomId: 'session-session-1',
        async updateHistory(updateFn) {
          history = updateFn(history);
        },
      });
    },
    async syncDocOrThrow(_docId, options) {
      const reason = options?.reason ?? '';
      syncReasons.push(reason);
      if (reason.endsWith(':commit') && commitFailures > 0) {
        commitFailures -= 1;
        throw new Error('transport unavailable');
      }
    },
  };

  return {
    manager,
    history: () => history,
    flushCount: () => flushCount,
    syncReasons,
    failNextCommit: () => {
      commitFailures += 1;
    },
  };
};

describe('publishTaskProposal', () => {
  it('persists one remotely confirmed proposal with agent attribution', async () => {
    const harness = makePersistence();

    const result = await publishTaskProposal(
      harness.manager,
      SESSION_ID,
      { proposalId: 'follow-up', title: 'Ship the follow-up', body: 'Acceptance criteria' },
      { agentConfigId: 'agent-1', name: 'Codex' },
      { now: () => NOW }
    );

    expect(result).toEqual({ pending: true });
    expect(harness.history()).toHaveLength(1);
    expect(harness.history()[0]).toMatchObject({
      id: 'task-proposal-follow-up',
      role: 'system',
      timestamp: '2026-07-30T10:00:00.000Z',
      finished: true,
    });
    expect(proposalMetaFrom(harness.history())).toEqual({
      proposalId: 'follow-up',
      title: 'Ship the follow-up',
      body: 'Acceptance criteria',
      proposedBy: { kind: 'agent', agentConfigId: 'agent-1', name: 'Codex' },
    });
    expect(harness.flushCount()).toBe(1);
    expect(harness.syncReasons).toEqual(['mcp.task_propose:hydrate', 'mcp.task_propose:commit']);
  });

  it('reports a retryable failure until the same locally durable proposal is confirmed', async () => {
    const harness = makePersistence();
    harness.failNextCommit();
    const draft = { proposalId: 'retry-me', title: 'Retry safely' };

    await expect(
      publishTaskProposal(harness.manager, SESSION_ID, draft, {}, { now: () => NOW })
    ).rejects.toMatchObject<LodyOperationStoreError>({
      code: 'TASK_PROPOSAL_SYNC_FAILED',
      retryable: true,
    });
    expect(harness.history()).toHaveLength(1);

    await expect(
      publishTaskProposal(harness.manager, SESSION_ID, draft, {}, { now: () => NOW })
    ).resolves.toEqual({ pending: true });
    expect(harness.history()).toHaveLength(1);
    expect(harness.flushCount()).toBe(1);
    expect(harness.syncReasons).toEqual([
      'mcp.task_propose:hydrate',
      'mcp.task_propose:commit',
      'mcp.task_propose:hydrate',
    ]);
  });

  it('updates a pending card in place but never reopens a resolved proposal', async () => {
    const harness = makePersistence();
    await publishTaskProposal(
      harness.manager,
      SESSION_ID,
      { proposalId: 'stable', title: 'Original' },
      {},
      { now: () => NOW }
    );
    await publishTaskProposal(
      harness.manager,
      SESSION_ID,
      { proposalId: 'stable', title: 'Revised', body: 'New details' },
      {},
      { now: () => NOW + 1_000 }
    );

    expect(harness.history()).toHaveLength(1);
    expect(proposalMetaFrom(harness.history())).toMatchObject({
      proposalId: 'stable',
      title: 'Revised',
      body: 'New details',
    });
    expect(harness.history()[0]?.timestamp).toBe('2026-07-30T10:00:00.000Z');

    const entry = harness.history()[0];
    if (!entry) throw new Error('Expected proposal entry');
    const resolved = makePersistence([
      {
        ...entry,
        items: [
          {
            type: 'system_notice',
            name: 'task_proposal',
            meta: {
              ...proposalMetaFrom(harness.history()),
              outcome: 'created',
              taskId: 'task-1',
            },
          },
        ],
      },
    ]);

    await expect(
      publishTaskProposal(
        resolved.manager,
        SESSION_ID,
        { proposalId: 'stable', title: 'Must not replace the decision' },
        {},
        { now: () => NOW + 2_000 }
      )
    ).resolves.toEqual({ pending: false, outcome: 'created', taskId: 'task-1' });
    expect(proposalMetaFrom(resolved.history()).title).toBe('Revised');
    expect(resolved.flushCount()).toBe(0);
  });
});
