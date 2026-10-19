import { describe, expect, it, vi } from 'vitest';
import { Flock } from '@loro-dev/flock-wasm';
import {
  AGENT_ROLE_VERSION,
  normalizeAgentRole,
  workspaceFlockKeys,
  type AgentConfigId,
  type AgentRole,
  type AgentRoleId,
  type MachineId,
  type WorkspaceMcpServerMeta,
} from '@lody/shared';
import {
  deleteWorkspaceMcpServer,
  putWorkspaceMcpServer,
  uploadWorkspaceCatalog,
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

  it('resolves while the upload is still in flight', async () => {
    // What the editor closes on. Awaiting the upload left a finished, already
    // durable save sitting behind a round trip.
    const { calls, deps, releaseUpload } = createDeps();
    await putWorkspaceMcpServer(deps, entry);
    expect(calls).not.toContain('syncOnce:end');
    expect(deps.writer.flockRowPut).toHaveBeenCalledTimes(1);

    releaseUpload();
    await settle();
    expect(calls).toContain('syncOnce:end');
  });

  it('does the same for a role, and for a delete', async () => {
    const put = createDeps();
    await writeWorkspaceAgentRole(put.deps, role);
    expect(put.calls).not.toContain('syncOnce:end');

    const removal = createDeps();
    await deleteWorkspaceMcpServer(removal.deps, entry.id);
    expect(removal.calls).toContain('flockRowDelete');
    expect(removal.calls).not.toContain('syncOnce:end');
  });

  it('never turns a failed upload into a failed write', async () => {
    // The row is durable either way and the room carries the document later, so
    // an upload failure is logged and nothing else — no rejection to surface, no
    // rollback, and no banner the user can neither act on nor dismiss.
    const failed = createDeps({ syncError: new Error('network unavailable') });
    await expect(putWorkspaceMcpServer(failed.deps, entry)).resolves.toBeUndefined();
    failed.releaseUpload();
    await expect(uploadWorkspaceCatalog(failed.deps)).resolves.toBeUndefined();

    const unopenable = createDeps({ openError: new Error('room unavailable') });
    await expect(writeWorkspaceAgentRole(unopenable.deps, role)).resolves.toBeUndefined();
    await expect(uploadWorkspaceCatalog(unopenable.deps)).resolves.toBeUndefined();
  });

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
