import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_ROLE_VERSION,
  snapshotAgentRole,
  workspaceFlockKeys,
  type AgentConfigId,
  type AgentRole,
  type AgentRoleId,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import type { CreateOptions } from '@/commands/session';
import {
  applyAgentRoleCreateTarget,
  composeAgentRolePrompt,
  resolveAgentRoleCreate,
  resolveAgentRoleCreateFromCatalog,
  selectAgentRoleTarget,
  selectUniqueAgentRoleByIdOrName,
} from './agent-role-create';
import { __lodyMcpServerInternals } from '../mcp/lody-mcp-server';

const { resolveMcpSessionCreate } = __lodyMcpServerInternals;

const agentRole = (overrides: Partial<AgentRole> = {}): AgentRole => ({
  v: AGENT_ROLE_VERSION,
  id: 'reviewer' as AgentRoleId,
  ownerUserId: 'user-1',
  visibility: 'private',
  name: 'Reviewer',
  machineId: 'remote-machine' as MachineId,
  agentConfigId: 'claude-opus' as AgentConfigId,
  runConfig: {},
  revision: 7,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const createRoleCatalogManager = (roles: AgentRole[]) => {
  const syncFlockDocOrThrow = vi.fn(async () => undefined);
  const openFlockDoc = vi.fn(async () => ({
    flock: {
      scan: ({ prefix }: { prefix?: readonly unknown[] } = {}) =>
        prefix?.[0] === 'agentRole'
          ? roles.map((role) => ({ key: workspaceFlockKeys.agentRole(role.id), value: role }))
          : [],
    },
  }));
  const manager = {
    syncFlockDocOrThrow,
    repo: { openFlockDoc },
  } as unknown as LoroDocumentManager;
  return { manager, syncFlockDocOrThrow };
};

describe('selectUniqueAgentRoleByIdOrName', () => {
  const roles = [agentRole(), agentRole({ id: 'implementer' as AgentRoleId, name: 'Implementer' })];

  it('resolves a fixed id before considering names', () => {
    expect(selectUniqueAgentRoleByIdOrName(roles, 'reviewer').id).toBe('reviewer');
    expect(
      selectUniqueAgentRoleByIdOrName(
        [agentRole({ id: 'Reviewer' as AgentRoleId, name: 'Other' }), ...roles],
        'Reviewer'
      ).id
    ).toBe('Reviewer');
  });

  it('resolves a unique name and reports ambiguity with candidates', () => {
    expect(selectUniqueAgentRoleByIdOrName(roles, 'Implementer').id).toBe('implementer');
    const duplicates = [
      agentRole({ id: 'reviewer-a' as AgentRoleId }),
      agentRole({ id: 'reviewer-b' as AgentRoleId }),
    ];
    expect(() => selectUniqueAgentRoleByIdOrName(duplicates, 'Reviewer')).toThrow(
      /Agent Role selector is ambiguous: Reviewer\. Use an id instead\. Candidates:/
    );
  });
});

describe('resolveAgentRoleCreate', () => {
  it('keeps the authored prompt, binds the Prompt prefix separately and freezes the Role run config', () => {
    const role = agentRole({
      runConfig: {
        modeId: 'default',
        modelId: 'opus',
        configOptionValues: { reasoning_effort: 'medium' },
      },
      promptPrefix: 'Act as a careful reviewer.',
    });

    const resolved = resolveAgentRoleCreate({ role, prompt: 'Review the current diff.' });

    expect(resolved.prompt).toBe('Review the current diff.');
    const options: CreateOptions = {};
    applyAgentRoleCreateTarget(options, resolved);
    expect(options.agentRolePromptPrefix).toBe('Act as a careful reviewer.');
    expect(resolved.dispatchConfig).toEqual({
      modeId: 'default',
      modelId: 'opus',
      configOptionValues: { reasoning_effort: 'medium' },
      inheritSessionDefaults: false,
    });
    expect(resolved.machineId).toBe('remote-machine');
    expect(resolved.agentConfigId).toBe('claude-opus');
    expect(composeAgentRolePrompt('  ', 'Review the current diff.')).toBe(
      'Review the current diff.'
    );
  });
});

describe('applyAgentRoleCreateTarget', () => {
  it('replaces manual create flags and freezes Role provenance', () => {
    const role = agentRole({ promptPrefix: 'Act as a careful reviewer.' });
    const resolved = resolveAgentRoleCreate({ role, prompt: 'Review this.' });
    const options: CreateOptions = {
      machine: 'manual-machine',
      agent: 'manual-agent',
      agentConfig: 'manual-config',
      mode: 'manual-mode',
      model: 'manual-model',
      configOption: ['unknown=unadvertised'],
    };

    applyAgentRoleCreateTarget(options, resolved);

    expect(options.machine).toBe('remote-machine');
    expect(options.agentConfig).toBe('claude-opus');
    expect(options.agent).toBeUndefined();
    expect(options.mode).toBeUndefined();
    expect(options.model).toBeUndefined();
    expect(options.configOption).toEqual([]);
    expect(options.agentRoleId).toBe('reviewer');
    expect(options.agentRoleRevision).toBe(7);
    expect(options.agentRoleSnapshot).toEqual(snapshotAgentRole(role));
  });

  it('keeps work-context flags untouched while replacing the target', () => {
    const resolved = resolveAgentRoleCreate({ role: agentRole(), prompt: 'Review this.' });
    const options: CreateOptions = {
      localProject: 'my-project',
      worktree: true,
      branch: 'feature/roles',
      machine: 'manual-machine',
      model: 'manual-model',
    };

    applyAgentRoleCreateTarget(options, resolved);

    expect(options.localProject).toBe('my-project');
    expect(options.worktree).toBe(true);
    expect(options.branch).toBe('feature/roles');
    expect(options.machine).toBe('remote-machine');
    expect(options.model).toBeUndefined();
  });
});

describe('a Role on several machines', () => {
  const both = agentRole({
    runConfig: { modelId: 'opus' },
    alias: 'Reviewer-Remote',
    additionalTargets: [
      {
        machineId: 'laptop' as MachineId,
        agentConfigId: 'codex' as AgentConfigId,
        runConfig: { modelId: 'gpt-5.6' },
        alias: 'Reviewer-Laptop',
      },
    ],
  });

  it('selects a target by alias or by id plus machine, and never picks one itself', () => {
    expect(selectAgentRoleTarget([both], 'Reviewer-Laptop')).toMatchObject({
      machineId: 'laptop',
      agentConfigId: 'codex',
    });
    expect(selectAgentRoleTarget([both], 'reviewer', { machineId: 'laptop' }).runConfig).toEqual({
      modelId: 'gpt-5.6',
    });
    expect(() => selectAgentRoleTarget([both], 'Reviewer')).toThrow(
      /runs on several machines; name one\. Machines: remote-machine \(Reviewer-Remote\), laptop \(Reviewer-Laptop\)/
    );
    expect(() => selectAgentRoleTarget([both], 'reviewer', { machineId: 'ci' })).toThrow(
      /does not run on machine ci/
    );
  });

  it('lets --machine pick the target instead of reporting it as overridden', async () => {
    const { manager } = createRoleCatalogManager([
      both,
      agentRole({ id: 'solo' as AgentRoleId, name: 'Solo' }),
    ]);
    const picked = await resolveAgentRoleCreateFromCatalog({
      manager,
      workspaceId: 'workspace-id' as WorkspaceId,
      selector: 'reviewer',
      prompt: 'Review this.',
      overrides: { machine: 'laptop', model: 'manual' },
    });
    expect(picked).toMatchObject({ machineId: 'laptop', agentConfigId: 'codex' });
    expect(picked.dispatchConfig.modelId).toBe('gpt-5.6');
    expect(picked.ignoredOverrides).toEqual(['--model']);

    // A single-machine Role keeps its machine; --machine stays an ignored flag.
    const solo = await resolveAgentRoleCreateFromCatalog({
      manager,
      workspaceId: 'workspace-id' as WorkspaceId,
      selector: 'solo',
      prompt: 'Review this.',
      overrides: { machine: 'laptop' },
    });
    expect(solo.machineId).toBe('remote-machine');
    expect(solo.ignoredOverrides).toEqual(['--machine']);
  });

  it('requires agentRoleMachineId over MCP and dispatches that target', () => {
    const invoking = undefined;
    const requester = { machineId: 'current-machine' as MachineId, project: undefined };
    const input = { operationId: 'multi-1', prompt: 'Review.', agentRoleId: 'reviewer' };
    expect(() => resolveMcpSessionCreate(input, invoking, requester, both)).toThrow(
      expect.objectContaining({ code: 'AGENT_ROLE_MACHINE_REQUIRED' })
    );
    expect(() =>
      resolveMcpSessionCreate({ ...input, agentRoleMachineId: 'ci' }, invoking, requester, both)
    ).toThrow(expect.objectContaining({ code: 'AGENT_ROLE_MACHINE_NOT_FOUND' }));

    const resolved = resolveMcpSessionCreate(
      { ...input, agentRoleMachineId: 'laptop' },
      invoking,
      requester,
      both
    );
    expect(resolved.input).toMatchObject({ machineId: 'laptop', agentConfigId: 'codex' });
    expect(resolved.input).not.toHaveProperty('agentRoleMachineId');
    expect(resolved.dispatchConfig).toEqual({ modelId: 'gpt-5.6', inheritSessionDefaults: false });
    expect(resolved.role).toMatchObject({ id: 'reviewer', machineId: 'laptop' });
  });
});
