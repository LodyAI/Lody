import { describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import {
  evaluateSchedule,
  latestScheduleSlot,
  nextScheduleSlot,
  previewSchedule,
  validateScheduleTrigger,
} from '../src/schedule-time';
import {
  buildScheduleRegistryRow,
  readScheduleRegistryRows,
  scheduleDefinitionFingerprint,
  scheduleRunIds,
  scheduleRunKey,
} from '../src/schedule-registry';
import {
  hasExplicitSchedulePermission,
  ScheduleAgentSchema,
  ScheduleDefinitionSchema,
} from '../src/schedule-types';
import { ScheduleRepository, type ScheduleRepositoryPort } from '../src/schedule-repository';

const definition = () =>
  ScheduleDefinitionSchema.parse({
    scheduleId: 'test',
    title: 'Test',
    ownerId: 'owner',
    machineId: 'machine',
    enabled: true,
    activationId: 'activation',
    activeFrom: 0,
    trigger: { kind: 'interval', everyMs: 60_000, anchorAt: '2026-01-01T00:00:00Z' },
    misfirePolicy: { kind: 'skip' },
    overlapPolicy: 'queue_one',
    agent: { agentConfigId: 'agent', modeId: 'safe' },
    project: { kind: 'github', repoFullName: 'loro-dev/lody', branch: 'main' },
    retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86_400_000 },
    createdAt: 0,
    updatedAt: 0,
    createdBy: 'owner',
  });
const ms = Date.parse;

describe('Schedule time contract', () => {
  it('includes an exact due minute, advances one fixed horizon, never replays that horizon', () => {
    const d = definition();
    const now = ms('2026-01-02T00:00:00Z');
    const result = evaluateSchedule(d, undefined, now);
    expect(result.due).toEqual({ scheduledFor: now, disposition: 'run' });
    expect(evaluateSchedule(d, result.evaluatedThrough, now).due).toBeUndefined();
    expect(result.nextScheduledAt).toBe(now + 60_000);
  });
  it('skips an old once slot, while run_once admits exactly that one intent', () => {
    const d = {
      ...definition(),
      trigger: validateScheduleTrigger({ kind: 'once', at: '2026-01-01T00:00:00+08:00' }),
    };
    const now = ms('2026-01-02T00:00:00Z');
    expect(evaluateSchedule(d, undefined, now).due?.disposition).toBe('skip');
    expect(
      evaluateSchedule({ ...d, misfirePolicy: { kind: 'run_once' } }, undefined, now).due
        ?.disposition
    ).toBe('run');
    expect(evaluateSchedule({ ...d, activeFrom: now }, undefined, now).due).toBeUndefined();
  });
  it('uses interval anchor rather than completion time and excludes paused slots', () => {
    const d = definition();
    const start = ms('2026-01-01T00:00:10Z');
    expect(nextScheduleSlot(d.trigger, start, start)).toBe(ms('2026-01-01T00:01:00Z'));
    expect(latestScheduleSlot(d.trigger, start, start)).toBeUndefined();
  });
  it('skips nonexistent DST local times and runs the first repeated local time only', () => {
    const spring = validateScheduleTrigger({
      kind: 'cron',
      expression: '30 2 * * *',
      timeZone: 'America/New_York',
    });
    expect(previewSchedule(spring, 0, ms('2026-03-07T08:00:00Z'), 1)).toEqual([
      ms('2026-03-09T06:30:00Z'),
    ]);
    const fall = validateScheduleTrigger({
      kind: 'cron',
      expression: '30 1 * * *',
      timeZone: 'America/New_York',
    });
    expect(previewSchedule(fall, 0, ms('2026-11-01T04:00:00Z'), 2)).toEqual([
      ms('2026-11-01T05:30:00Z'),
      ms('2026-11-02T06:30:00Z'),
    ]);
    expect(latestScheduleSlot(fall, 0, ms('2026-11-01T06:40:00Z'))).toBe(
      ms('2026-11-01T05:30:00Z')
    );
  });
  it('uses DOM/DOW OR and rejects unsupported syntax and offsetless instants', () => {
    const cron = validateScheduleTrigger({
      kind: 'cron',
      expression: '0 9 1 * MON',
      timeZone: 'UTC',
    });
    expect(previewSchedule(cron, 0, ms('2026-01-01T09:00:00Z'), 1)).toEqual([
      ms('2026-01-05T09:00:00Z'),
    ]);
    expect(latestScheduleSlot(cron, 0, ms('2026-01-05T09:00:00Z'))).toBe(
      ms('2026-01-05T09:00:00Z')
    );
    for (const expression of ['* * * * * *', '0 0 L * *', '@daily', '* * * * MON#2'])
      expect(() =>
        validateScheduleTrigger({ kind: 'cron', expression, timeZone: 'UTC' })
      ).toThrow();
    expect(() => validateScheduleTrigger({ kind: 'once', at: '2026-01-01T00:00:00' })).toThrow();
  });
});

describe('Schedule persistence contract', () => {
  it('fingerprints executable input independently of key order and cosmetic edits', () => {
    const d = definition();
    const first = scheduleDefinitionFingerprint({ definition: d, prompt: 'hello' });
    expect(
      scheduleDefinitionFingerprint({
        definition: { ...d, title: 'Renamed', updatedAt: 1 },
        prompt: 'hello',
      })
    ).toBe(first);
    expect(scheduleDefinitionFingerprint({ definition: d, prompt: 'different' })).not.toBe(first);
    const key = scheduleRunKey('test', 'activation', 123);
    expect(scheduleRunIds(key)).toEqual(scheduleRunIds(key));
    expect(new Set(Object.values(scheduleRunIds(key))).size).toBe(3);
  });
  it('honors tombstones regardless of row order', () => {
    const row = buildScheduleRegistryRow({
      definition: definition(),
      prompt: 'hello',
      timeline: [],
    });
    expect(
      readScheduleRegistryRows([
        { key: ['tombstone', 'test'], value: { actorId: 'owner', deletedAt: 1 } },
        { key: ['schedule', 'test'], value: row },
      ])
    ).toEqual([]);
  });
  it('writes the definition durably before enabling its Registry and reads absent docs without seeding', async () => {
    const docs = new Map<string, LoroDoc>();
    const rows = new Map<string, unknown>();
    const flushes: { doc: unknown; rows: number }[] = [];
    let interruptPublication = true;
    const port: ScheduleRepositoryPort = {
      openPersistedDoc: async (id) => {
        if (!docs.has(id)) docs.set(id, new LoroDoc());
        return { doc: docs.get(id)! };
      },
      openFlockDoc: async () => ({
        flock: {
          scan: () => [...rows].map(([key, value]) => ({ key: JSON.parse(key), value })),
          get: (key) => rows.get(JSON.stringify(key)),
          set: (key, value) => {
            if (interruptPublication) throw new Error('interrupted publication');
            return rows.set(JSON.stringify(key), value);
          },
        },
      }),
      flush: async () => {
        flushes.push({ doc: docs.get('schedule-test')?.toJSON(), rows: rows.size });
      },
    };
    const repo = new ScheduleRepository(port, 'workspace' as never);
    expect(await repo.read('missing')).toBeNull();
    expect(docs.get('schedule-missing')!.toJSON()).toEqual({});
    const d = definition();
    const create = () =>
      repo.save({
        scheduleId: 'test',
        draft: {
          title: d.title,
          machineId: d.machineId,
          trigger: d.trigger,
          agent: d.agent,
          project: d.project,
          misfirePolicy: d.misfirePolicy,
          overlapPolicy: d.overlapPolicy,
          retryPolicy: d.retryPolicy,
          prompt: 'hello',
        },
        actorId: 'owner',
        now: 1,
        activationId: 'activation',
        activityId: 'created',
        create: true,
      });
    await expect(create()).rejects.toThrow('interrupted publication');
    expect(await repo.list()).toEqual([]);
    expect((await repo.read('test'))?.timeline).toHaveLength(1);
    interruptPublication = false;
    await create();
    expect(flushes[0]?.rows).toBe(0);
    expect(flushes.at(-1)?.rows).toBe(1);
    expect((await repo.read('test'))?.timeline).toHaveLength(1);
    expect((await repo.read('test'))?.prompt).toBe('hello');
    await expect(
      repo.setEnabled({
        scheduleId: 'test',
        enabled: false,
        actorId: 'other',
        now: 2,
        activationId: 'a',
        requestId: 'pause',
      })
    ).rejects.toThrow('owner');
    await repo.delete('test', 'owner', 2);
    expect(await repo.list()).toEqual([]);
  });
});

it('uses explicit advertised permission categories, rejecting unrelated modes and credential options', () => {
  const permission = {
    id: 'arbitrary_provider_option',
    category: '_permission',
    name: 'Permissions',
    type: 'select' as const,
    currentValue: 'safe',
    options: [{ value: 'safe', name: 'Safe' }],
  };
  const capability = { modes: [{ id: 'plan', name: 'Plan' }], configOptions: [permission] };
  expect(
    hasExplicitSchedulePermission({ agentConfigId: 'agent', modeId: 'plan' }, capability)
  ).toBe(false);
  expect(
    hasExplicitSchedulePermission(
      { agentConfigId: 'agent', configOptionValues: { arbitrary_provider_option: 'safe' } },
      capability
    )
  ).toBe(true);
  expect(
    hasExplicitSchedulePermission(
      { agentConfigId: 'agent', configOptionValues: { arbitrary_provider_option: 'unknown' } },
      capability
    )
  ).toBe(false);
  expect(
    hasExplicitSchedulePermission(
      { agentConfigId: 'agent', modeId: 'plan' },
      { modes: capability.modes }
    )
  ).toBe(true);
  expect(
    ScheduleAgentSchema.safeParse({
      agentConfigId: 'agent',
      configOptionValues: { api_key: 'secret' },
    }).success
  ).toBe(false);
});
