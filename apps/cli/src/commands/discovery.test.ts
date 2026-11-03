import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { McpServer } from '@modelcontextprotocol/server';
import { registerAgentRoleTools } from '@/mcp/agent-role-tools';
import { createSessionToolRegistrar, type SessionToolHandlers } from '@/mcp/session-tool-router';
import { agentRoleWriteCommand } from './agent-role-write';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRole, MachineId, MachineMeta } from '@lody/shared';
import { ResourceDiscovery, type DiscoverySource } from '@/lib/resource-discovery';
import { discoveryListCommand } from './discovery';

const state = vi.hoisted(() => ({
  output: undefined as unknown,
  discovery: undefined as ResourceDiscovery | undefined,
  platform: 'cloud',
  handlers: new Map() as SessionToolHandlers,
  proposed: [] as unknown[],
}));
vi.mock('@/lib/resource-discovery-runtime', () => ({
  createResourceDiscovery: async () => state.discovery,
}));
vi.mock('@/lib/cli-platform', () => ({ getCliPlatformKind: () => state.platform }));
vi.mock('@/lib/local-workspace-catalog', () => ({
  makeLocalWorkspaceCatalog: () => ({
    read: () =>
      Effect.succeed({
        machine: { machineId: 'machine' },
        workspaces: [{ state: 'active', workspaceId: 'workspace', slug: 'local' }],
      }),
  }),
}));
vi.mock('@lody/shared/node/local-ipc', () => ({
  makeLocalControlClientAuto: () => ({
    machineRpc: (request: {
      machineId: string;
      workspaceId: string;
      ownerSessionId: string;
      params: { sessionId: string; name: string; arguments: unknown };
    }) =>
      Effect.tryPromise(async () => {
        if (
          request.machineId !== 'machine' ||
          request.workspaceId !== 'workspace' ||
          request.ownerSessionId !== 'session' ||
          request.params.sessionId !== 'session'
        )
          return { ok: false, error: 'Session tool scope mismatch' };
        const handler = state.handlers.get(request.params.name);
        if (!handler) throw new Error('Tool not registered');
        return {
          ok: true,
          result: { type: 'session/tool-result', ...(await handler(request.params.arguments)) },
        };
      }),
  }),
}));
vi.mock('@/lib/command-runtime', () => ({
  classifyLocalDaemonIpcError: (error: unknown) => error,
  getAuthContextOrThrow: () => ({ userId: 'user', machineId: 'machine' }),
  resolveWorkspaceOrThrow: async () => ({ id: 'workspace' }),
  withWorkspaceManager: async (
    _auth: unknown,
    _workspace: unknown,
    _name: string,
    read: (manager: object) => Promise<void>
  ) => read({}),
  runOneShotCommand: async (_name: string, _options: unknown, read: () => Promise<void>) => read(),
  printJson: (output: unknown) => {
    state.output = output;
  },
}));
afterEach(() => {
  state.output = undefined;
  state.discovery = undefined;
  state.platform = 'cloud';
  state.handlers.clear();
  state.proposed = [];
  vi.unstubAllEnvs();
});

function fixture(): ResourceDiscovery {
  const source: DiscoverySource = {
    workspaceId: 'workspace',
    userId: 'user',
    machines: async () => [{ id: 'machine', name: 'Workstation' } as MachineMeta],
    canAccess: async () => true,
    onlineMachineIds: async () => new Set(['machine'] as MachineId[]),
    configs: async () => [],
    capabilities: async () => ({}),
    projects: async () => [],
    repositories: async () => [],
    mcpServers: async () => [],
    roles: async () =>
      Array.from(
        { length: 25 },
        (_, n) =>
          ({
            v: 1,
            id: `role-${n}`,
            name: `Role ${n}`,
            machineId: 'machine',
            agentConfigId: 'missing',
            visibility: 'workspace',
            ownerUserId: 'user',
            revision: 1,
            runConfig: {},
            createdAt: 1,
            updatedAt: 1,
          }) as AgentRole
      ),
  };
  return new ResourceDiscovery(source);
}

describe('CLI discovery boundary', () => {
  it('uses the shared Role query, machine name resolution and all-pages traversal', async () => {
    state.discovery = fixture();
    await discoveryListCommand('agent_role').parseAsync(
      ['--json', '--machine', 'Workstation', '--all-pages', '--limit', '10'],
      { from: 'user' }
    );
    expect(state.output).toMatchObject({ ok: true, hasMore: false, workspaceId: 'workspace' });
    const output = state.output as { items: Array<{ id: string; availability: unknown }> };
    expect(output.items).toHaveLength(25);
    expect(new Set(output.items.map((row) => row.id)).size).toBe(25);
    expect(output.items[0]?.availability).toEqual({
      state: 'unavailable',
      reason: 'agent_config_missing',
    });
  });

  it.each(['agent_config', 'agent_role', 'mcp'] as const)(
    'rejects unsupported local %s discovery before reading a cloud catalog',
    async (resource) => {
      state.platform = 'local';
      await expect(
        discoveryListCommand(resource).parseAsync(['--json'], { from: 'user' })
      ).rejects.toThrow('unavailable on the local platform');
      expect(state.output).toBeUndefined();
    }
  );
});

describe('CLI Role proposal tools', () => {
  async function run(
    action: 'create' | 'update',
    draft: unknown,
    extra: string[] = [],
    platform = 'local'
  ) {
    state.platform = platform;
    const directory = await mkdtemp(join(tmpdir(), 'role-proposal-'));
    const file = join(directory, 'draft.json');
    const server = new McpServer({ name: 'test', version: '1' });
    registerAgentRoleTools(
      createSessionToolRegistrar(server, (_name, _args, execute) => execute(), state.handlers),
      async (command) => {
        state.proposed.push(command);
        return { pending: true, roleId: 'role' };
      }
    );
    try {
      if (draft !== undefined) await writeFile(file, JSON.stringify(draft));
      await agentRoleWriteCommand(action).parseAsync(
        [
          ...(action === 'update' ? ['role'] : []),
          ...(draft === undefined ? [] : ['--file', file]),
          '--request-id',
          'request',
          '--session',
          'session',
          ...extra,
        ],
        { from: 'user' }
      );
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  it('routes creation through the MCP schema and reports a pending proposal', async () => {
    const draft = {
      name: 'Reviewer',
      machineId: 'machine',
      agentConfigId: 'agent',
      promptPrefix: 'Review carefully',
    };
    await run('create', draft);
    expect(state.proposed).toEqual([{ action: 'create', requestId: 'request', ...draft }]);
    expect(state.output).toEqual({ requestId: 'request', pending: true, roleId: 'role' });
  });
  it('routes cloud proposals through the same scoped daemon tool', async () => {
    await run('update', undefined, ['--description', 'Cloud update'], 'cloud');
    expect(state.proposed).toEqual([
      {
        action: 'update',
        requestId: 'request',
        roleId: 'role',
        patch: { description: 'Cloud update' },
      },
    ]);
    expect(state.output).toMatchObject({ pending: true, roleId: 'role' });
  });
  it('retains explicit clearing in updates without adding omitted fields', async () => {
    await run('update', { promptPrefix: '' });
    expect(state.proposed).toEqual([
      { action: 'update', requestId: 'request', roleId: 'role', patch: { promptPrefix: '' } },
    ]);
    expect(state.output).toMatchObject({ pending: true });
  });
  it('rejects unsupported fields before publishing', async () => {
    await expect(
      run('update', { name: 'Name', runConfig: { modelId: 'other' } })
    ).rejects.toThrow();
    expect(state.proposed).toEqual([]);
    expect(state.output).toBeUndefined();
  });
  it('rejects mixed file and direct fields before publishing', async () => {
    await expect(run('update', { name: 'Reviewer' }, ['--description', ''])).rejects.toThrow(
      'Use either --file or direct Role field options'
    );
    expect(state.proposed).toEqual([]);
  });
  it('rejects missing create bindings and empty updates before publishing', async () => {
    await expect(run('create', undefined, ['--name', 'Reviewer'])).rejects.toThrow();
    await expect(run('update', undefined)).rejects.toThrow();
    expect(state.proposed).toEqual([]);
  });
  it('surfaces daemon scope rejection without reporting success', async () => {
    await expect(run('update', { name: 'Name' }, ['--session', 'wrong'])).rejects.toThrow(
      'scope mismatch'
    );
    expect(state.proposed).toEqual([]);
    expect(state.output).toBeUndefined();
  });
});
