import { describe, expect, it, vi } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { withHistoryPort } from '../../../tests/history-port-fixture';
import {
  ScheduleRepository,
  ScheduleDefinitionSchema,
  type ScheduleCommand,
  type ScheduleRepositoryPort,
} from '@lody/shared';
import { executeScheduleCommand, type ScheduleCommandContext } from './schedule-command-service';

async function fixture() {
  const docs = new Map<string, LoroDoc>();
  const rows = new Map<string, unknown>();
  const registrySync = vi.fn(async () => {});
  const documentSync = vi.fn(async () => {});
  const notificationSync = vi.fn(async () => false);
  const port: ScheduleRepositoryPort = {
    openPersistedDoc: async (id) => {
      if (!docs.has(id)) docs.set(id, new LoroDoc());
      return { doc: docs.get(id)!, syncOnce: documentSync };
    },
    openFlockDoc: async () => ({
      syncOnce: registrySync,
      flock: {
        get: (key) => rows.get(JSON.stringify(key)),
        set: (key, value) => rows.set(JSON.stringify(key), value),
        scan: () => [...rows].map(([key, value]) => ({ key: JSON.parse(key), value })),
      },
    }),
    flush: async () => {},
  };
  const repository = new ScheduleRepository(port, 'workspace' as never);
  const definition = ScheduleDefinitionSchema.parse({
    scheduleId: 'schedule',
    title: 'Daily',
    ownerId: 'owner',
    machineId: 'machine',
    enabled: true,
    activationId: 'initial',
    activeFrom: 0,
    trigger: { kind: 'once', at: '2026-09-10T00:00:00Z' },
    misfirePolicy: { kind: 'skip' },
    overlapPolicy: 'skip',
    agent: { agentConfigId: 'agent', modeId: 'safe' },
    project: { kind: 'github', repoFullName: 'example/project', branch: 'main' },
    retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86400000 },
    createdAt: 0,
    updatedAt: 0,
    createdBy: 'owner',
  });
  await repository.save({
    scheduleId: 'schedule',
    draft: { ...definition, prompt: 'Synthetic prompt' },
    actorId: 'owner',
    now: 1,
    activationId: 'initial',
    activityId: 'create',
    create: true,
  });
  let history: any[] = [];
  let owner = 'owner';
  let tools = true;
  const context = {
    manager: {
      repo: {
        ...port,
        getDocMeta: async (id: string) =>
          id.startsWith('session-')
            ? {
                meta: {
                  id: 'session',
                  userId: owner,
                  machineId: 'machine',
                  processingUserMsgId: 'turn',
                },
              }
            : undefined,
      },
      getOrCreateSessionDoc: async () =>
        withHistoryPort({
          roomId: 'session-session',
          waitUntilSynced: notificationSync,
          getHistory: () => [
            { id: 'turn', role: 'user', inputConfig: { scheduleToolsEnabled: tools } },
            ...history,
          ],
          updateHistory: async (update: (entries: any[]) => any[]) => {
            history = update(history);
          },
        }),
      syncDocOrThrow: vi.fn(),
    },
    workspace: { id: 'workspace' },
    auth: { userId: 'owner', machineId: 'machine' },
    localOnly: true,
  } as unknown as ScheduleCommandContext;
  return {
    context,
    repository,
    registrySync,
    documentSync,
    notificationSync,
    history: () => history,
    owner: (value: string) => {
      owner = value;
    },
    tools: (value: boolean) => {
      tools = value;
    },
  };
}
describe('Schedule command authorization', () => {
  it('lets the owner pause/delete after the target machine disappears, without cloud requests', async () => {
    const h = await fixture();
    await executeScheduleCommand(h.context, {
      action: 'pause',
      scheduleId: 'schedule',
      requestId: 'pause',
    });
    expect((await h.repository.list())[0]?.enabled).toBe(false);
    await expect(
      executeScheduleCommand(h.context, {
        action: 'resume',
        scheduleId: 'schedule',
        requestId: 'resume',
      })
    ).rejects.toThrow('owned');
    await executeScheduleCommand(h.context, { action: 'delete', scheduleId: 'schedule' });
    expect(await h.repository.list()).toEqual([]);
    await executeScheduleCommand(h.context, { action: 'delete', scheduleId: 'schedule' });
    expect(h.context.manager.syncDocOrThrow).not.toHaveBeenCalled();
  });
  it('enforces the MCP action whitelist and driving turn owner/feature at the domain boundary', async () => {
    const h = await fixture();
    h.context.requesterSessionId = 'session' as never;
    for (const action of ['resume', 'run', 'delete'])
      await expect(
        executeScheduleCommand(h.context, {
          action,
          scheduleId: 'schedule',
          ...(action !== 'delete' ? { requestId: 'request' } : {}),
        } as ScheduleCommand)
      ).rejects.toThrow('human');
    h.owner('other');
    await expect(executeScheduleCommand(h.context, { action: 'list', limit: 30 })).rejects.toThrow(
      'owner'
    );
    h.owner('owner');
    h.tools(false);
    await expect(executeScheduleCommand(h.context, { action: 'list', limit: 30 })).rejects.toThrow(
      'driving Turn'
    );
    h.tools(true);
    await expect(
      executeScheduleCommand(h.context, { action: 'list', limit: 1 })
    ).resolves.toMatchObject({ matched: 1 });
  });
});

it('records attributable MCP pauses and an idempotent ordinary Session notice', async () => {
  const h = await fixture();
  h.context.requesterSessionId = 'session' as never;
  const command = {
    action: 'pause',
    scheduleId: 'schedule',
    requestId: 'pause-from-agent',
  } as const;
  await executeScheduleCommand(h.context, command);
  await executeScheduleCommand(h.context, command);
  expect(
    (await h.repository.read('schedule'))?.timeline.filter(
      (entry) => entry.id === 'pause-from-agent'
    )
  ).toMatchObject([{ requesterSessionId: 'session', actorId: 'owner' }]);
  expect(h.history()).toHaveLength(1);
  expect(h.history()[0]).toMatchObject({
    role: 'system',
    items: [{ type: 'text', text: expect.stringContaining('Paused scheduled task') }],
  });
});

it('publishes the pause gate before waiting for a failed notification sync', async () => {
  const h = await fixture();
  h.context.localOnly = false;
  h.context.requesterSessionId = 'session' as never;
  await expect(
    executeScheduleCommand(h.context, {
      action: 'pause',
      scheduleId: 'schedule',
      requestId: 'pause',
    })
  ).rejects.toThrow('notification sync pending');
  expect((await h.repository.list())[0]?.enabled).toBe(false);
  expect(h.documentSync).toHaveBeenCalledOnce();
  expect(h.registrySync).toHaveBeenCalled();
  expect(h.registrySync.mock.invocationCallOrder.at(-1)).toBeLessThan(
    h.notificationSync.mock.invocationCallOrder[0]!
  );
});

it('bounds MCP prompt output and returns usable Registry pagination metadata', async () => {
  const h = await fixture();
  const document = (await h.repository.read('schedule'))!;
  await h.repository.save({
    scheduleId: 'schedule',
    draft: { ...document.definition, prompt: 'x'.repeat(9000) },
    actorId: 'owner',
    now: 2,
    activationId: 'edit',
    activityId: 'edit',
  });
  h.context.requesterSessionId = 'session' as never;
  const result = (await executeScheduleCommand(h.context, {
    action: 'show',
    scheduleId: 'schedule',
  })) as { schedule: { prompt: string }; truncated: { promptCharsOmitted: number } };
  expect(result.schedule.prompt).toHaveLength(8000);
  expect(result.truncated.promptCharsOmitted).toBe(1000);
  expect(
    await executeScheduleCommand(h.context, { action: 'list', limit: 1, offset: 1 })
  ).toMatchObject({ schedules: [], matched: 1 });
});

describe('proposing a schedule from a conversation', () => {
  const propose = (h: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) =>
    executeScheduleCommand(h.context, {
      action: 'propose',
      requestId: 'nightly',
      title: 'Nightly review',
      prompt: 'Review today’s commits and list anything risky.',
      rule: { kind: 'daily', hour: 21, minute: 0 },
      ...extra,
    } as ScheduleCommand);

  it('writes one card into the invoking conversation, idempotently', async () => {
    const h = await fixture();
    h.context.requesterSessionId = 'session' as never;
    await expect(propose(h)).resolves.toMatchObject({ ok: true, pending: true, enabled: false });
    await expect(propose(h)).resolves.toMatchObject({ ok: true, pending: true });
    const cards = h.history().filter((entry) => entry.id === 'schedule-proposal-nightly');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      role: 'system',
      items: [
        {
          type: 'system_notice',
          name: 'schedule_proposal',
          meta: {
            proposalId: 'nightly',
            title: 'Nightly review',
            rule: { kind: 'daily', hour: 21, minute: 0 },
            proposedBy: { kind: 'agent' },
          },
        },
      ],
    });
  });

  it('refuses to reuse a request id for a different proposal', async () => {
    const h = await fixture();
    h.context.requesterSessionId = 'session' as never;
    await propose(h);
    await expect(propose(h, { title: 'Something else' })).rejects.toThrow('Idempotency');
  });

  it('reports the outcome once the person has acted on the card', async () => {
    const h = await fixture();
    h.context.requesterSessionId = 'session' as never;
    await propose(h);
    // The renderer writes the outcome back onto the same item.
    const session = await h.context.manager.getOrCreateSessionDoc('session' as never);
    await session.updateHistory((history) =>
      history.map((entry) =>
        entry.id === 'schedule-proposal-nightly'
          ? {
              ...entry,
              items: [
                {
                  ...entry.items![0]!,
                  meta: { ...entry.items![0]!.meta, outcome: 'created', scheduleId: 'nightly' },
                },
              ],
            }
          : entry
      )
    );
    await expect(propose(h)).resolves.toMatchObject({
      ok: true,
      pending: false,
      outcome: 'created',
      scheduleId: 'nightly',
    });
  });

  it('rejects a rule the editor could not show, before writing anything', async () => {
    const h = await fixture();
    h.context.requesterSessionId = 'session' as never;
    await expect(
      propose(h, { rule: { kind: 'weekly', weekdays: [], hour: 9, minute: 0 } })
    ).rejects.toThrow();
    await expect(
      propose(h, { rule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' } })
    ).rejects.toThrow();
    expect(h.history()).toHaveLength(0);
  });

  it('requires an invoking conversation', async () => {
    const h = await fixture();
    await expect(propose(h)).rejects.toThrow('invoking Session');
  });
});
