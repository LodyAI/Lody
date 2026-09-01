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

import type { ComposerAgentRoleItem } from '../src/lib/composer-agent-roles';
import {
  buildComposerAgentRoleItems,
  doesAgentRolePinPermissionMode,
  isComposerAgentRoleApplied,
  resolvePendingAgentRoleSelection,
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

  it('offers nothing until a machine is selected', () => {
    expect(
      buildComposerAgentRoleItems({
        roles: [reviewer],
        machineId: null,
        agentConfigs: configs,
        resolveAvailability: () => available,
      })
    ).toEqual([]);
  });

  it('keeps an unavailable Role listed with its reason instead of hiding it', () => {
    const items = buildComposerAgentRoleItems({
      roles: [reviewer],
      machineId: 'machine-1' as MachineId,
      agentConfigs: configs,
      resolveAvailability: () => ({ kind: 'unavailable', reason: 'machine_offline' }),
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.availability).toEqual({ kind: 'unavailable', reason: 'machine_offline' });
  });

  it('reports a missing agent config rather than substituting another', () => {
    const items = buildComposerAgentRoleItems({
      roles: [
        makeRole({
          id: 'r-4' as AgentRoleId,
          name: 'Gone',
          agentConfigId: 'config-9' as AgentConfigId,
        }),
      ],
      machineId: 'machine-1' as MachineId,
      agentConfigs: configs,
      resolveAvailability: () => ({ kind: 'unavailable', reason: 'agent_config_missing' }),
    });
    expect(items[0]?.agentConfig).toBeUndefined();
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

  it('holds while every pinned value is what will run', () => {
    expect(isComposerAgentRoleApplied(role, matching)).toBe(true);
  });

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

  it('stops holding when the model or mode is changed by hand', () => {
    expect(isComposerAgentRoleApplied(role, { ...matching, modelId: 'gpt-5.6-thor' })).toBe(false);
    expect(isComposerAgentRoleApplied(role, { ...matching, modeId: 'default' })).toBe(false);
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

describe('doesAgentRolePinPermissionMode', () => {
  const pinning = makeRole({
    id: 'r-1' as AgentRoleId,
    name: 'Reviewer',
    runConfig: { modeId: 'read-only', configOptionValues: { permission_mode: 'ask' } },
  });
  const bare = makeRole({ id: 'r-2' as AgentRoleId, name: 'Bare' });

  it('holds for a legacy ACP mode the Role stored', () => {
    expect(doesAgentRolePinPermissionMode(pinning, { kind: 'modeId' })).toBe(true);
    expect(doesAgentRolePinPermissionMode(bare, { kind: 'modeId' })).toBe(false);
  });

  it('holds for the agent own permission option when the Role stored it', () => {
    const source = { kind: 'configOption', configId: 'permission_mode' } as const;
    expect(doesAgentRolePinPermissionMode(pinning, source)).toBe(true);
    expect(doesAgentRolePinPermissionMode(bare, source)).toBe(false);
  });

  // An agent that publishes no permission control leaves a Role nothing to own,
  // so the composer must keep its own permission button rather than hide a knob
  // the Role never had.
  it('never holds when the agent exposes no permission control', () => {
    expect(doesAgentRolePinPermissionMode(pinning, null)).toBe(false);
  });
});

describe('resolvePendingAgentRoleSelection', () => {
  const roleId = 'r-1' as AgentRoleId;
  const item = (availability: AgentRoleAvailability): ComposerAgentRoleItem => ({
    role: makeRole({ id: roleId, name: 'Reviewer' }),
    availability,
  });

  // A create resolves on the durable local write; the catalog snapshot the
  // composer reads from arrives on its own tick.
  it('waits while the Role has not reached the composer yet', () => {
    expect(resolvePendingAgentRoleSelection({ roleId, items: [], isInCatalog: false })).toBe(
      'wait'
    );
  });

  it('waits while the binding cannot be judged', () => {
    expect(
      resolvePendingAgentRoleSelection({
        roleId,
        items: [item({ kind: 'unknown' })],
        isInCatalog: true,
      })
    ).toBe('wait');
  });

  it('selects the Role once the composer can offer it', () => {
    expect(
      resolvePendingAgentRoleSelection({
        roleId,
        items: [item({ kind: 'available' })],
        isInCatalog: true,
      })
    ).toBe('select');
  });

  // The editor lets a Role be bound to any machine; following one onto another
  // machine would move the chat off the one it is starting on.
  it('gives up on a Role the catalog knows but this machine does not offer', () => {
    expect(resolvePendingAgentRoleSelection({ roleId, items: [], isInCatalog: true })).toBe(
      'give-up'
    );
  });

  it('gives up rather than waiting on a Role that cannot run', () => {
    expect(
      resolvePendingAgentRoleSelection({
        roleId,
        items: [item({ kind: 'unavailable', reason: 'machine_offline' })],
        isInCatalog: true,
      })
    ).toBe('give-up');
  });
});
