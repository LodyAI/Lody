import { describe, expect, it } from 'vitest';

import type {
  AgentConfigMeta,
  AgentRole,
  LocalProjectMeta,
  MachineId,
  MachineMeta,
  WorkspaceMcpServerMeta,
} from '@lody/shared';
import { ResourceDiscovery, type DiscoverySource } from './resource-discovery';

const machine = (id: string): MachineMeta => ({ id, name: id }) as MachineMeta;
const config = (id: string, machineId = 'one'): AgentConfigMeta =>
  ({
    id,
    machineId,
    name: `Agent ${id}`,
    cliType: 'builtin',
    agentType: 'codex',
  }) as AgentConfigMeta;
const role = (id: string, overrides: Partial<AgentRole> = {}): AgentRole =>
  ({
    v: 1,
    id,
    name: id,
    ownerUserId: 'user',
    visibility: 'workspace',
    machineId: 'one',
    agentConfigId: 'agent',
    runConfig: {},
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }) as AgentRole;
const source = (overrides: Partial<DiscoverySource> = {}): DiscoverySource => ({
  workspaceId: 'workspace',
  userId: 'user',
  machines: async () => [machine('one'), machine('two'), machine('hidden')],
  onlineMachineIds: async () => new Set(['one'] as MachineId[]),
  canAccess: async (id) => id !== 'hidden',
  configs: async (id) => (id === 'one' ? [config('agent')] : []),
  capabilities: async () => ({
    agent: {
      cliType: 'builtin',
      agentType: 'codex',
      fetchedAt: 1,
      modes: [{ id: 'safe', name: 'Safe' }],
      models: [{ modelId: 'model', name: 'Model' }],
    },
  }),
  projects: async (id) => [
    {
      id: 'same-path',
      name: 'Project',
      rootPath: '/synthetic/project',
      machineId: id,
    } as LocalProjectMeta,
  ],
  roles: async () => [],
  repositories: async () => [{ fullName: 'synthetic/repo' }],
  mcpServers: async () => [],
  ...overrides,
});

describe('resource discovery across MCP and CLI', () => {
  it('marks an Agent config unavailable until its scoped quota resets', async () => {
    const resetsAtEpochSeconds = 4_102_444_800;
    const discovery = new ResourceDiscovery(
      source({
        rateLimits: async () => ({
          'provider::agent::builtin::weekly': {
            limitId: 'weekly',
            scope: { providerId: 'codex' },
            windows: [{ usedPercent: 100, windowDurationSeconds: 604800, resetsAtEpochSeconds }],
          },
        }),
      })
    );

    const listed = await discovery.list('agent_config', {});
    expect(listed.items[0]).toMatchObject({
      id: 'agent',
      availability: {
        state: 'unavailable',
        reason: 'quota_exhausted',
        availableAt: new Date(resetsAtEpochSeconds * 1000).toISOString(),
      },
    });

    const machines = await discovery.list('machine', {});
    expect(machines.items[0]?.quota).toEqual([
      expect.objectContaining({
        agentConfigId: 'agent',
        exhausted: true,
        unavailableUntil: new Date(resetsAtEpochSeconds * 1000).toISOString(),
      }),
    ]);
  });

  it('reports quota windows and opt-in machine resources without failing on an unavailable machine', async () => {
    const discovery = new ResourceDiscovery(
      source({
        rateLimits: async (id) =>
          id === 'one'
            ? {
                weekly: {
                  limitId: 'weekly',
                  scope: { providerId: 'codex' },
                  windows: [
                    { usedPercent: 40, windowDurationSeconds: 3600, resetsAtEpochSeconds: null },
                    {
                      usedPercent: 100,
                      windowDurationSeconds: 604800,
                      resetsAtEpochSeconds: 1_793_000_000,
                    },
                  ],
                },
                // A legacy synced row without scope/windows must not break the list.
                legacy: { limitId: 'legacy', usedPercent: 80, resetsAt: 1 } as never,
              }
            : Promise.reject(new Error('Synthetic flock read failure')),
        onlineMachineIds: async () => new Set(['one', 'two'] as MachineId[]),
        machineResources: async (target) => {
          if (target.id === 'two') throw new Error('Synthetic RPC timeout');
          return { disk: { totalGB: 100, freeGB: 1, usedPercent: 99 } };
        },
      })
    );
    const plain = await discovery.list('machine', {});
    expect(plain.items).toEqual([
      expect.objectContaining({
        id: 'one',
        quota: [
          expect.objectContaining({ provider: 'codex', usedPercent: 100, exhausted: true }),
          expect.objectContaining({ usedPercent: 40, exhausted: false }),
        ],
      }),
      expect.not.objectContaining({ quota: expect.anything() }),
    ]);
    expect(plain.items[0]).not.toHaveProperty('resources');
    expect(plain.items[0]?.quota).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resetsAt: new Date(1_793_000_000_000).toISOString() }),
      ])
    );

    const withResources = await discovery.list('machine', { includeResources: true });
    expect(withResources.items).toEqual([
      expect.objectContaining({
        id: 'one',
        resources: { disk: expect.objectContaining({ freeGB: 1 }) },
      }),
      expect.objectContaining({ id: 'two', resources: 'unavailable' }),
    ]);
  });

  it('marks unconfirmed catalogs as syncing instead of inventing missing configurations or capabilities', async () => {
    const readiness = {
      metadata: true,
      workspace: true,
      machines: new Map([['one' as MachineId, false]]),
    };
    const discovery = new ResourceDiscovery(
      source({
        roles: async () => [role('cold')],
        configs: async () => [],
        catalogReadiness: () => readiness,
      })
    );
    expect((await discovery.list('agent_role')).items[0]?.availability).toEqual({
      state: 'unknown',
      reason: 'catalog_syncing',
    });
    expect(await discovery.list('agent_config')).toMatchObject({
      items: [],
      sync: { state: 'syncing', retryable: true },
    });
    await expect(discovery.get('agent_config', 'agent')).rejects.toThrow('CATALOG_SYNCING');
    readiness.machines.set('one' as MachineId, true);
    expect((await discovery.list('agent_role')).items[0]?.availability).toEqual({
      state: 'unavailable',
      reason: 'agent_config_missing',
    });
    await expect(discovery.get('agent_config', 'agent')).rejects.toThrow('RESOURCE_NOT_FOUND');
  });

  it('downgrades stale model and capability negatives while preserving denied machine access', async () => {
    const readiness = {
      metadata: false,
      workspace: false,
      machines: new Map([['one' as MachineId, false]]),
    };
    const stale = new ResourceDiscovery(
      source({
        roles: async () => [role('model', { runConfig: { modelId: 'new-model' } })],
        catalogReadiness: () => readiness,
      })
    );
    expect((await stale.list('agent_role')).items[0]?.availability).toEqual({
      state: 'unknown',
      reason: 'catalog_syncing',
    });
    const denied = new ResourceDiscovery(
      source({
        roles: async () => [role('denied')],
        canAccess: async () => false,
        catalogReadiness: () => readiness,
      })
    );
    expect((await denied.list('agent_role')).items[0]?.availability?.reason).toBe(
      'machine_inaccessible_or_missing'
    );
    const capabilities = new ResourceDiscovery(
      source({
        roles: async () => [role('caps')],
        capabilities: async () => ({}),
        catalogReadiness: () => readiness,
      })
    );
    expect((await capabilities.list('agent_role')).items[0]?.availability).toEqual({
      state: 'unknown',
      reason: 'catalog_syncing',
    });
  });

  it('enumerates beyond 20, preserves stable continuation after insertion and rejects cursor scope changes', async () => {
    const configs = Array.from({ length: 45 }, (_, n) => config(`a-${String(n).padStart(2, '0')}`));
    const deps = source({ configs: async (id) => (id === 'one' ? configs : []) });
    const discovery = new ResourceDiscovery(deps);
    const first = await discovery.list('agent_config');
    expect(first.items).toHaveLength(20);
    configs.unshift(config('a--before'));
    const second = await discovery.list('agent_config', { cursor: first.nextCursor });
    const third = await discovery.list('agent_config', { cursor: second.nextCursor });
    expect(
      new Set([...first.items, ...second.items, ...third.items].map((row) => row.id)).size
    ).toBe(45);
    expect(third.hasMore).toBe(false);
    await expect(
      discovery.list('agent_config', { cursor: first.nextCursor, query: 'Agent' })
    ).rejects.toThrow('CURSOR_INVALID');
    await expect(
      new ResourceDiscovery({ ...deps, userId: 'another' }).list('agent_config', {
        cursor: first.nextCursor,
      })
    ).rejects.toThrow('CURSOR_INVALID');
  });

  it('keeps offline machines, never turns missing presence into offline, and excludes denied machines', async () => {
    const online = await new ResourceDiscovery(source()).list('machine');
    expect(online.items.map((row) => [row.id, row.onlineStatus])).toEqual([
      ['one', 'online'],
      ['two', 'offline'],
    ]);
    const unknown = await new ResourceDiscovery(
      source({ onlineMachineIds: async () => null })
    ).list('machine', { onlineStatus: 'unknown' });
    expect(unknown.items).toHaveLength(2);
    expect(unknown.items.every((row) => row.availability?.state === 'unknown')).toBe(true);
  });

  it('pages distinct project identities across machines and checks project access independently', async () => {
    const discovery = new ResourceDiscovery(source());
    const a = await discovery.list('project', { kind: 'local', limit: 1 });
    const b = await discovery.list('project', { kind: 'local', limit: 1, cursor: a.nextCursor });
    expect([a.items[0]?.machineId, b.items[0]?.machineId]).toEqual(['one', 'two']);
    expect(b.hasMore).toBe(false);
    const filtered = await new ResourceDiscovery(
      source({ canAccess: async (id, project) => id !== 'hidden' && !(id === 'two' && project) })
    ).list('project', { kind: 'local' });
    expect(filtered.items.map((row) => row.machineId)).toEqual(['one']);
    expect((await discovery.list('project', { kind: 'github' })).items[0]?.id).toBe(
      'synthetic/repo'
    );
    await expect(discovery.list('project', { kind: 'github', machineId: 'one' })).rejects.toThrow(
      'not bound'
    );
  });

  it('keeps readable broken Roles, hides others private Roles and filters sensitive run options', async () => {
    const roles = [
      role('good', {
        description: 'Review changes before merging',
        promptPrefix: 'Synthetic instructions',
        runConfig: { configOptionValues: { api_key: 'synthetic-secret', effort: 'high' } },
      }),
      role('private', { visibility: 'private', ownerUserId: 'other' }),
      role('offline', { machineId: 'two' as MachineId }),
      role('missing', { machineId: 'gone' as MachineId }),
      role('model', { runConfig: { modelId: 'gone' } }),
      role('mode', { runConfig: { modeId: 'gone' } }),
    ];
    const discovery = new ResourceDiscovery(source({ roles: async () => roles }));
    const page = await discovery.list('agent_role');
    expect(page.items.find((row) => row.id === 'good')?.description).toBe(
      'Review changes before merging'
    );
    expect(page.items.find((row) => row.id === 'offline')?.description).toBe('');
    expect((await discovery.get('agent_role', 'good')).item.description).toBe(
      'Review changes before merging'
    );
    expect(page.items.map((row) => row.id)).not.toContain('private');
    expect(page.items.find((row) => row.id === 'missing')?.availability?.reason).toBe(
      'machine_inaccessible_or_missing'
    );
    expect(page.items.find((row) => row.id === 'model')?.availability?.reason).toBe(
      'model_unavailable'
    );
    expect(page.items.find((row) => row.id === 'mode')?.availability?.reason).toBe(
      'mode_unavailable'
    );
    expect(JSON.stringify(page)).not.toContain('synthetic-secret');
    expect(JSON.stringify(page)).not.toContain('Synthetic instructions');
    expect((await discovery.get('agent_role', 'good')).item.promptPrefix).toBe(
      'Synthetic instructions'
    );
    await expect(discovery.get('agent_role', 'private')).rejects.toThrow('RESOURCE_NOT_FOUND');
    await expect(discovery.get('agent_role', 'absent')).rejects.toThrow('RESOURCE_NOT_FOUND');
    const unknown = new ResourceDiscovery(
      source({ roles: async () => [role('bound')], onlineMachineIds: async () => null })
    );
    expect((await unknown.get('agent_role', 'bound')).item.availability).toEqual({
      state: 'unknown',
      reason: 'presence_unavailable',
    });
  });

  it('checks a Role permission pin against the agent `_permission` option', async () => {
    const discovery = new ResourceDiscovery(
      source({
        capabilities: async () => ({
          // Shaped like Grok's catalog; bound to the fixture's agent config.
          agent: {
            cliType: 'builtin',
            agentType: 'codex',
            fetchedAt: 1,
            modes: [],
            models: [{ modelId: 'model', name: 'Model' }],
            configOptions: [
              {
                id: 'permission_mode',
                name: 'Permission Mode',
                category: '_permission',
                type: 'select',
                currentValue: 'ask',
                options: [
                  { value: 'ask', name: 'Ask Every Time' },
                  { value: 'always-approve', name: 'Always Approve' },
                ],
              },
            ],
          },
        }),
        roles: async () => [
          role('approve', {
            runConfig: { configOptionValues: { permission_mode: 'always-approve' } },
          }),
          role('retired', { runConfig: { configOptionValues: { permission_mode: 'yolo' } } }),
        ],
      })
    );
    const page = await discovery.list('agent_role');
    expect(page.items.find((row) => row.id === 'approve')?.availability?.state).toBe('available');
    expect(page.items.find((row) => row.id === 'retired')?.availability?.reason).toBe(
      'mode_unavailable'
    );
  });

  it('filters Roles by their binding while retaining unavailable matches', async () => {
    const discovery = new ResourceDiscovery(
      source({ roles: async () => [role('one'), role('two', { machineId: 'two' as MachineId })] })
    );
    const page = await discovery.list('agent_role', { machineId: 'two' });
    expect(page.items.map((row) => row.id)).toEqual(['two']);
    expect(page.items[0]?.availability?.state).toBe('unavailable');
  });

  it('lists a multi-machine Role once per machine and returns every machine on get', async () => {
    const both = role('both', {
      alias: 'Both-One',
      additionalTargets: [
        { machineId: 'two' as MachineId, agentConfigId: 'cfg-two' as never, runConfig: {} },
      ],
    });
    const discovery = new ResourceDiscovery(source({ roles: async () => [both] }));
    const page = await discovery.list('agent_role');
    expect(page.items.map((row) => [row.id, row.machineId, row.machineCount])).toEqual([
      ['both', 'one', 2],
      ['both', 'two', 2],
    ]);
    expect(page.items[0]?.alias).toBe('Both-One');
    const got = await discovery.get('agent_role', 'both');
    expect(got.targets?.map((row) => row.machineId)).toEqual(['one', 'two']);
    expect(
      (await discovery.list('agent_role', { machineId: 'two' })).items.map((row) => row.machineId)
    ).toEqual(['two']);
  });

  it('reads GitHub-only projects independently of the local machine catalog', async () => {
    const discovery = new ResourceDiscovery(
      source({
        machines: async () => {
          throw new Error('machine catalog unavailable');
        },
      })
    );
    expect((await discovery.list('project', { kind: 'github' })).items).toEqual([
      {
        id: 'synthetic/repo',
        name: 'synthetic/repo',
        kind: 'github',
        repoFullName: 'synthetic/repo',
      },
    ]);
  });

  it('reports cached and missing agent capabilities and omits launch secrets', async () => {
    const deps = source({
      configs: async (id) =>
        id === 'one'
          ? [
              { ...config('agent'), env: { TOKEN: 'synthetic-secret' } },
              { ...config('unreported'), agentType: 'claude' },
            ]
          : [],
    });
    const page = await new ResourceDiscovery(deps).list('agent_config');
    expect(page.items).toMatchObject([
      {
        id: 'agent',
        capabilityStatus: 'reported',
        runConfig: { models: [{ id: 'model', name: 'Model' }] },
      },
      { id: 'unreported', capabilityStatus: 'unknown', runConfig: { models: [] } },
    ]);
    expect(JSON.stringify(page)).not.toContain('synthetic-secret');
  });

  it('omits MCP connection values and distinguishes unknown selection from an explicit empty selection', async () => {
    const servers = [
      {
        id: 'server',
        name: 'Server',
        transport: 'stdio',
        connection: {
          transport: 'stdio',
          command: 'synthetic-command',
          env: { TOKEN: 'synthetic-secret' },
        },
      } as WorkspaceMcpServerMeta,
    ];
    const cli = await new ResourceDiscovery(source({ mcpServers: async () => servers })).list(
      'mcp'
    );
    const mcp = await new ResourceDiscovery(
      source({ mcpServers: async () => servers, selectedMcpServerIds: [] })
    ).list('mcp');
    expect(cli.items[0]).not.toHaveProperty('selectedForCurrentTurn');
    expect(mcp.items[0]?.selectedForCurrentTurn).toBe(false);
    expect(JSON.stringify(mcp)).not.toContain('synthetic-command');
    expect(JSON.stringify(mcp)).not.toContain('synthetic-secret');
  });
});
