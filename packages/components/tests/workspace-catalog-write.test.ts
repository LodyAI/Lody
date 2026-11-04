import { describe, expect, it, vi } from 'vitest';
import { Flock } from '@loro-dev/flock-wasm';
import {
  AGENT_ROLE_VERSION,
  getProjectMcpKey,
  normalizeAgentRole,
  workspaceFlockKeys,
  type AgentConfigId,
  type AgentRole,
  type AgentRoleId,
  type LocalProjectId,
  type MachineId,
  type McpServerId,
  type WorkspaceMcpServerMeta,
} from '@lody/shared';
import {
  ProjectMcpDefaultWriteError,
  putProjectMcpDefault,
  writeWorkspaceAgentRole,
  type WorkspaceCatalogWriteDeps,
} from '../src/lib/workspace-catalog-write';
import { createDirectWorkspaceWriter } from '../src/providers/workspace-writer-impl';

const workspaceId = 'workspace-1' as WorkspaceCatalogWriteDeps['workspaceId'];
const entry: WorkspaceMcpServerMeta = {
  id: 'server-1' as WorkspaceMcpServerMeta['id'],
  name: 'Files',
  transport: 'stdio',
  connection: { transport: 'stdio', command: 'mcp-files' },
  createdAt: 1,
  updatedAt: 1,
};
const role: AgentRole = {
  v: AGENT_ROLE_VERSION,
  id: 'role-1' as AgentRoleId,
  ownerUserId: 'user-1',
  visibility: 'private',
  name: 'Reviewer',
  machineId: 'machine-1' as MachineId,
  agentConfigId: 'config-1' as AgentConfigId,
  runConfig: {},
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};

/**
 * The upload hangs until the test releases it. That is the whole property under
 * test: a write resolves while the round trip is still in flight, so nothing
 * the user is waiting on is tied to the network.
 */
function createDeps(options?: { openError?: Error; syncError?: Error }) {
  const calls: string[] = [];
  let releaseUpload!: () => void;
  const uploadGate = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  const syncOnce = vi.fn(async () => {
    calls.push('syncOnce:start');
    await uploadGate;
    calls.push('syncOnce:end');
    if (options?.syncError) throw options.syncError;
  });
  const deps = {
    workspaceId,
    writer: {
      flockRowPut: vi.fn(async () => {
        calls.push('flockRowPut');
      }),
      flockRowDelete: vi.fn(async () => {
        calls.push('flockRowDelete');
      }),
    },
    repo: {
      openFlockDoc: vi.fn(async () => {
        calls.push('openFlockDoc');
        if (options?.openError) throw options.openError;
        return { syncOnce };
      }),
    },
  } as unknown as WorkspaceCatalogWriteDeps;
  return { calls, deps, releaseUpload };
}

describe('workspace catalog writes', () => {
  const settle = async () => {
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
  };

  it('stores a multi-machine role in the row shape older clients skip', async () => {
    const flock = new Flock('catalog-write-multi');
    const repo = { openFlockDoc: async () => ({ flock, syncOnce: async () => {} }) };
    const deps = {
      workspaceId,
      repo,
      writer: createDirectWorkspaceWriter({ repo } as never),
    } as unknown as WorkspaceCatalogWriteDeps;
    const multi: AgentRole = {
      ...role,
      additionalTargets: [
        {
          machineId: 'machine-2' as MachineId,
          agentConfigId: 'config-2' as AgentConfigId,
          runConfig: {},
        },
      ],
    };
    const key = workspaceFlockKeys.agentRole(role.id);

    await writeWorkspaceAgentRole(deps, role);
    expect(flock.get(key)).toEqual(role);

    await writeWorkspaceAgentRole(deps, multi);
    expect(flock.get(key)).toMatchObject({ v: 2 });
    expect(flock.get(key)).not.toHaveProperty('additionalTargets');
    expect(normalizeAgentRole(flock.get(key))).toEqual(multi);
  });
});

describe('project default MCP writes', () => {
  const settle = async () => {
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
  };
  const localTarget = {
    workspaceId,
    project: { kind: 'local' as const, localProjectId: 'project-1' as LocalProjectId },
    machineId: 'machine-1',
  };
  const owner = { kind: 'local' as const, currentUserId: 'user-1', machineOwnerUserId: 'user-1' };
  const ids = ['server-1', 'server-2'] as McpServerId[];

  it('records an explicit empty list, and ignores the branch and worktree', async () => {
    const { deps } = createDeps();
    await putProjectMcpDefault(
      deps,
      {
        ...localTarget,
        project: { ...localTarget.project, branch: 'feature', useWorktree: true },
      },
      owner,
      []
    );
    expect(deps.writer.flockRowPut).toHaveBeenCalledWith(
      expect.any(String),
      workspaceFlockKeys.projectMcpDefault(
        getProjectMcpKey(localTarget.project, localTarget.machineId)!
      ),
      { ids: [] }
    );
  });

  it.each([
    ['a teammate on the owner’s machine', { ...owner, currentUserId: 'user-2' }],
    ['a signed-out user', { ...owner, currentUserId: null }],
    ['an unknown machine owner', { ...owner, machineOwnerUserId: null }],
    [
      'a GitHub grant for a local project',
      { kind: 'github' as const, currentUserId: 'user-1', repoInWorkspace: true },
    ],
  ])('refuses %s at the write, not only in the UI', async (_name, access) => {
    const { deps } = createDeps();
    await expect(putProjectMcpDefault(deps, localTarget, access, ids)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(deps.writer.flockRowPut).not.toHaveBeenCalled();
  });

  it('refuses a repository that is not connected to the workspace', async () => {
    const { deps } = createDeps();
    const github = {
      workspaceId,
      project: { kind: 'github' as const, repoFullName: 'LodyAI/Lody', branch: 'main' },
    };
    await expect(
      putProjectMcpDefault(
        deps,
        github,
        { kind: 'github', currentUserId: 'user-1', repoInWorkspace: false },
        ids
      )
    ).rejects.toBeInstanceOf(ProjectMcpDefaultWriteError);
    await putProjectMcpDefault(
      deps,
      github,
      { kind: 'github', currentUserId: 'user-1', repoInWorkspace: true },
      ids
    );
    expect(deps.writer.flockRowPut).toHaveBeenCalledTimes(1);
  });

  it('refuses another workspace’s project and malformed ids', async () => {
    const { deps } = createDeps();
    await expect(
      putProjectMcpDefault(
        deps,
        { ...localTarget, workspaceId: 'workspace-2' as typeof workspaceId },
        owner,
        ids
      )
    ).rejects.toMatchObject({ code: 'workspace_mismatch' });
    await expect(
      putProjectMcpDefault(deps, localTarget, owner, [' '] as McpServerId[])
    ).rejects.toMatchObject({ code: 'invalid_selection' });
    expect(deps.writer.flockRowPut).not.toHaveBeenCalled();
  });
});
