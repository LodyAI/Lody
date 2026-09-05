import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildScheduleRegistryRow,
  ScheduleDefinitionSchema,
  type ScheduleDocument,
} from '@lody/shared';
import { findNextDispatchableUserTurn } from '@/session/session-dispatch-logic';
import { AgentExecutionSlots } from '../agent-execution-slots';
import { ScheduleStore } from './schedule-store';
import {
  ScheduleConfigurationError,
  ScheduleEngine,
  type ScheduleEnginePorts,
} from './schedule-engine';

const document = (): ScheduleDocument => ({
  definition: ScheduleDefinitionSchema.parse({
    scheduleId: 'schedule',
    title: 'Nightly',
    ownerId: 'owner',
    machineId: 'machine',
    enabled: true,
    activationId: 'activation',
    activeFrom: 0,
    trigger: { kind: 'interval', everyMs: 60_000, anchorAt: '1970-01-01T00:00:00Z' },
    misfirePolicy: { kind: 'run_once' },
    overlapPolicy: 'queue_one',
    agent: { agentConfigId: 'agent', modeId: 'safe' },
    project: { kind: 'github', repoFullName: 'loro-dev/lody', branch: 'main' },
    retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86_400_000 },
    createdAt: 0,
    updatedAt: 0,
    createdBy: 'owner',
  }),
  prompt: 'original',
  timeline: [],
});
const stores: ScheduleStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function harness() {
  const store = new ScheduleStore<{ prompt: string }>(':memory:');
  stores.push(store);
  const d = document();
  let row = buildScheduleRegistryRow(d);
  let now = 60_000;
  let ready = true;
  let disabled = false;
  let accepted = false;
  let finished = false;
  const slots = new AgentExecutionSlots();
  const ports: ScheduleEnginePorts<{ prompt: string }> = {
    workspaceId: 'workspace',
    machineId: 'machine',
    userId: 'owner',
    store,
    slots,
    now: () => now,
    ready: () => ready,
    disabled: () => disabled,
    list: async () => [row],
    read: async () => d,
    validateTarget: async () => {},
    prepare: vi.fn(async (run) => ({ prompt: run.prompt })),
    materialize: vi.fn(async () => {}),
    isDispatched: async () => accepted,
    dispatch: vi.fn(async () => {
      accepted = true;
    }),
    isFinished: async () => finished,
    publish: vi.fn(async () => {}),
    onError: vi.fn(),
  };
  const engine = new ScheduleEngine(ports);
  return {
    store,
    slots,
    d,
    ports,
    engine,
    time: (n: number) => {
      now = n;
    },
    ready: (v: boolean) => {
      ready = v;
    },
    disabled: (v: boolean) => {
      disabled = v;
    },
    finished: () => {
      finished = true;
    },
    accepted: () => {
      accepted = true;
    },
    pause: () => {
      d.definition.enabled = false;
      row = buildScheduleRegistryRow(d);
    },
  };
}

describe('Schedule worker handoff', () => {
  it('never materializes before initial/reconnect sync and never dispatches twice', async () => {
    const h = harness();
    h.ready(false);
    await h.engine.evaluate();
    expect(h.ports.prepare).not.toHaveBeenCalled();
    h.ready(true);
    await h.engine.evaluate();
    await h.engine.evaluate();
    expect(h.ports.dispatch).toHaveBeenCalledTimes(1);
    expect(h.store.unfinished('workspace')[0]?.state).toBe('dispatched');
    h.pause();
    h.disabled(true);
    h.finished();
    await h.engine.evaluate();
    expect(h.store.unfinished('workspace')).toEqual([]);
    expect(h.slots.isBusy('agent')).toBe(false);
  });
  it('keeps prepared history inert if paused before the pointer handoff', async () => {
    const h = harness();
    h.ports.materialize = vi.fn(async () => {
      h.pause();
    });
    await h.engine.evaluate();
    expect(h.ports.dispatch).not.toHaveBeenCalled();
    expect(h.store.history('workspace', 'schedule')[0]?.state).toBe('skipped');
    const turn = {
      id: 'turn',
      role: 'user' as const,
      status: 'prepared' as const,
      read: true,
      timestamp: '',
      fileDiff: [],
    };
    expect(findNextDispatchableUserTurn([turn], {} as never)).toBeNull();
    expect(findNextDispatchableUserTurn([turn], { latestUserMsgId: 'turn' } as never)?.id).toBe(
      'turn'
    );
  });
  it('recognizes a committed pointer even when acknowledgement throws', async () => {
    const h = harness();
    h.ports.dispatch = vi.fn(async () => {
      h.accepted();
      throw new Error('lost acknowledgement');
    });
    await h.engine.evaluate();
    await h.engine.evaluate();
    expect(h.ports.dispatch).toHaveBeenCalledTimes(1);
    expect(h.store.unfinished('workspace')[0]?.state).toBe('dispatched');
  });
  it('retries frozen preparation, releases failed reservation, and preserves attempt age', async () => {
    const h = harness();
    h.ports.materialize = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary storage failure'))
      .mockResolvedValue(undefined);
    await h.engine.evaluate();
    expect(h.slots.isBusy('agent')).toBe(false);
    const run = h.store.unfinished('workspace')[0]!;
    expect(run.state).toBe('retry_wait');
    expect(run.retryAt).toBe(90_000);
    h.d.prompt = 'edited Agent default outside the frozen run';
    h.ports.read = async () => ({ ...h.d, prompt: 'original' });
    h.time(90_000);
    await h.engine.evaluate();
    expect(h.ports.prepare).toHaveBeenCalledTimes(1);
    expect(h.ports.dispatch).toHaveBeenCalledWith({ prompt: 'original' });
    expect(h.store.get(run.runKey)?.plannedAt).toBe(60_000);
  });
  it('retains only the newest unprepared run and waits for Task occupancy', async () => {
    const h = harness();
    h.slots.replaceTaskOccupancy(
      [{ taskId: 'task', agentConfigId: 'agent', ownerId: 'owner', status: 'in_progress' }],
      'owner'
    );
    await h.engine.evaluate();
    h.time(180_000);
    await h.engine.evaluate();
    expect(h.ports.prepare).not.toHaveBeenCalled();
    expect(h.store.unfinished('workspace')).toHaveLength(1);
    expect(h.store.unfinished('workspace')[0]?.scheduledFor).toBe(180_000);
    expect(
      h.store.history('workspace', 'schedule').find((run) => run.scheduledFor === 60_000)?.errorCode
    ).toBe('SUPERSEDED');
    h.slots.replaceTaskOccupancy([], 'owner');
    await h.engine.evaluate();
    expect(h.ports.dispatch).toHaveBeenCalledTimes(1);
  });

  it('releases a restored preparation reservation when scheduling is disabled, retaining the input', async () => {
    const h = harness();
    h.ports.materialize = async () => {
      h.ready(false);
    };
    await h.engine.evaluate();
    h.engine.restoreOccupancy();
    expect(h.slots.isBusy('agent')).toBe(true);
    h.ready(true);
    h.disabled(true);
    await h.engine.evaluate();
    expect(h.slots.reserve('agent', 'task:other')).toBe(true);
    expect(h.store.unfinished('workspace')[0]).toMatchObject({
      state: 'session_prepared',
      prepared: { prompt: 'original' },
    });
    expect(h.ports.dispatch).not.toHaveBeenCalled();
    expect(h.ports.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ blockedCode: 'SCHEDULES_DISABLED' })
    );
  });

  it('does not reopen future definitions on every timer tick', async () => {
    const h = harness();
    h.time(1);
    h.ports.read = vi.fn(async () => h.d);
    await h.engine.evaluate();
    h.ports.read = vi.fn(async () => h.d);
    h.time(15_000);
    await h.engine.evaluate();
    expect(h.ports.read).not.toHaveBeenCalled();
    h.time(60_000);
    await h.engine.evaluate();
    expect(h.ports.dispatch).toHaveBeenCalledTimes(1);
  });
  it('waits for target permission recovery without spending attempts or losing the slot', async () => {
    const h = harness();
    h.ports.validateTarget = async () => {
      throw new ScheduleConfigurationError('PERMISSION_UNAVAILABLE');
    };
    await h.engine.evaluate();
    await h.engine.evaluate();
    expect(h.ports.dispatch).not.toHaveBeenCalled();
    expect(h.store.unfinished('workspace')[0]).toMatchObject({
      state: 'retry_wait',
      attempts: 0,
      errorCode: 'PERMISSION_UNAVAILABLE',
    });
    expect(h.slots.isBusy('agent')).toBe(false);
    expect(h.ports.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ queueState: 'blocked', blockedCode: 'PERMISSION_UNAVAILABLE' })
    );
    h.ports.validateTarget = async () => {};
    h.time(90_000);
    await h.engine.evaluate();
    expect(h.ports.dispatch).toHaveBeenCalledTimes(1);
    expect(h.store.unfinished('workspace')[0]?.scheduledFor).toBe(60_000);
  });
  it('does not hand off a preparation that outlives its dispatch deadline', async () => {
    const h = harness();
    h.ports.materialize = vi.fn(async () => {
      h.time(86_460_000);
    });
    await h.engine.evaluate();
    expect(h.ports.dispatch).not.toHaveBeenCalled();
    expect(h.store.history('workspace', 'schedule')[0]?.errorCode).toBe('DISPATCH_EXPIRED');
  });
  it('publishes one complete projection and settles its own subscription wake', async () => {
    const h = harness();
    h.slots.restore('agent', 'another');
    let last = '';
    h.ports.publish = vi.fn(async (runtime) => {
      const value = JSON.stringify(runtime);
      if (last !== value) {
        last = value;
        void h.engine.evaluate();
      }
    });
    await h.engine.evaluate();
    expect(h.ports.publish).toHaveBeenCalledTimes(2);
    expect(JSON.parse(last)).toMatchObject({
      queueState: 'waiting_for_agent',
      nextScheduledAt: 120_000,
    });
  });
});

it('recovers the committed ledger after closing a real SQLite file without repeating its slot', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'lody-schedule-test-'));
  const filename = path.join(directory, 'ledger.sqlite');
  const d = document();
  const fingerprint = buildScheduleRegistryRow(d).definitionFingerprint;
  let store = new ScheduleStore(filename);
  try {
    store.plan('workspace', d, fingerprint, 60_000);
    const run = store.unfinished('workspace')[0]!;
    store.transition(run.runKey, ['pending'], {
      state: 'claimed',
      attempts: 1,
      prepared: { prompt: 'frozen' },
    });
    store.close();
    store = new ScheduleStore(filename);
    store.plan('workspace', d, fingerprint, 60_000);
    expect(store.unfinished('workspace')).toHaveLength(1);
    expect(store.get(run.runKey)?.prepared).toEqual({ prompt: 'frozen' });
    expect(store.get(run.runKey)?.sessionId).toBe(run.sessionId);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
