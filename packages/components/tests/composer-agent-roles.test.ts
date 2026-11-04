import { describe, expect, it } from 'vitest';
import {
  AGENT_ROLE_VERSION,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleAvailability,
  type AgentRoleId,
  type MachineId,
} from '@lody/shared';

import {
  buildComposerAgentRoleItems,
  isComposerAgentRoleApplied,
  resolveTurnAgentRoleForRunConfig,
} from '../src/lib/composer-agent-roles';

const makeRole = (overrides: Partial<AgentRole> & Pick<AgentRole, 'id' | 'name'>): AgentRole => ({
  v: AGENT_ROLE_VERSION,
  ownerUserId: 'user-1',
  visibility: 'private',
  machineId: 'machine-1' as MachineId,
  agentConfigId: 'config-1' as AgentConfigId,
  runConfig: {},
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const makeConfig = (id: string, machineId: string, agentType = 'codex'): AgentConfigMeta =>
  ({
    id: id as AgentConfigId,
    machineId: machineId as MachineId,
    name: id,
    cliType: 'builtin',
    agentType,
    env: {},
  }) as AgentConfigMeta;

const available: AgentRoleAvailability = { kind: 'available' };

describe('buildComposerAgentRoleItems', () => {
  const reviewer = makeRole({ id: 'r-2' as AgentRoleId, name: 'Reviewer' });
  const architect = makeRole({ id: 'r-1' as AgentRoleId, name: 'Architect' });
  const elsewhere = makeRole({
    id: 'r-3' as AgentRoleId,
    name: 'Elsewhere',
    machineId: 'machine-2' as MachineId,
  });
  const writer = makeRole({
    id: 'r-4' as AgentRoleId,
    name: 'Writer',
    agentConfigId: 'config-2' as AgentConfigId,
  });
  const configs = [
    makeConfig('config-1', 'machine-1'),
    makeConfig('config-2', 'machine-1', 'claude'),
  ];

  it('offers every Agent type bound to the machine the chat starts on', () => {
    const items = buildComposerAgentRoleItems({
      roles: [reviewer, architect, elsewhere, writer],
      machineId: 'machine-1' as MachineId,
      agentConfigs: configs,
      resolveAvailability: () => available,
    });
    expect(items.map((item) => item.role.id)).toEqual(['r-1', 'r-2', 'r-4']);
    expect(items.at(-1)?.agentConfig?.agentType).toBe('claude');
  });

  it("offers a multi-machine Role with this machine's own agent and run config", () => {
    const both = makeRole({
      id: 'r-5' as AgentRoleId,
      name: 'Both',
      machineId: 'machine-2' as MachineId,
      runConfig: { modelId: 'remote-model' },
      additionalTargets: [
        {
          machineId: 'machine-1' as MachineId,
          agentConfigId: 'config-2' as AgentConfigId,
          runConfig: { modelId: 'local-model' },
        },
      ],
    });
    const [item] = buildComposerAgentRoleItems({
      roles: [both],
      machineId: 'machine-1' as MachineId,
      agentConfigs: configs,
      resolveAvailability: () => available,
    });
    expect(item?.role).toMatchObject({
      id: 'r-5',
      machineId: 'machine-1',
      agentConfigId: 'config-2',
      runConfig: { modelId: 'local-model' },
    });
    expect(item?.agentConfig?.agentType).toBe('claude');
  });
});

describe('isComposerAgentRoleApplied', () => {
  const role = makeRole({
    id: 'r-1' as AgentRoleId,
    name: 'Reviewer',
    runConfig: {
      modelId: 'gpt-5.6-sol',
      modeId: 'plan',
      configOptionValues: { thought_level: 'high' },
    },
  });
  const matching = {
    agentSelection: { agentId: 'config-1' as AgentConfigId, machineId: 'machine-1' as MachineId },
    modelId: 'gpt-5.6-sol',
    modeId: 'plan',
    configOptionValues: { thought_level: 'high' },
  };

  it('ignores options the Role does not pin', () => {
    expect(
      isComposerAgentRoleApplied(role, {
        ...matching,
        configOptionValues: { thought_level: 'high', fast_mode: true },
      })
    ).toBe(true);
  });

  it('stops holding when a pinned option falls back to the agent value', () => {
    expect(
      isComposerAgentRoleApplied(role, {
        ...matching,
        configOptionValues: { thought_level: 'low' },
      })
    ).toBe(false);
  });

  it('never holds for another agent config or machine', () => {
    expect(
      isComposerAgentRoleApplied(role, {
        ...matching,
        agentSelection: {
          agentId: 'config-2' as AgentConfigId,
          machineId: 'machine-1' as MachineId,
        },
      })
    ).toBe(false);
    expect(
      isComposerAgentRoleApplied(role, {
        ...matching,
        agentSelection: {
          agentId: 'config-1' as AgentConfigId,
          machineId: 'machine-2' as MachineId,
        },
      })
    ).toBe(false);
    expect(isComposerAgentRoleApplied(role, { ...matching, agentSelection: null })).toBe(false);
  });
});

describe('resolveTurnAgentRoleForRunConfig', () => {
  const role = makeRole({
    id: 'r-1' as AgentRoleId,
    name: 'Planner',
    runConfig: { modeId: 'plan', configOptionValues: { collaboration_mode: 'plan' } },
  });
  const turnSelection = { agentRoleId: role.id, agentRoleRevision: role.revision };
  const current = {
    modeId: 'plan',
    modelId: null,
    configOptionValues: { collaboration_mode: 'plan' },
  };

  it.each([
    ['plan_mode', true, false],
    ['collaboration_mode', 'plan', 'default'],
  ] as const)(
    'preserves Role metadata when execute-plan overrides %s',
    (configId, before, after) => {
      const planningRole = {
        ...role,
        runConfig: { configOptionValues: { [configId]: before, permission_mode: 'ask' } },
      };
      const config = {
        ...current,
        modeId: null,
        configOptionValues: { [configId]: before, permission_mode: 'ask' },
      };
      expect(
        resolveTurnAgentRoleForRunConfig({
          turnSelection,
          role: planningRole,
          current: config,
          overrides: { configOptionValuesOverride: { [configId]: after, permission_mode: 'ask' } },
        })
      ).toEqual(turnSelection);
      expect(
        resolveTurnAgentRoleForRunConfig({
          turnSelection,
          role: planningRole,
          current: config,
          overrides: { configOptionValuesOverride: { [configId]: after, permission_mode: 'yolo' } },
        })
      ).toBeNull();
    }
  );

  it('freezes explicit None when execute-plan overrides a pinned Role value', () => {
    expect(
      resolveTurnAgentRoleForRunConfig({
        turnSelection,
        role,
        current,
        overrides: {
          modeIdOverride: 'default',
          configOptionValuesOverride: { collaboration_mode: 'default' },
        },
      })
    ).toBeNull();
  });
});
