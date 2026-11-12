import { afterEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import * as localIpc from '@lody/shared/node/local-ipc';
import { LoroDoc } from 'loro-crdt';
import { withHistoryPort } from '../../../tests/history-port-fixture';
import {
  ScheduleRepository,
  ScheduleDefinitionSchema,
  type ScheduleCommand,
  type ScheduleRepositoryPort,
} from '@lody/shared';
import {
  scheduleRequesterSessionId,
  sendScheduleCommand,
  sendDaemonScheduleCommand,
} from './schedule-command-client';
import { executeScheduleCommand, type ScheduleCommandContext } from './schedule-command-service';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function fixture() {
  vi.stubEnv('LODY_SESSION_ID', '');
  vi.stubEnv('LODY_PARENT_SESSION_ID', '');
  vi.stubEnv('LODY_AGENT_SESSION_ID', '');
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
  let targetAvailable = false;
  let metaReady = true;
  let syncMeta = async () => true;
  const context = {
    manager: {
      repo: {
        ...port,
        getDocMeta: async (id: string) =>
          id.startsWith('session-') && metaReady
            ? {
                meta: {
                  id: 'session',
                  userId: owner,
                  machineId: 'machine',
                  processingUserMsgId: 'turn',
                },
              }
            : targetAvailable && id === 'machine-machine'
              ? {
                  meta: {
                    id: 'machine',
                    ownerUserId: 'owner',
                    protocolCapabilities: { schedules: 2 },
                  },
                }
              : targetAvailable && id === 'agent-agent'
                ? {
                    meta: {
                      id: 'agent',
                      machineId: 'machine',
                      name: 'Synthetic',
                      cliType: 'custom',
                      agentType: 'synthetic',
                    },
                  }
                : undefined,
      },
      waitUntilMetaSynced: async () => {
        const synced = await syncMeta();
        if (synced) metaReady = true;
        return synced;
      },
      getOrCreateSessionDoc: async () =>
        withHistoryPort({
          roomId: 'session-session',
          waitUntilSynced: notificationSync,
          getHistory: () => [{ id: 'turn', role: 'user' }, ...history],
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
    targetAvailable: () => {
      targetAvailable = true;
    },
    coldMeta: (sync: () => Promise<boolean>) => {
      metaReady = false;
      syncMeta = sync;
    },
    draft: {
      title: definition.title,
      machineId: definition.machineId,
      trigger: definition.trigger,
      misfirePolicy: definition.misfirePolicy,
      overlapPolicy: definition.overlapPolicy,
      retryPolicy: definition.retryPolicy,
      agent: definition.agent,
      prompt: 'Synthetic prompt',
    },
    history: () => history,
    owner: (value: string) => {
      owner = value;
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
  it('enforces the MCP action whitelist and invoking Session owner at the domain boundary', async () => {
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
    await expect(
      executeScheduleCommand(h.context, { action: 'list', limit: 1 })
    ).resolves.toMatchObject({ matched: 1 });
  });
});

it('records attributable MCP pauses and an idempotent ordinary Session notice', async () => {
  const h = await fixture();
  h.context.requesterSessionId = 'session' as never;
  h.context.workspace.contentMode = 'e2ee';
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
});

it.each(['requesterSessionId', 'LODY_AGENT_SESSION_ID'])(
  'restricts commands with inherited %s before any schedule mutation',
  async (variable) => {
    const h = await fixture();
    const requester = variable === 'requesterSessionId' ? ('session' as never) : undefined;
    if (variable === 'LODY_AGENT_SESSION_ID') vi.stubEnv(variable, 'session');
    h.context.requesterSessionId = scheduleRequesterSessionId(requester);
    const d = await h.repository.read('schedule');
    if (!d) throw new Error('missing schedule');
    const draft = {
      misfirePolicy: d.definition.misfirePolicy,
      overlapPolicy: d.definition.overlapPolicy,
      retryPolicy: d.definition.retryPolicy,
      title: d.definition.title,
      machineId: d.definition.machineId,
      trigger: d.definition.trigger,
      agent: d.definition.agent,
      prompt: d.prompt,
    };
    for (const command of [
      { action: 'create', scheduleId: 'new', draft, requestId: 'create' },
      {
        action: 'edit',
        scheduleId: 'schedule',
        draft: { ...draft, prompt: 'edited' },
        requestId: 'edit',
      },
      { action: 'resume', scheduleId: 'schedule', requestId: 'resume' },
      { action: 'run', scheduleId: 'schedule', requestId: 'run' },
      { action: 'delete', scheduleId: 'schedule' },
    ] as ScheduleCommand[]) {
      await expect(executeScheduleCommand(h.context, command)).rejects.toThrow('human');
      await expect(
        sendScheduleCommand(command, { requesterSessionId: h.context.requesterSessionId })
      ).rejects.toThrow('human');
    }
    expect(await h.repository.read('schedule')).toEqual(d);
    await executeScheduleCommand(h.context, {
      action: 'pause',
      scheduleId: 'schedule',
      requestId: 'pause-env',
    });
    expect((await h.repository.read('schedule'))?.definition.enabled).toBe(false);
    expect(h.history()).toHaveLength(1);
  }
);

it.each(['LODY_SESSION_ID', 'LODY_PARENT_SESSION_ID', 'LODY_AGENT_SESSION_ID'])(
  'ignores daemon-owned %s when the client sends no requester',
  async (variable) => {
    const h = await fixture();
    h.targetAvailable();
    vi.stubEnv(variable, 'stale-daemon-session');
    await executeScheduleCommand(h.context, {
      action: 'create',
      scheduleId: 'human',
      requestId: 'create-human',
      draft: h.draft,
    });
    await executeScheduleCommand(h.context, {
      action: 'pause',
      scheduleId: 'human',
      requestId: 'pause-human',
    });
    await executeScheduleCommand(h.context, {
      action: 'resume',
      scheduleId: 'human',
      requestId: 'resume-human',
    });
    expect((await h.repository.read('human'))?.definition.enabled).toBe(true);
    expect(h.history()).toEqual([]);
  }
);

function useDaemon(h: Awaited<ReturnType<typeof fixture>>) {
  vi.spyOn(localIpc, 'makeLocalControlClientAuto').mockReturnValue({
    scheduleControl: (request) =>
      Effect.promise(async () => ({
        ok: true as const,
        result: await executeScheduleCommand(
          {
            ...h.context,
            requesterSessionId:
              request.requesterSessionId as ScheduleCommandContext['requesterSessionId'],
          },
          request.command
        ),
      })),
  } as ReturnType<typeof localIpc.makeLocalControlClientAuto>);
  return (command: ScheduleCommand) =>
    sendDaemonScheduleCommand(command, { machineId: 'machine', workspaceId: 'workspace' });
}

it.each(['LODY_SESSION_ID', 'LODY_PARENT_SESSION_ID'])(
  'allows human CLI authoring when only %s is present',
  async (variable) => {
    const h = await fixture();
    h.targetAvailable();
    vi.stubEnv(variable, 'human-terminal-session');
    const send = useDaemon(h);
    expect(scheduleRequesterSessionId()).toBeUndefined();
    await send({ action: 'create', scheduleId: 'human', requestId: 'create', draft: h.draft });
    await send({ action: 'pause', scheduleId: 'human', requestId: 'pause' });
    await send({ action: 'resume', scheduleId: 'human', requestId: 'resume' });
    expect((await h.repository.read('human'))?.definition.enabled).toBe(true);
    expect(h.history()).toEqual([]);
  }
);

it('keeps the four Agent CLI actions scoped to their invoking Session', async () => {
  const h = await fixture();
  vi.stubEnv('LODY_AGENT_SESSION_ID', 'session');
  const send = useDaemon(h);
  await expect(send({ action: 'list', limit: 30 })).resolves.toMatchObject({ matched: 1 });
  await expect(send({ action: 'show', scheduleId: 'schedule' })).resolves.toMatchObject({
    schedule: { prompt: 'Synthetic prompt' },
  });
  await send({ action: 'pause', scheduleId: 'schedule', requestId: 'agent-pause' });
  await send({
    action: 'propose',
    requestId: 'agent-propose',
    title: 'Daily',
    prompt: 'Synthetic',
    rule: { kind: 'daily', hour: 9, minute: 0 },
  });
  expect((await h.repository.read('schedule'))?.definition.enabled).toBe(false);
  expect(h.history()).toHaveLength(2);
  h.owner('other');
  await expect(
    executeScheduleCommand(
      { ...h.context, requesterSessionId: 'session' as never },
      { action: 'list', limit: 30 }
    )
  ).rejects.toThrow('owner');
});

it.each(['list', 'pause', 'propose'] as const)(
  'waits for cold workspace metadata before authorizing %s',
  async (action) => {
    const h = await fixture();
    h.context.localOnly = false;
    h.context.requesterSessionId = 'session' as never;
    h.notificationSync.mockResolvedValue(true);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<boolean>();
    h.coldMeta(() => {
      entered.resolve();
      return release.promise;
    });
    const command: ScheduleCommand =
      action === 'list'
        ? { action, limit: 30 }
        : action === 'pause'
          ? { action, scheduleId: 'schedule', requestId: 'pause-cold' }
          : {
              action,
              requestId: 'propose-cold',
              title: 'Daily',
              prompt: 'Synthetic prompt',
              rule: { kind: 'daily', hour: 9, minute: 0 },
            };
    const result = executeScheduleCommand(h.context, command);
    await entered.promise;
    expect(h.history()).toEqual([]);
    expect((await h.repository.read('schedule'))?.definition.enabled).toBe(true);
    release.resolve(true);
    await expect(result).resolves.toMatchObject(action === 'list' ? { matched: 1 } : { ok: true });
    if (action === 'pause')
      expect((await h.repository.read('schedule'))?.definition.enabled).toBe(false);
    if (action === 'propose') expect(h.history()[0].items[0].name).toBe('schedule_proposal');
  }
);

it('keeps a cold metadata failure retryable without changing the Schedule', async () => {
  const h = await fixture();
  h.context.localOnly = false;
  h.context.requesterSessionId = 'session' as never;
  h.notificationSync.mockResolvedValue(true);
  h.coldMeta(async () => false);
  const command = { action: 'pause', scheduleId: 'schedule', requestId: 'pause-retry' } as const;
  await expect(executeScheduleCommand(h.context, command)).rejects.toThrow(
    'metadata changes were not confirmed'
  );
  expect((await h.repository.read('schedule'))?.definition.enabled).toBe(true);
  expect(h.history()).toEqual([]);
  h.coldMeta(async () => true);
  await expect(executeScheduleCommand(h.context, command)).resolves.toMatchObject({ ok: true });
  expect((await h.repository.read('schedule'))?.definition.enabled).toBe(false);
});
