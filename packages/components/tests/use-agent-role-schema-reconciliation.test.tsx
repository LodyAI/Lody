// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Flock } from '@loro-dev/flock-wasm';
import {
  ACP_CAPABILITY_CACHE_VERSION,
  AGENT_ROLE_VERSION,
  workspaceFlockKeys,
  type AgentRole,
} from '@lody/shared';
import { createDirectWorkspaceWriter } from '../src/providers/workspace-writer-impl';

const state = vi.hoisted(() => ({
  atoms: new Map<string, unknown>(),
  roles: [] as AgentRole[],
  synced: false,
  machines: new Map(),
}));
vi.mock('jotai', () => ({ useAtomValue: (key: string) => state.atoms.get(key) }));
vi.mock('@/atoms', () => ({ userAtom: 'user' }));
vi.mock('@/atoms/agents', () => ({ getAllAgentConfigAtom: 'configs' }));
vi.mock('@/atoms/presence', () => ({ onlineMachineIdsAtom: 'online' }));
vi.mock('@/atoms/runtime', () => ({ activeWorkspaceRuntimeAtom: 'runtime' }));
vi.mock('@/hooks/use-workspace-agent-roles', () => ({
  useWorkspaceAgentRoles: () => ({ roles: state.roles, synced: state.synced }),
}));
vi.mock('@/hooks/use-machine-flock-agent-configs', () => ({
  useMachineFlockAgentConfigsForMachineIds: () => {},
}));
vi.mock('@/hooks/use-visible-machine-metas', () => ({
  useVisibleMachineMetas: () => ({ machines: state.machines }),
}));
import { useAgentRoleSchemaReconciliation } from '../src/hooks/use-agent-role-schema-reconciliation';

function Startup() {
  useAgentRoleSchemaReconciliation();
  return null;
}

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
});

describe('role maintenance at workspace startup', () => {
  it.each([
    'success',
    'failed-probe',
    'wrong-target',
    'wrong-config',
    'wrong-provider',
    'wrong-agent',
    'old-cache',
    'newer-cache',
    'provisional',
    'missing-schema',
    'sign-out',
    'workspace-disposed',
  ])(
    'waits for readiness and silently persists only a matching fresh schema: %s',
    async (scenario) => {
      const flock = new Flock('startup-role');
      const role: AgentRole = {
        v: AGENT_ROLE_VERSION,
        id: 'role' as never,
        machineId: 'machine' as never,
        agentConfigId: 'config' as never,
        ownerUserId: 'owner',
        visibility: 'private',
        name: 'Reviewer',
        runConfig: { configOptionValues: { collaboration_mode: 'plan', interaction_mode: 'code' } },
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      };
      const key = workspaceFlockKeys.agentRole(role.id);
      flock.set(key, role as never);
      flock.commit();
      const repo = { openFlockDoc: async () => ({ flock, syncOnce: async () => {} }) };
      let resolveProbe!: (value: unknown) => void;
      const probe = new Promise((resolve) => {
        resolveProbe = resolve;
      });
      const runtime = {
        workspaceId: 'workspace',
        repo,
        writer: createDirectWorkspaceWriter({ repo } as never),
        requestMachineAcpCapabilitiesRefresh: () => probe,
      };
      state.roles = [role];
      state.synced = false;
      state.machines = new Map([['machine', { id: 'machine' }]]);
      state.atoms = new Map<string, unknown>([
        ['runtime', runtime],
        ['user', { id: 'owner' }],
        ['online', new Set()],
        [
          'configs',
          [{ id: 'config', machineId: 'machine', cliType: 'builtin', agentType: 'codex' }],
        ],
      ]);
      const root = createRoot(document.createElement('div'));
      roots.push(root);
      await act(async () => root.render(<Startup />));
      expect(flock.get(key)).toEqual(role);
      state.synced = true;
      await act(async () => root.render(<Startup />));
      expect(flock.get(key)).toEqual(role);
      state.atoms.set('online', new Set(['machine']));
      await act(async () => root.render(<Startup />));
      expect(flock.get(key)).toEqual(role);
      if (scenario === 'sign-out') state.atoms.set('user', null);
      if (scenario === 'workspace-disposed') state.atoms.set('runtime', null);
      if (scenario === 'sign-out' || scenario === 'workspace-disposed') {
        await act(async () => root.render(<Startup />));
      }
      await act(async () =>
        resolveProbe({
          success: scenario !== 'failed-probe',
          machineId: scenario === 'wrong-target' ? 'other' : 'machine',
          configId: scenario === 'wrong-config' ? 'other' : 'config',
          cliType: 'builtin',
          agentType: 'codex',
          capability: {
            cliType: scenario === 'wrong-provider' ? 'custom' : 'builtin',
            agentType: scenario === 'wrong-agent' ? 'claude' : 'codex',
            provenance: scenario === 'provisional' ? undefined : 'runtime',
            cacheVersion:
              scenario === 'old-cache'
                ? 1
                : ACP_CAPABILITY_CACHE_VERSION + (scenario === 'newer-cache' ? 1 : 0),
            fetchedAt: 2,
            modes: [],
            models: [],
            configOptions:
              scenario === 'missing-schema'
                ? undefined
                : [{ id: 'plan_mode', name: 'Plan', type: 'boolean', currentValue: false }],
          },
        })
      );
      if (scenario === 'success') {
        expect(flock.get(key)).toMatchObject({
          runConfig: { configOptionValues: { plan_mode: true } },
          revision: 2,
        });
        state.roles = [flock.get(key) as AgentRole];
        await act(async () => root.render(<Startup />));
        expect(flock.get(key)).toMatchObject({ revision: 2 });
      } else expect(flock.get(key)).toEqual(role);
    }
  );
});
