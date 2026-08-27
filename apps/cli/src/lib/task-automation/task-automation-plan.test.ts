import { describe, expect, it } from 'vitest';
import type { TaskStatus } from '@lody/shared';
import {
  collectTaskAutomationBaseline,
  isTaskAutomationEligible,
  planTaskAutomation,
  type TaskAutomationCandidate,
  type TaskAutomationInput,
} from './task-automation-plan';

const OPERATOR = 'user-1';

const candidate = (overrides: Partial<TaskAutomationCandidate> = {}): TaskAutomationCandidate => ({
  taskId: 't1',
  order: '2',
  ownerId: OPERATOR,
  agentConfigId: 'agent-1',
  status: 'backlog',
  ready: true,
  ...overrides,
});

const input = (overrides: Partial<TaskAutomationInput> = {}): TaskAutomationInput => ({
  candidates: [],
  ownedAgentConfigIds: new Set(['agent-1', 'agent-2']),
  onlineAgentConfigIds: new Set(['agent-1', 'agent-2']),
  operatorUserId: OPERATOR,
  inFlightByAgentConfigId: new Map(),
  baselineTaskIds: new Set(),
  startedTaskIds: new Set(),
  ...overrides,
});

describe('isTaskAutomationEligible', () => {
  it('accepts an entrusted, complete, not-yet-started task owned by the operator', () => {
    expect(isTaskAutomationEligible(candidate(), input())).toBe(true);
  });

  it('never automates a task with no agent, however complete it is', () => {
    expect(isTaskAutomationEligible(candidate({ agentConfigId: undefined }), input())).toBe(false);
  });

  it('only acts on not-started work (backlog or todo)', () => {
    for (const status of ['in_progress', 'needs_review', 'done', 'canceled'] as const) {
      expect(isTaskAutomationEligible(candidate({ status }), input())).toBe(false);
    }
  });

  it('treats todo the same as backlog: both are "not started"', () => {
    // The status split is a triage refinement, not an execution gate — a task
    // moved from Backlog to Todo must not silently lose its automation.
    expect(isTaskAutomationEligible(candidate({ status: 'todo' }), input())).toBe(true);
  });

  it('waits for missing execution inputs instead of guessing', () => {
    expect(isTaskAutomationEligible(candidate({ ready: false }), input())).toBe(false);
  });

  it('ignores agents that live on another machine', () => {
    expect(isTaskAutomationEligible(candidate({ agentConfigId: 'agent-elsewhere' }), input())).toBe(
      false
    );
  });

  it("refuses to run another user's task under this operator", () => {
    expect(isTaskAutomationEligible(candidate({ ownerId: 'user-2' }), input())).toBe(false);
  });
});

describe('planTaskAutomation', () => {
  it('starts nothing when there is nothing eligible', () => {
    const plan = planTaskAutomation(input({ candidates: [candidate({ ready: false })] }));
    expect(plan.start).toEqual([]);
    expect(plan.queued).toEqual([]);
  });

  it('starts one task and queues the rest for the same agent', () => {
    const plan = planTaskAutomation(
      input({
        candidates: [
          candidate({ taskId: 'b', order: '3' }),
          candidate({ taskId: 'a', order: '2' }),
          candidate({ taskId: 'c', order: '4' }),
        ],
      })
    );
    expect(plan.start).toEqual([{ taskId: 'a', agentConfigId: 'agent-1' }]);
    expect(plan.queued).toEqual([
      { taskId: 'b', agentConfigId: 'agent-1', position: 1 },
      { taskId: 'c', agentConfigId: 'agent-1', position: 2 },
    ]);
  });

  it('respects the user-visible order rather than discovery order', () => {
    const plan = planTaskAutomation(
      input({
        candidates: [
          candidate({ taskId: 'late', order: '9' }),
          candidate({ taskId: 'early', order: '1' }),
        ],
      })
    );
    expect(plan.start[0]?.taskId).toBe('early');
  });

  it('starts nothing for an agent that is already working', () => {
    const plan = planTaskAutomation(
      input({
        candidates: [candidate({ taskId: 'a' }), candidate({ taskId: 'b', order: '3' })],
        inFlightByAgentConfigId: new Map([['agent-1', 'busy-task']]),
      })
    );
    expect(plan.start).toEqual([]);
    expect(plan.queued.map((entry) => entry.position)).toEqual([1, 2]);
  });

  it('runs different agents in parallel — the serial rule is per agent', () => {
    const plan = planTaskAutomation(
      input({
        candidates: [
          candidate({ taskId: 'a', agentConfigId: 'agent-1' }),
          candidate({ taskId: 'b', agentConfigId: 'agent-2' }),
        ],
      })
    );
    expect(plan.start.map((entry) => entry.taskId).sort()).toEqual(['a', 'b']);
  });

  it('holds work for an offline agent instead of dropping or reassigning it', () => {
    const plan = planTaskAutomation(
      input({
        candidates: [candidate({ taskId: 'a' })],
        onlineAgentConfigIds: new Set(['agent-2']),
      })
    );
    expect(plan.start).toEqual([]);
    expect(plan.waitingForAgent).toEqual([{ taskId: 'a', agentConfigId: 'agent-1' }]);
  });

  it('never starts what was already eligible at startup', () => {
    const plan = planTaskAutomation(
      input({
        candidates: [candidate({ taskId: 'old' })],
        baselineTaskIds: new Set(['old']),
      })
    );
    expect(plan.start).toEqual([]);
    expect(plan.skippedAsBaseline).toEqual(['old']);
  });

  it('lets a baseline task through once it leaves and re-enters eligibility', () => {
    // The scheduler drops it from the baseline on the observed transition out of
    // backlog; the planner must then treat it as new work.
    const plan = planTaskAutomation(
      input({ candidates: [candidate({ taskId: 'old' })], baselineTaskIds: new Set() })
    );
    expect(plan.start).toEqual([{ taskId: 'old', agentConfigId: 'agent-1' }]);
  });

  it('does not start a task twice across re-reads', () => {
    const plan = planTaskAutomation(
      input({
        candidates: [candidate({ taskId: 'a' })],
        startedTaskIds: new Set(['a']),
      })
    );
    expect(plan.start).toEqual([]);
    expect(plan.queued).toEqual([]);
  });

  it('a burst of assignments becomes a queue, not a burst of sessions', () => {
    const plan = planTaskAutomation(
      input({
        candidates: Array.from({ length: 10 }, (_unused, index) =>
          candidate({ taskId: `t${index}`, order: `${index + 1}` })
        ),
      })
    );
    expect(plan.start).toHaveLength(1);
    expect(plan.queued).toHaveLength(9);
  });
});

describe('collectTaskAutomationBaseline', () => {
  it('records everything currently eligible so a restart does not replay it', () => {
    const baseline = collectTaskAutomationBaseline(
      [
        candidate({ taskId: 'a' }),
        candidate({ taskId: 'b', ready: false }),
        candidate({ taskId: 'c', ownerId: 'user-2' }),
      ],
      { ownedAgentConfigIds: new Set(['agent-1']), operatorUserId: OPERATOR }
    );
    expect([...baseline]).toEqual(['a']);
  });

  it('is empty when nothing is entrusted yet', () => {
    const baseline = collectTaskAutomationBaseline([candidate({ agentConfigId: undefined })], {
      ownedAgentConfigIds: new Set(['agent-1']),
      operatorUserId: OPERATOR,
    });
    expect(baseline.size).toBe(0);
  });
});

describe('planTaskAutomation one-at-a-time per agent', () => {
  const base = {
    ownedAgentConfigIds: new Set(['a1']),
    onlineAgentConfigIds: new Set(['a1']),
    operatorUserId: OPERATOR,
    inFlightByAgentConfigId: new Map<string, string>(),
    baselineTaskIds: new Set<string>(),
    startedTaskIds: new Set<string>(),
  };

  it("does not start a second task while the agent's first one is in progress", () => {
    // inFlightByAgentConfigId only spans the dispatch call, so by the next pass
    // the running task appears only as its in_progress status. Without reading
    // that, the agent gets two concurrent sessions in one working copy.
    const plan = planTaskAutomation({
      ...base,
      candidates: [
        candidate({ taskId: 'running', agentConfigId: 'a1', status: 'in_progress' }),
        candidate({ taskId: 'next', agentConfigId: 'a1', order: '2' }),
      ],
      startedTaskIds: new Set(['running']),
    });

    expect(plan.start).toEqual([]);
    expect(plan.queued).toEqual([{ taskId: 'next', agentConfigId: 'a1', position: 1 }]);
  });

  it('treats a manual Run as the agent being busy', () => {
    // A task a person started with Run is in progress but was never auto-started,
    // so it is absent from startedTaskIds too.
    const plan = planTaskAutomation({
      ...base,
      candidates: [
        candidate({ taskId: 'manual', agentConfigId: 'a1', status: 'in_progress' }),
        candidate({ taskId: 'delegated', agentConfigId: 'a1', order: '2' }),
      ],
    });

    expect(plan.start).toEqual([]);
    expect(plan.queued.map((entry) => entry.taskId)).toEqual(['delegated']);
  });

  it("ignores another user's in-progress task when deciding busy", () => {
    // Someone else's work runs under their own operator, not this scheduler.
    const plan = planTaskAutomation({
      ...base,
      candidates: [
        candidate({
          taskId: 'theirs',
          agentConfigId: 'a1',
          status: 'in_progress',
          ownerId: 'someone-else',
        }),
        candidate({ taskId: 'mine', agentConfigId: 'a1', order: '2' }),
      ],
    });

    expect(plan.start).toEqual([{ taskId: 'mine', agentConfigId: 'a1' }]);
  });

  it('starts the head of the queue when the agent has nothing running', () => {
    const plan = planTaskAutomation({
      ...base,
      candidates: [
        candidate({ taskId: 'first', agentConfigId: 'a1', order: '1' }),
        candidate({ taskId: 'second', agentConfigId: 'a1', order: '2' }),
      ],
    });

    expect(plan.start).toEqual([{ taskId: 'first', agentConfigId: 'a1' }]);
    expect(plan.queued).toEqual([{ taskId: 'second', agentConfigId: 'a1', position: 1 }]);
  });
});

describe('planTaskAutomation safety invariants', () => {
  // Deterministic PRNG so any failure reproduces exactly.
  const makeRandom = (seed: number) => {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
  };

  const STATUSES: TaskStatus[] = [
    'backlog',
    'todo',
    'in_progress',
    'needs_review',
    'done',
    'canceled',
  ];

  it('never starts work the gates forbid, across randomized fleets', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const random = makeRandom(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;

      const agentIds = ['a1', 'a2', 'a3'];
      const owned = new Set(agentIds.filter(() => random() < 0.7));
      const online = new Set([...owned].filter(() => random() < 0.7));
      const operatorUserId = 'operator';
      const inFlight = new Map<string, string>(
        [...online].filter(() => random() < 0.4).map((id) => [id, `busy-${id}`])
      );

      const candidates = Array.from({ length: 12 }, (_, index) => ({
        taskId: `t${index}`,
        order: `${index + 1}`,
        ownerId: random() < 0.75 ? operatorUserId : 'someone-else',
        agentConfigId: random() < 0.2 ? undefined : pick(agentIds),
        status: random() < 0.6 ? ('backlog' as const) : pick(STATUSES),
        ready: random() < 0.8,
      }));

      const startedTaskIds = new Set(
        candidates.filter(() => random() < 0.15).map((entry) => entry.taskId)
      );
      const baselineTaskIds = new Set(
        candidates.filter(() => random() < 0.15).map((entry) => entry.taskId)
      );

      const plan = planTaskAutomation({
        candidates,
        ownedAgentConfigIds: owned,
        onlineAgentConfigIds: online,
        operatorUserId,
        inFlightByAgentConfigId: inFlight,
        baselineTaskIds,
        startedTaskIds,
      });

      const byId = new Map(candidates.map((entry) => [entry.taskId, entry]));
      const where = `seed ${seed}`;

      for (const started of plan.start) {
        const entry = byId.get(started.taskId);
        // Each of these would mean the machine ran work nobody asked it to run.
        expect(entry?.agentConfigId, `${where}: started a task with no agent`).toBeTruthy();
        expect(entry?.ownerId, `${where}: started another user's task`).toBe(operatorUserId);
        expect(
          entry?.status === 'backlog' || entry?.status === 'todo',
          `${where}: started a task that was neither backlog nor todo`
        ).toBe(true);
        expect(entry?.ready, `${where}: started an incomplete task`).toBe(true);
        expect(owned.has(started.agentConfigId), `${where}: started on an unowned agent`).toBe(
          true
        );
        expect(online.has(started.agentConfigId), `${where}: started on an offline agent`).toBe(
          true
        );
        expect(inFlight.has(started.agentConfigId), `${where}: started on a busy agent`).toBe(
          false
        );
        expect(baselineTaskIds.has(started.taskId), `${where}: replayed the startup backlog`).toBe(
          false
        );
        expect(startedTaskIds.has(started.taskId), `${where}: started a task twice`).toBe(false);
      }

      const startsPerAgent = new Map<string, number>();
      for (const started of plan.start) {
        startsPerAgent.set(
          started.agentConfigId,
          (startsPerAgent.get(started.agentConfigId) ?? 0) + 1
        );
      }
      for (const [agentConfigId, count] of startsPerAgent) {
        // One agent is one colleague: never two tasks at once.
        expect(count, `${where}: ${agentConfigId} started ${count} tasks at once`).toBe(1);
      }

      const startedIds = new Set(plan.start.map((entry) => entry.taskId));
      for (const queued of plan.queued) {
        expect(startedIds.has(queued.taskId), `${where}: task both started and queued`).toBe(false);
      }
    }
  });
});
