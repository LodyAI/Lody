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
  normalizeLegacyScheduleAgent,
  ScheduleAgentSchema,
  ScheduleDefinitionSchema,
} from '../src/schedule-types';
import { ScheduleRepository, type ScheduleRepositoryPort } from '../src/schedule-repository';
import { zonedLocalInputToInstant, instantToZonedLocalInput } from '../src/schedule-recurrence';

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
    expect(
      scheduleRunIds(key, { scheduleId: 'test', destination: { kind: 'new_session' } })
    ).toEqual(scheduleRunIds(key, { scheduleId: 'test', destination: { kind: 'new_session' } }));
    expect(
      new Set(
        Object.values(
          scheduleRunIds(key, { scheduleId: 'test', destination: { kind: 'new_session' } })
        )
      ).size
    ).toBe(3);
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

it.each([false, true, 'false', 'true'])(
  'preserves ACP value %s and the Registry fingerprint across peers',
  async (planMode) => {
    // Nested maps (Agent options) come back from Mirror tagged with `$cid`; the
    // owning machine must still see the same definition, or the schedule stays
    // blocked on DEFINITION_NOT_COMMITTED forever.
    const docs = new Map<string, LoroDoc>();
    const rows = new Map<string, unknown>();
    const port: ScheduleRepositoryPort = {
      openPersistedDoc: async (id) => {
        if (!docs.has(id)) docs.set(id, new LoroDoc());
        return { doc: docs.get(id)! };
      },
      openFlockDoc: async () => ({
        flock: {
          scan: () => [...rows].map(([key, value]) => ({ key: JSON.parse(key), value })),
          get: (key) => rows.get(JSON.stringify(key)),
          set: (key, value) => rows.set(JSON.stringify(key), JSON.parse(JSON.stringify(value))),
        },
      }),
      flush: async () => {},
    };
    const author = new ScheduleRepository(port, 'workspace' as never);
    const d = definition();
    await author.save({
      scheduleId: 'test',
      draft: {
        title: d.title,
        machineId: d.machineId,
        trigger: d.trigger,
        agent: {
          agentConfigId: d.agent.agentConfigId,
          modelId: 'model',
          configOptionValues: {
            _permission: 'workspace-write',
            effort: 'high',
            plan_mode: planMode,
            select_flag: 'false',
          },
        },
        project: { kind: 'local', localProjectId: 'project' as never, useWorktree: true },
        destination: { kind: 'own_session', epoch: 0 },
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
    const [row] = await author.list();
    const machineDoc = new LoroDoc();
    machineDoc.import(docs.get('schedule-test')!.export({ mode: 'snapshot' }));
    const machine = new ScheduleRepository(
      { ...port, openPersistedDoc: async () => ({ doc: machineDoc }) },
      'workspace' as never
    );
    const read = await machine.read('test');
    expect(read?.definition.agent.configOptionValues).toEqual({
      _permission: 'workspace-write',
      effort: 'high',
      plan_mode: planMode,
      select_flag: 'false',
    });
    expect(scheduleDefinitionFingerprint(read!)).toBe(row!.definitionFingerprint);
  }
);

it('rejects credential options in schedule definitions', () => {
  expect(
    ScheduleAgentSchema.safeParse({
      agentConfigId: 'agent',
      configOptionValues: { api_key: 'secret' },
    }).success
  ).toBe(false);
});

describe('Chat-mode schedules carry no project', () => {
  const chatDraft = () => {
    const d = definition();
    return {
      title: d.title,
      machineId: d.machineId,
      trigger: d.trigger,
      agent: d.agent,
      misfirePolicy: d.misfirePolicy,
      overlapPolicy: d.overlapPolicy,
      retryPolicy: d.retryPolicy,
      prompt: 'hello',
    };
  };
  const memoryPort = () => {
    const docs = new Map<string, LoroDoc>();
    const rows = new Map<string, unknown>();
    const port: ScheduleRepositoryPort = {
      openPersistedDoc: async (id) => {
        if (!docs.has(id)) docs.set(id, new LoroDoc());
        return { doc: docs.get(id)! };
      },
      openFlockDoc: async () => ({
        flock: {
          scan: () => [...rows].map(([key, value]) => ({ key: JSON.parse(key), value })),
          get: (key) => rows.get(JSON.stringify(key)),
          set: (key, value) => rows.set(JSON.stringify(key), value),
        },
      }),
      flush: async () => {},
    };
    return port;
  };

  it.each([
    ['2026-10-01T02:21', '2026-10-01T09:21:00.000Z'],
    ['2026-11-01T01:30', '2026-11-01T08:30:00.000Z'],
  ])(
    'saves and restores the Once instant before evaluating its due slot (%s)',
    async (input, at) => {
      const zone = 'America/Los_Angeles';
      const port = memoryPort();
      const repo = new ScheduleRepository(port, 'workspace' as never);
      const instant = zonedLocalInputToInstant(input, zone)!;
      expect(instant).toBe(Date.parse(at));
      await repo.save({
        scheduleId: 'test',
        draft: { ...chatDraft(), trigger: { kind: 'once', at: new Date(instant).toISOString() } },
        actorId: 'owner',
        now: instant - 60_000,
        activationId: 'activation',
        activityId: 'created',
        create: true,
      });
      const doc = (await port.openPersistedDoc('schedule-test')).doc;
      const peer = new LoroDoc();
      peer.import(doc.export({ mode: 'snapshot' }));
      const restored = await new ScheduleRepository(
        {
          ...port,
          openPersistedDoc: async () => ({ doc: peer }),
        },
        'workspace' as never
      ).read('test');
      expect(restored!.definition.trigger).toEqual({ kind: 'once', at });
      expect(scheduleDefinitionFingerprint(restored!)).toBe(
        (await repo.list())[0]!.definitionFingerprint
      );
      expect(instantToZonedLocalInput(instant, zone)).toBe(input);
      expect(
        previewSchedule(restored!.definition.trigger, restored!.definition.activeFrom, instant - 1)
      ).toEqual([instant]);
      const due = evaluateSchedule(restored!.definition, undefined, instant);
      expect(due.due).toEqual({ scheduledFor: instant, disposition: 'run' });
      expect(
        evaluateSchedule(restored!.definition, due.evaluatedThrough, instant + 60_000).due
      ).toBeUndefined();
    }
  );

  it('accepts a definition with no project and keeps the field absent through the doc', async () => {
    const repo = new ScheduleRepository(memoryPort(), 'workspace' as never);
    await repo.save({
      scheduleId: 'test',
      draft: chatDraft(),
      actorId: 'owner',
      now: 1,
      activationId: 'activation',
      activityId: 'created',
      create: true,
    });
    const stored = await repo.read('test');
    expect(stored?.definition.project).toBeUndefined();
    const [row] = await repo.list();
    expect(row?.projectKind).toBeUndefined();
    expect(row?.projectKey).toBeUndefined();
    expect(row?.definitionFingerprint).toBe(scheduleDefinitionFingerprint(stored!));
  });

  it('does not confuse a chat schedule with an identical project-bound one', () => {
    const withProject = { definition: definition(), prompt: 'hello' };
    const { project: _project, ...rest } = definition();
    const chat = { definition: ScheduleDefinitionSchema.parse(rest), prompt: 'hello' };
    expect(scheduleDefinitionFingerprint(chat)).not.toBe(
      scheduleDefinitionFingerprint(withProject)
    );
    expect(buildScheduleRegistryRow(chat).projectKind).toBeUndefined();
    expect(buildScheduleRegistryRow(withProject).projectKind).toBe('github');
  });

  it('re-reads a chat schedule from the Registry rows it published', async () => {
    const port = memoryPort();
    const repo = new ScheduleRepository(port, 'workspace' as never);
    await repo.save({
      scheduleId: 'test',
      draft: chatDraft(),
      actorId: 'owner',
      now: 1,
      activationId: 'activation',
      activityId: 'created',
      create: true,
    });
    const handle = await port.openFlockDoc('workspace:sr');
    expect(readScheduleRegistryRows(handle.flock.scan())).toHaveLength(1);
  });
});

describe('legacy Schedule ACP value compatibility', () => {
  it('projects only declared boolean literals without rewriting the authorized definition', () => {
    const agent = {
      agentConfigId: 'agent',
      configOptionValues: {
        plan_mode: 'false',
        verbose: 'true',
        select_flag: 'false',
        unknown: 'true',
        invalid: 'off',
        typed: false,
      },
    };
    const document = { definition: { ...definition(), agent }, prompt: 'hello', timeline: [] };
    const fingerprint = scheduleDefinitionFingerprint(document);
    expect(
      normalizeLegacyScheduleAgent(agent, [
        { id: 'plan_mode', type: 'boolean' },
        { id: 'verbose', type: 'boolean' },
        { id: 'select_flag', type: 'select' },
        { id: 'invalid', type: 'boolean' },
        { id: 'typed', type: 'boolean' },
      ]).configOptionValues
    ).toEqual({
      plan_mode: false,
      verbose: true,
      select_flag: 'false',
      unknown: 'true',
      invalid: 'off',
      typed: false,
    });
    expect(normalizeLegacyScheduleAgent(agent).configOptionValues).toEqual(
      agent.configOptionValues
    );
    expect(agent.configOptionValues.plan_mode).toBe('false');
    expect(scheduleDefinitionFingerprint(document)).toBe(fingerprint);
  });
  it.each([42, null, {}, [], 'x'.repeat(1025)])('rejects invalid option values', (value) => {
    expect(
      ScheduleAgentSchema.safeParse({
        agentConfigId: 'agent',
        configOptionValues: { option: value },
      }).success
    ).toBe(false);
  });
});
