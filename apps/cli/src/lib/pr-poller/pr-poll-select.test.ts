import { describe, expect, it } from 'vitest';
import type { SessionId } from '@lody/shared';
import {
  computeNextWakeAtMs,
  computeTargetDueAtMs,
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

describe('computeTargetDueAtMs', () => {
  it('a never-refreshed target is due immediately', () => {
    expect(computeTargetDueAtMs(target())).toBe(0);
  });

  it('dueness = lastSuccess + desired interval, floored by lastAttempt + min interval', () => {
    expect(computeTargetDueAtMs(target({ lastSuccessAtMs: T0 }))).toBe(T0 + 300_000);
    // A failed attempt spaces retries without waiting a full interval.
    expect(computeTargetDueAtMs(target({ lastAttemptAtMs: T0 }))).toBe(T0 + 60_000);
    expect(
      computeTargetDueAtMs(target({ lastSuccessAtMs: T0, lastAttemptAtMs: T0 + 280_000 }))
    ).toBe(T0 + 340_000);
  });

  it('a priority change reshapes dueness with no stored next-poll time', () => {
    const low = target({ lastSuccessAtMs: T0, desiredIntervalMs: 300_000 });
    const promoted = {
      ...low,
      lane: 'high' as const,
      desiredIntervalMs: 20_000,
      minIntervalMs: 20_000,
    };
    expect(computeTargetDueAtMs(low)).toBe(T0 + 300_000);
    expect(computeTargetDueAtMs(promoted)).toBe(T0 + 20_000);
  });
});

describe('planDueBatches', () => {
  it('groups due targets by (workspace, repo); batch lane is the highest target lane', () => {
    const batches = planDueBatches(
      [
        target({ ownerSessionId: sid('a'), lane: 'low' }),
        target({ ownerSessionId: sid('b'), lane: 'high' }),
        target({ ownerSessionId: sid('c'), repoFullName: 'owner/other' }),
        target({ ownerSessionId: sid('d'), lastSuccessAtMs: T0 }), // not due
      ],
      T0
    );

    expect(batches).toHaveLength(2);
    const main = batches.find((batch) => batch.repoFullName === 'owner/repo');
    expect(main?.lane).toBe('high');
    expect(main?.targets.map((t) => t.ownerSessionId)).toEqual([sid('a'), sid('b')]);
    expect(batches.find((batch) => batch.repoFullName === 'owner/other')?.lane).toBe('low');
  });
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

  it('prefers high over low, oldest-due first within a lane', () => {
    const batches = [low('r1', 1), high('r2', 5), high('r3', 3)];
    expect(pickNextBatch(batches, 0, 5)?.repoFullName).toBe('r3');
  });

  it('anti-starvation: after N−1 consecutive high dispatches a due low batch is picked', () => {
    const batches = [low('r1', 1), high('r2', 5)];
    expect(pickNextBatch(batches, 3, 5)?.lane).toBe('high');
    expect(pickNextBatch(batches, 4, 5)?.lane).toBe('low');
  });

  it('falls through to the other lane when one is empty', () => {
    expect(pickNextBatch([low('r1', 1)], 0, 5)?.lane).toBe('low');
    expect(pickNextBatch([high('r2', 1)], 99, 5)?.lane).toBe('high');
    expect(pickNextBatch([], 0, 5)).toBeNull();
  });
});

describe('computeNextWakeAtMs', () => {
  it('takes the earliest future dueness, gate hint, or the cap', () => {
    const targets = [
      target({ lastSuccessAtMs: T0, desiredIntervalMs: 10_000 }), // due T0+10s
      target({ ownerSessionId: sid('x'), lastSuccessAtMs: T0, desiredIntervalMs: 60_000 }),
    ];
    expect(computeNextWakeAtMs(targets, [], T0, 30_000)).toBe(T0 + 10_000);
    expect(computeNextWakeAtMs(targets, [T0 + 5_000], T0, 30_000)).toBe(T0 + 5_000);
    expect(computeNextWakeAtMs([], [], T0, 30_000)).toBe(T0 + 30_000);
    // Past-due targets do not pull the wake into the past.
    expect(computeNextWakeAtMs([target()], [], T0, 30_000)).toBe(T0 + 30_000);
  });
});
