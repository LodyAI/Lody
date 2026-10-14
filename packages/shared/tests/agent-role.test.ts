import { describe, expect, it } from 'vitest';

import {
  AGENT_ROLE_VERSION,
  bindAgentRoleTarget,
  canManageAgentRole,
  formatAgentRoleMentionValue,
  getAgentRoleTargets,
  resolveAgentRoleMentionValue,
  canReadAgentRole,
  isAgentRoleContentEqual,
  isSensitiveAgentRoleConfigOptionKey,
  DEFAULT_AGENT_ROLE_EMOJI,
  getAgentRoleEmoji,
  getAgentRoleMentionSlug,
  listAccessibleAgentRoles,
  normalizeAgentRole,
  normalizeAgentRoleEmoji,
  normalizeAgentRoleMentionSlug,
  normalizeAgentRoleRunConfig,
  resolveAgentRoleAvailability,
  type AgentRole,
  type AgentRoleAvailabilityContext,
} from '../src/agent-role';
import type { AgentConfigId, AgentRoleId, MachineId } from '../src/ids';

const role = (overrides: Partial<AgentRole> = {}): AgentRole => ({
  v: AGENT_ROLE_VERSION,
  id: 'role-1' as AgentRoleId,
  ownerUserId: 'user-1',
  visibility: 'private',
  name: 'Reviewer',
  machineId: 'machine-1' as MachineId,
  agentConfigId: 'config-1' as AgentConfigId,
  runConfig: { modelId: 'gpt-5.6' },
  revision: 1,
  createdAt: 10,
  updatedAt: 10,
  ...overrides,
});

const context = (
  overrides: Partial<AgentRoleAvailabilityContext> = {}
): AgentRoleAvailabilityContext => ({
  authorizedMachineIds: new Set(['machine-1' as MachineId]),
  onlineMachineIds: new Set(['machine-1' as MachineId]),
  agentConfigMachineIds: new Map([['config-1' as AgentConfigId, 'machine-1' as MachineId]]),
  loadedAgentConfigMachineIds: new Set(['machine-1' as MachineId]),
  ...overrides,
});

describe('agent role description', () => {
  it('reads legacy roles as blank and bounds descriptions by Unicode code point', () => {
    expect(normalizeAgentRole(role())?.description ?? '').toBe('');
    for (const character of ['a', '中', '😀']) {
      const description = character.repeat(140);
      expect(normalizeAgentRole(role({ description }))?.description).toBe(description);
      expect(normalizeAgentRole(role({ description: description + character }))?.description).toBe(
        description
      );
    }
    expect(normalizeAgentRole({ ...role(), description: 42 })).toBeUndefined();
  });

  it('treats missing and blank as equal but detects description edits', () => {
    expect(isAgentRoleContentEqual(role(), role({ description: '' }))).toBe(true);
    expect(isAgentRoleContentEqual(role(), role({ description: 'Review changes' }))).toBe(false);
  });
});

describe('agent role mention slug', () => {
  it('keeps non-ASCII text but removes what an `@` token cannot carry', () => {
    expect(normalizeAgentRoleMentionSlug('  @Code Reviewer  ')).toBe('Code-Reviewer');
    expect(normalizeAgentRoleMentionSlug('代码 审阅')).toBe('代码-审阅');
    // A control character is invisible in the composer but still part of the
    // token, so a slug carrying one could never be typed back.
    expect(normalizeAgentRoleMentionSlug('a\u0007b')).toBe('ab');
    expect(normalizeAgentRoleMentionSlug('--x--')).toBe('x');
  });

  it('caps the slug by code point, not code unit', () => {
    const slug = normalizeAgentRoleMentionSlug('😀'.repeat(60));
    expect(Array.from(slug)).toHaveLength(40);
  });

  it('derives the mention token from the one authored name', () => {
    expect(getAgentRoleMentionSlug({ name: 'Code Reviewer' })).toBe('Code-Reviewer');
    // Renaming the Role renames its mention; the range still carries the id.
    expect(getAgentRoleMentionSlug({ name: 'Deep Reviewer' })).toBe('Deep-Reviewer');
  });
});

describe('agent role emoji', () => {
  it('keeps one short glyph and drops what would smuggle in a second line', () => {
    expect(normalizeAgentRoleEmoji('🔍')).toBe('🔍');
    expect(normalizeAgentRoleEmoji('  🧑\u200d💻  ')).toBe('🧑\u200d💻');
    expect(normalizeAgentRoleEmoji('a b')).toBe('ab');
    expect(normalizeAgentRoleEmoji('😀'.repeat(20))).toBe('😀'.repeat(8));
    expect(normalizeAgentRoleEmoji('   ')).toBeUndefined();
    expect(normalizeAgentRoleEmoji(42)).toBeUndefined();
  });

  it('falls back to one shared default so every Role reads the same', () => {
    expect(getAgentRoleEmoji({ emoji: '🔍' })).toBe('🔍');
    expect(getAgentRoleEmoji({})).toBe(DEFAULT_AGENT_ROLE_EMOJI);
    expect(getAgentRoleEmoji({ emoji: '' })).toBe(DEFAULT_AGENT_ROLE_EMOJI);
  });
});

describe('agent role run config', () => {
  it('refuses secret-shaped option keys on write and on read', () => {
    expect(isSensitiveAgentRoleConfigOptionKey('api_key')).toBe(true);
    expect(isSensitiveAgentRoleConfigOptionKey('bearer')).toBe(true);
    expect(isSensitiveAgentRoleConfigOptionKey('thought_level')).toBe(false);

    expect(
      normalizeAgentRoleRunConfig({
        modelId: 'gpt-5.6',
        configOptionValues: {
          thought_level: 'high',
          fast: true,
          openai_api_key: 'sk-live-value',
          nested: { leaked: true },
        },
      })
    ).toEqual({
      modelId: 'gpt-5.6',
      configOptionValues: { thought_level: 'high', fast: true },
    });
  });

  it('omits an empty option map rather than persisting one', () => {
    expect(normalizeAgentRoleRunConfig({ configOptionValues: {} })).toEqual({});
    expect(normalizeAgentRoleRunConfig(null)).toEqual({});
  });
});

describe('agent role rows', () => {
  it('normalizes a stored row and drops malformed ones', () => {
    const stored = {
      ...role({ name: '  Reviewer  ', emoji: ' 🔍 ', promptPrefix: '  Be strict.  ' }),
      runConfig: { modelId: 'gpt-5.6', configOptionValues: { auth_token: 'x' } },
    };
    expect(normalizeAgentRole(stored)).toEqual(
      role({
        name: 'Reviewer',
        emoji: '🔍',
        promptPrefix: 'Be strict.',
        runConfig: { modelId: 'gpt-5.6' },
      })
    );

    expect(normalizeAgentRole({ ...role(), v: 2 })).toBeUndefined();
    // A name with no mention token left is a Role that could never be used.
    expect(normalizeAgentRole({ ...role(), name: '---' })).toBeUndefined();
    expect(normalizeAgentRole({ ...role(), machineId: '  ' })).toBeUndefined();
    expect(normalizeAgentRole(null)).toBeUndefined();
  });

  it('treats option-key ordering as unchanged content', () => {
    const left = role({ runConfig: { configOptionValues: { a: '1', b: '2' } } });
    const right = role({ runConfig: { configOptionValues: { b: '2', a: '1' } } });
    expect(isAgentRoleContentEqual(left, right)).toBe(true);
    expect(isAgentRoleContentEqual(left, role({ ...left, promptPrefix: 'x' }))).toBe(false);
    expect(isAgentRoleContentEqual(left, role({ ...left, emoji: '🔍' }))).toBe(false);
  });
});

describe('agent role visibility', () => {
  const mine = role({ id: 'mine' as AgentRoleId, ownerUserId: 'user-1' });
  const theirsPrivate = role({ id: 'theirs' as AgentRoleId, ownerUserId: 'user-2' });
  const theirsShared = role({
    id: 'shared' as AgentRoleId,
    ownerUserId: 'user-2',
    visibility: 'workspace',
  });

  it('hides another member private role and exposes a shared one', () => {
    expect(canReadAgentRole(mine, 'user-1')).toBe(true);
    expect(canReadAgentRole(theirsPrivate, 'user-1')).toBe(false);
    expect(canReadAgentRole(theirsShared, 'user-1')).toBe(true);
    expect(listAccessibleAgentRoles([mine, theirsPrivate, theirsShared], 'user-1')).toEqual([
      mine,
      theirsShared,
    ]);
  });

  it('lets only the owner manage a shared role', () => {
    expect(canManageAgentRole(theirsShared, 'user-1')).toBe(false);
    expect(canManageAgentRole(theirsShared, 'user-2')).toBe(true);
    expect(canManageAgentRole(mine, null)).toBe(false);
  });
});

describe('agent role availability', () => {
  it('reports the precise reason instead of falling back', () => {
    expect(resolveAgentRoleAvailability(role(), context())).toEqual({ kind: 'available' });
    expect(
      resolveAgentRoleAvailability(role(), context({ authorizedMachineIds: new Set() }))
    ).toEqual({ kind: 'unavailable', reason: 'machine_unknown' });
    expect(resolveAgentRoleAvailability(role(), context({ onlineMachineIds: new Set() }))).toEqual({
      kind: 'unavailable',
      reason: 'machine_offline',
    });
    expect(
      resolveAgentRoleAvailability(role(), context({ agentConfigMachineIds: new Map() }))
    ).toEqual({ kind: 'unavailable', reason: 'agent_config_missing' });
    expect(
      resolveAgentRoleAvailability(
        role(),
        context({
          agentConfigMachineIds: new Map([['config-1' as AgentConfigId, 'machine-2' as MachineId]]),
        })
      )
    ).toEqual({ kind: 'unavailable', reason: 'agent_config_machine_mismatch' });
  });

  it('stays unknown while that machine configs are unread', () => {
    expect(
      resolveAgentRoleAvailability(role(), context({ loadedAgentConfigMachineIds: new Set() }))
    ).toEqual({ kind: 'unknown' });
  });
});

it('preserves memory references, revises identity changes, and gates older machines', () => {
  const binding = { providerId: 'nowledge-mem', memoryId: 'reviewer' };
  const configured = role({ runConfig: { memory: binding } });
  expect(normalizeAgentRole(configured)?.runConfig.memory).toEqual(binding);
  expect(
    isAgentRoleContentEqual(
      configured,
      role({ runConfig: { memory: { ...binding, memoryId: 'designer' } } })
    )
  ).toBe(false);
  expect(resolveAgentRoleAvailability(configured, context())).toEqual({
    kind: 'unavailable',
    reason: 'memory_unsupported',
  });
  expect(
    resolveAgentRoleAvailability(
      configured,
      context({ memoryProviderMachineIds: new Set([configured.machineId]) })
    )
  ).toEqual({ kind: 'available' });
  expect(
    normalizeAgentRole({ ...configured, runConfig: { memory: { providerId: 'nowledge-mem' } } })
  ).toBeUndefined();
});

describe('agent role machine targets', () => {
  const second = {
    machineId: 'machine-2' as MachineId,
    agentConfigId: 'config-2' as AgentConfigId,
    runConfig: { modelId: 'gpt-5.6-luna' },
    alias: 'Reviewer-Linux',
  };
  const multi = role({ alias: 'Reviewer-Mac', additionalTargets: [second] });

  it('reads a v2 row and keeps one target per machine, first one wins', () => {
    const stored = {
      ...role(),
      v: 2,
      machineId: undefined,
      targets: [
        { machineId: 'machine-1', agentConfigId: 'config-1', runConfig: { modelId: 'gpt-5.6' } },
        second,
        { machineId: 'machine-2', agentConfigId: 'config-9', runConfig: {} },
      ],
    };
    const read = normalizeAgentRole(stored);
    expect(read && getAgentRoleTargets(read).map((target) => target.agentConfigId)).toEqual([
      'config-1',
      'config-2',
    ]);
    // A v2 row with no usable target is not a Role.
    expect(normalizeAgentRole({ ...stored, targets: [] })).toBeUndefined();
    expect(normalizeAgentRole({ ...stored, targets: [{ machineId: 'm' }] })).toBeUndefined();
  });

  it('drops an alias once the role runs on a single machine', () => {
    expect(normalizeAgentRole(role({ alias: 'Solo' }))?.alias).toBeUndefined();
    expect(normalizeAgentRole(multi)?.alias).toBe('Reviewer-Mac');
  });

  it('binds another machine inline and keeps every other target', () => {
    const bound = bindAgentRoleTarget(multi, 'machine-2' as MachineId);
    expect(bound).toMatchObject({
      machineId: 'machine-2',
      agentConfigId: 'config-2',
      runConfig: { modelId: 'gpt-5.6-luna' },
      alias: 'Reviewer-Linux',
    });
    expect(bound?.additionalTargets?.map((target) => target.machineId)).toEqual(['machine-1']);
    expect(bindAgentRoleTarget(multi, 'machine-3' as MachineId)).toBeUndefined();
  });

  it('treats a change on any machine as an edit', () => {
    expect(
      isAgentRoleContentEqual(multi, role({ alias: 'Reviewer-Mac', additionalTargets: [second] }))
    ).toBe(true);
    expect(
      isAgentRoleContentEqual(
        multi,
        role({ alias: 'Reviewer-Mac', additionalTargets: [{ ...second, runConfig: {} }] })
      )
    ).toBe(false);
    expect(isAgentRoleContentEqual(multi, role({ alias: 'Reviewer-Mac' }))).toBe(false);
  });

  it('resolves a mention to one machine and never guesses for a bare id', () => {
    const roles = [multi, role({ id: 'role-2' as AgentRoleId, name: 'Solo' })];
    expect(resolveAgentRoleMentionValue(roles, 'role-2')?.machineId).toBe('machine-1');
    expect(resolveAgentRoleMentionValue(roles, 'role-1')).toBeUndefined();
    expect(
      resolveAgentRoleMentionValue(
        roles,
        formatAgentRoleMentionValue('role-1' as AgentRoleId, 'machine-2' as MachineId)
      )?.agentConfigId
    ).toBe('config-2');
    expect(resolveAgentRoleMentionValue(roles, 'role-1@machine-3')).toBeUndefined();
  });
});
