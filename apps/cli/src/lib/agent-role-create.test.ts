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
  bindAgentRoleCreateOptions,
  composeAgentRolePrompt,
  listIgnoredAgentRoleOverrides,
  loadWorkspaceAgentRoleCatalog,
  resolveAgentRoleCreate,
  resolveAgentRoleCreateFromCatalog,
  selectUniqueAgentRoleByIdOrName,
} from './agent-role-create';
import { __lodyMcpServerInternals } from '../mcp/lody-mcp-server';

const { buildMcpCreateOptions, getSessionContext, resolveMcpSessionCreate } =
  __lodyMcpServerInternals;

const createMcpContext = (): ReturnType<typeof getSessionContext> => ({
  machineId: 'machine-id',
  workspaceId: 'workspace-id',
  sessionId: 'current-session-id',
  localControlSocketPath: '/tmp/lody-control.sock',
  workdir: '/tmp/workspace',
});

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

  it('fails fast with the candidate list when the Role does not exist', () => {
    expect(() => selectUniqueAgentRoleByIdOrName(roles, 'missing')).toThrow(
      /Agent Role not found: missing\. Candidates: Implementer \(implementer\), Reviewer \(reviewer\)/
    );
    expect(() => selectUniqueAgentRoleByIdOrName(roles, '  ')).toThrow(
      'Missing Agent Role selector.'
    );
  });
});

describe('resolveAgentRoleCreate', () => {
  it('composes the Prompt prefix and freezes the Role run config', () => {
    const role = agentRole({
      runConfig: {
        modeId: 'default',
        modelId: 'opus',
        configOptionValues: { reasoning_effort: 'medium' },
      },
      promptPrefix: 'Act as a careful reviewer.',
    });

    const resolved = resolveAgentRoleCreate({ role, prompt: 'Review the current diff.' });

    expect(resolved.prompt).toBe('Act as a careful reviewer.\n\nReview the current diff.');
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

  it('lists every manual override flag the Role replaces', () => {
    expect(
      listIgnoredAgentRoleOverrides({
        machine: 'workstation',
        agent: 'codex',
        agentConfig: 'claude',
        mode: 'plan',
        model: 'opus',
        configOption: ['permission_mode=ask'],
      })
    ).toEqual(['--machine', '--agent', '--agent-config', '--mode', '--model', '--config-option']);
    expect(listIgnoredAgentRoleOverrides({ machine: '  ', configOption: [] })).toEqual([]);
  });
});

describe('resolveAgentRoleCreateFromCatalog', () => {
  it('loads the workspace catalog and resolves an id or unique name', async () => {
    const role = agentRole();
    const { manager, syncFlockDocOrThrow } = createRoleCatalogManager([role]);

    const byId = await resolveAgentRoleCreateFromCatalog({
      manager,
      workspaceId: 'workspace-id' as WorkspaceId,
      selector: 'reviewer',
      prompt: 'Review this.',
    });
    expect(byId.role).toEqual(role);
    expect(syncFlockDocOrThrow).toHaveBeenCalledWith('workspace-id:wf:workspace', {
      timeoutMs: 10_000,
      reason: 'agent-role-catalog-read',
    });

    const byName = await resolveAgentRoleCreateFromCatalog({
      manager,
      workspaceId: 'workspace-id' as WorkspaceId,
      selector: 'Reviewer',
      prompt: 'Review this.',
      overrides: { model: 'manual-model' },
    });
    expect(byName.role.id).toBe('reviewer');
    expect(byName.ignoredOverrides).toEqual(['--model']);

    await expect(
      resolveAgentRoleCreateFromCatalog({
        manager,
        workspaceId: 'workspace-id' as WorkspaceId,
        selector: 'missing',
        prompt: 'Review this.',
      })
    ).rejects.toThrow(/Agent Role not found: missing/);
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

  it('bindAgentRoleCreateOptions leaves options untouched without a Role', () => {
    const options: CreateOptions = {};
    bindAgentRoleCreateOptions(options, undefined);
    expect(options).toEqual({});
  });
});

describe('MCP resolution parity', () => {
  it('resolves the same target, Prompt and dispatch config as the MCP create path', () => {
    const role = agentRole({
      runConfig: {
        modeId: 'default',
        modelId: 'opus',
        configOptionValues: { reasoning_effort: 'medium' },
      },
      promptPrefix: 'Act as a careful reviewer.',
    });
    const prompt = 'Review the current diff.';

    const cli = resolveAgentRoleCreate({ role, prompt });
    const mcp = resolveMcpSessionCreate(
      { operationId: 'role-review-1', prompt, agentRoleId: 'reviewer' },
      undefined,
      { machineId: 'current-machine' as MachineId, project: undefined },
      role
    );

    expect(cli.machineId).toBe(mcp.input.machineId);
    expect(cli.agentConfigId).toBe(mcp.input.agentConfigId);
    expect(cli.prompt).toBe(mcp.prompt);
    expect(cli.dispatchConfig).toEqual(mcp.dispatchConfig);

    const cliOptions: CreateOptions = {};
    applyAgentRoleCreateTarget(cliOptions, cli);
    const mcpOptions = buildMcpCreateOptions(mcp.input, createMcpContext());
    expect(cliOptions.machine).toBe(mcpOptions.machine);
    expect(cliOptions.agentConfig).toBe(mcpOptions.agentConfig);
    expect(cliOptions.agentRoleId).toBe('reviewer');
    expect(cliOptions.agentRoleRevision).toBe(7);

    bindAgentRoleCreateOptions(mcpOptions, mcp.role);
    expect(mcpOptions.agentRoleId).toBe(cliOptions.agentRoleId);
    expect(mcpOptions.agentRoleRevision).toBe(cliOptions.agentRoleRevision);
    expect(mcpOptions.agentRoleSnapshot).toEqual(cliOptions.agentRoleSnapshot);
  });
});

describe('loadWorkspaceAgentRoleCatalog', () => {
  it('reads Role rows from the workspace Flock document', async () => {
    const role = agentRole();
    const { manager } = createRoleCatalogManager([role]);

    const catalog = await loadWorkspaceAgentRoleCatalog(manager, 'workspace-id' as WorkspaceId);

    expect(catalog.get(role.id)).toEqual(role);
  });
});
