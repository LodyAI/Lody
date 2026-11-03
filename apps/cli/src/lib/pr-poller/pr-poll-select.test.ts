import { describe, expect, it } from 'vitest';
import type { SessionId } from '@lody/shared';
import {
  pickNextBatch,
  planDueBatches,
  prPollTargetKey,
  type PrPollBatchPlan,
  type SchedulableTarget,
} from './pr-poll-select';

const sid = (value: string): SessionId => value as SessionId;
const T0 = 1_720_000_000_000;

function target(overrides: Partial<SchedulableTarget> = {}): SchedulableTarget {
  const ownerSessionId = overrides.ownerSessionId ?? sid('s1');
  const repoFullName = overrides.repoFullName ?? 'owner/repo';
  const kind = overrides.kind ?? 'status';
  return {
    key: prPollTargetKey(overrides.workspaceId ?? 'ws1', ownerSessionId, repoFullName, kind, 'q'),
    kind,
    workspaceId: 'ws1',
    ownerSessionId,
    repoFullName,
    lane: 'low',
    desiredIntervalMs: 300_000,
    minIntervalMs: 60_000,
    lastSuccessAtMs: null,
    lastAttemptAtMs: null,
    ...overrides,
  };
}

it('keeps native and managed queries for the same repository in separate batches', () => {
  const batches = planDueBatches(
    [
      target({
        discovery: { repoFullName: 'owner/repo', branch: 'local', nativeCredentials: true },
      }),
      target({
        ownerSessionId: sid('managed'),
        discovery: { repoFullName: 'owner/repo', branch: 'managed' },
      }),
    ],
    T0
  );
  expect(
    batches.map((batch) => [batch.nativeCredentials, batch.targets.map((t) => t.discovery?.branch)])
  ).toEqual([
    [true, ['local']],
    [false, ['managed']],
  ]);
});

describe('pickNextBatch', () => {
  const high = (repo: string, oldestDueAtMs: number): PrPollBatchPlan => ({
    workspaceId: 'ws1',
    repoFullName: repo,
    lane: 'high',
    oldestDueAtMs,
    targets: [],
  });
  const low = (repo: string, oldestDueAtMs: number): PrPollBatchPlan => ({
    workspaceId: 'ws1',
    repoFullName: repo,
    lane: 'low',
    oldestDueAtMs,
    targets: [],
  });

  it('anti-starvation: after N−1 consecutive high dispatches a due low batch is picked', () => {
    const batches = [low('r1', 1), high('r2', 5)];
    expect(pickNextBatch(batches, 3, 5)?.lane).toBe('high');
    expect(pickNextBatch(batches, 4, 5)?.lane).toBe('low');
  });
});
