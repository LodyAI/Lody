// Coverage for the Role offer inside an EXISTING session: which Roles it may
// reuse, and what "still applied" means when the session's agent is fixed.

import { describe, expect, it } from 'vitest';
import {
  AGENT_ROLE_VERSION,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleId,
  type MachineId,
} from '@lody/shared';

import {
  isAgentRoleRunConfigApplied,
  isComposerAgentRoleApplied,
  resolveProgrammaticTurnAgentRole,
  selectSessionAgentRoles,
} from '../src/lib/composer-agent-roles';

const config = (id: string, agentType: string, machineId = 'machine-1'): AgentConfigMeta =>
  ({
    id: id as AgentConfigId,
    machineId: machineId as MachineId,
    name: id,
    cliType: 'builtin',
    agentType,
    env: {},
  }) as AgentConfigMeta;

const makeRole = (
  overrides: Partial<AgentRole> & Pick<AgentRole, 'id' | 'name' | 'agentConfigId'>
): AgentRole => ({
  v: AGENT_ROLE_VERSION,
  ownerUserId: 'user-1',
  visibility: 'private',
  machineId: 'machine-1' as MachineId,
  runConfig: {},
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

describe('selectSessionAgentRoles', () => {
  const codexHere = makeRole({
    id: 'r-codex' as AgentRoleId,
    name: 'Reviewer',
    agentConfigId: 'codex-1' as AgentConfigId,
  });
  // Same provider type, but a different machine/config binding.
  const codexElsewhere = makeRole({
    id: 'r-codex-2' as AgentRoleId,
    name: 'Auditor',
    agentConfigId: 'codex-2' as AgentConfigId,
    machineId: 'machine-2' as MachineId,
  });
  const claude = makeRole({
    id: 'r-claude' as AgentRoleId,
    name: 'Docs',
    agentConfigId: 'claude-1' as AgentConfigId,
  });
  const agentConfigs = [
    config('codex-1', 'codex'),
    config('codex-2', 'codex', 'machine-2'),
    config('claude-1', 'claude'),
  ];
  const resolveAvailability = () => ({ kind: 'available' as const });

  it('offers only Roles bound to the existing Session machine and provider', () => {
    const items = selectSessionAgentRoles({
      roles: [codexHere, codexElsewhere, claude],
      machineId: 'machine-1' as MachineId,
      agentConfigId: 'codex-1' as AgentConfigId,
      agentConfigs,
      resolveAvailability,
    });
    expect(items.map((item) => item.role.id)).toEqual(['r-codex']);
  });

  it('drops a Role bound to another provider on the same machine', () => {
    const items = selectSessionAgentRoles({
      roles: [claude],
      machineId: 'machine-1' as MachineId,
      agentConfigId: 'codex-1' as AgentConfigId,
      agentConfigs,
      resolveAvailability,
    });
    expect(items).toEqual([]);
  });

  it('keeps an exact-binding Role visible when its config is gone', () => {
    const orphan = makeRole({
      id: 'r-orphan' as AgentRoleId,
      name: 'Orphan',
      agentConfigId: 'deleted' as AgentConfigId,
    });
    const items = selectSessionAgentRoles({
      roles: [orphan],
      machineId: 'machine-1' as MachineId,
      agentConfigId: 'deleted' as AgentConfigId,
      agentConfigs,
      resolveAvailability: () => ({ kind: 'unavailable', reason: 'agent_config_missing' }),
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.role).toBe(orphan);
    expect(items[0]?.agentConfig).toBeUndefined();
    expect(items[0]?.availability).toEqual({
      kind: 'unavailable',
      reason: 'agent_config_missing',
    });
  });

  it('offers nothing until the session reports its exact provider binding', () => {
    expect(
      selectSessionAgentRoles({
        roles: [codexHere],
        machineId: 'machine-1' as MachineId,
        agentConfigId: null,
        agentConfigs,
        resolveAvailability,
      })
    ).toEqual([]);
  });

  it('preserves resolved availability so a stale Role cannot be selected', () => {
    const items = selectSessionAgentRoles({
      roles: [codexHere],
      machineId: 'machine-1' as MachineId,
      agentConfigId: 'codex-1' as AgentConfigId,
      agentConfigs,
      resolveAvailability: () => ({ kind: 'unavailable', reason: 'machine_offline' }),
    });
    expect(items[0]?.availability).toEqual({
      kind: 'unavailable',
      reason: 'machine_offline',
    });
  });
});

describe('resolveProgrammaticTurnAgentRole', () => {
  const durableRoleId = 'role-durable' as AgentRoleId;
  const composerRoleId = 'role-composer' as AgentRoleId;

  it('inherits the committed composer selection before the older durable Turn', () => {
    expect(
      resolveProgrammaticTurnAgentRole({
        composer: { agentRoleId: composerRoleId, agentRoleRevision: 3 },
        durableRoleId,
        durableRoleRevision: 2,
      })
    ).toEqual({ agentRoleId: composerRoleId, agentRoleRevision: 3 });
  });

  it('preserves explicit None and falls back to durable metadata when the composer is absent', () => {
    expect(
      resolveProgrammaticTurnAgentRole({
        requested: null,
        composer: { agentRoleId: composerRoleId, agentRoleRevision: 3 },
        durableRoleId,
        durableRoleRevision: 2,
      })
    ).toBeNull();
    expect(resolveProgrammaticTurnAgentRole({ durableRoleId, durableRoleRevision: 2 })).toEqual({
      agentRoleId: durableRoleId,
      agentRoleRevision: 2,
    });
  });
});

describe('isAgentRoleRunConfigApplied', () => {
  const role = makeRole({
    id: 'r-1' as AgentRoleId,
    name: 'Reviewer',
    agentConfigId: 'codex-1' as AgentConfigId,
    runConfig: { modelId: 'gpt-5.5', modeId: 'plan', configOptionValues: { effort: 'high' } },
  });
  const applied = {
    modeId: 'plan',
    modelId: 'gpt-5.5',
    configOptionValues: { effort: 'high' },
  };

  it('holds on the values alone, whatever agent is running', () => {
    expect(isAgentRoleRunConfigApplied(role, applied)).toBe(true);
  });

  it('stops holding when a pinned value is changed by hand', () => {
    expect(isAgentRoleRunConfigApplied(role, { ...applied, modelId: 'gpt-5.5-mini' })).toBe(false);
    expect(
      isAgentRoleRunConfigApplied(role, { ...applied, configOptionValues: { effort: 'low' } })
    ).toBe(false);
  });

  // The landing still authorizes the WHOLE Role, so it keeps the agent check on
  // top of the same value rule.
  it('is the value half of the new-chat rule, which also binds the agent', () => {
    const selection = {
      ...applied,
      agentSelection: { agentId: 'codex-2' as AgentConfigId, machineId: 'machine-1' as MachineId },
    };
    expect(isAgentRoleRunConfigApplied(role, selection)).toBe(true);
    expect(isComposerAgentRoleApplied(role, selection)).toBe(false);
  });
});
