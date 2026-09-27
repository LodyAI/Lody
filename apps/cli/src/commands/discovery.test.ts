import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRole, MachineId, MachineMeta } from '@lody/shared';
import { ResourceDiscovery, type DiscoverySource } from '@/lib/resource-discovery';
import { discoveryListCommand, discoveryGetCommand } from './discovery';

const state = vi.hoisted(() => ({
  output: undefined as unknown,
  discovery: undefined as ResourceDiscovery | undefined,
  platform: 'cloud',
}));
vi.mock('@/lib/resource-discovery-runtime', () => ({
  createResourceDiscovery: async () => state.discovery,
}));
vi.mock('@/lib/cli-platform', () => ({ getCliPlatformKind: () => state.platform }));
vi.mock('@/lib/command-runtime', () => ({
  getAuthContextOrThrow: () => ({ userId: 'user' }),
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

  it('returns the same detail as MCP and rejects malformed page size', async () => {
    const discovery = fixture();
    state.discovery = discovery;
    await discoveryGetCommand('agent_role').parseAsync(['role-1', '--json'], { from: 'user' });
    expect(state.output).toEqual(await discovery.get('agent_role', 'role-1'));
    await expect(
      discoveryListCommand('agent_role').parseAsync(['--limit', 'NaN'], { from: 'user' })
    ).rejects.toThrow();
  });

  it('rejects unsupported local workspace discovery before reading a cloud catalog', async () => {
    state.platform = 'local';
    await expect(
      discoveryListCommand('machine').parseAsync(['--json'], { from: 'user' })
    ).rejects.toThrow('unavailable on the local platform');
    expect(state.output).toBeUndefined();
  });
});
