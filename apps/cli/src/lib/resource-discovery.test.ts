import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type {
  AgentConfigMeta,
  AgentRole,
  LocalProjectMeta,
  MachineId,
  MachineMeta,
  WorkspaceMcpServerMeta,
} from '@lody/shared';
import { ResourceDiscovery, type DiscoverySource } from './resource-discovery';
import { registerDiscoveryTools } from '@/mcp/discovery-tools';
import { createSessionToolRegistrar } from '@/mcp/session-tool-router';

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

  it('filters Roles by their binding while retaining unavailable matches', async () => {
    const discovery = new ResourceDiscovery(
      source({ roles: async () => [role('one'), role('two', { machineId: 'two' as MachineId })] })
    );
    const page = await discovery.list('agent_role', { machineId: 'two' });
    expect(page.items.map((row) => row.id)).toEqual(['two']);
    expect(page.items[0]?.availability?.state).toBe('unavailable');
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

  it('preserves mixed, local-only and machine-scoped project results', async () => {
    const discovery = new ResourceDiscovery(source());
    expect((await discovery.list('project')).items.map((row) => [row.kind, row.machineId])).toEqual(
      [
        ['github', undefined],
        ['local', 'one'],
        ['local', 'two'],
      ]
    );
    expect(
      (await discovery.list('project', { machineId: 'two' })).items.map((row) => [
        row.kind,
        row.machineId,
      ])
    ).toEqual([['local', 'two']]);
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

  it('surfaces read failures without claiming an empty catalog', async () => {
    const discovery = new ResourceDiscovery(
      source({
        projects: async () => {
          throw new Error('sync unavailable');
        },
      })
    );
    await expect(discovery.list('project', { kind: 'local' })).rejects.toThrow('sync unavailable');
  });

  it('serves the shared result through the real MCP wire and rejects irrelevant filters', async () => {
    const discovery = new ResourceDiscovery(source());
    const server = new McpServer({ name: 'synthetic-discovery', version: '1' });
    registerDiscoveryTools(
      createSessionToolRegistrar(server, (_name, _args, run) => run()),
      (read) => read(discovery)
    );
    const client = new Client({ name: 'synthetic-client', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: 'lody_machine_list', arguments: { limit: 1 } });
      const expected = await discovery.list('machine', { limit: 1 });
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(expected) }]);
      for (const [resource, args] of [
        ['machine', { machineId: 'one' }],
        ['project', { onlineStatus: 'online' }],
        ['agent_config', { kind: 'local' }],
        ['agent_role', { onlineStatus: 'online' }],
        ['mcp', { machineId: 'one' }],
      ] as const) {
        const invalid = await client.callTool({ name: `lody_${resource}_list`, arguments: args });
        expect(invalid.isError, resource).toBe(true);
        await expect(discovery.list(resource, args)).rejects.toThrow();
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
