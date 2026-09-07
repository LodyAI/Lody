import { describe, expect, it, vi } from 'vitest';
import type { LoroRepo } from 'loro-repo';
import {
  machineFlockKeys,
  type AgentConfigMeta,
  type MachineFlockKey,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import {
  deleteMachineAgentConfig,
  readMachineAgentConfigs,
  readMachineBuiltinAgentOptOuts,
  upsertMachineAgentConfig,
} from '../src/lib/agent-config-machine-flock';

const workspaceId = 'workspace-1' as WorkspaceId;
const machineId = 'machine-1' as MachineId;

/** Minimal in-memory flock: plain key -> value storage, enough to check row and opt-out writes/deletes. */
class FakeFlock {
  readonly rows = new Map<string, { key: MachineFlockKey; value: unknown }>();

  scan(options?: { prefix?: readonly unknown[] }) {
    return [...this.rows.values()].filter((row) => {
      const prefix = options?.prefix;
      return !prefix || prefix.every((part, index) => row.key[index] === part);
    });
  }

  set(key: MachineFlockKey, value: unknown): void {
    this.rows.set(JSON.stringify(key), { key: [...key] as MachineFlockKey, value });
  }

  delete(key: MachineFlockKey): void {
    this.rows.delete(JSON.stringify(key));
  }

  commit(): void {}
}

function createFakeRepo() {
  const flock = new FakeFlock();
  const repo = {
    openFlockDoc: vi.fn(async () => ({ flock, syncOnce: vi.fn(async () => {}) })),
    getDocMeta: vi.fn(async () => null),
    deleteDoc: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
  } as unknown as LoroRepo;
  return { repo, flock };
}

const kimiConfig: AgentConfigMeta = {
  id: 'agent-config-kimi',
  machineId,
  name: 'Kimi Code',
  cliType: 'builtin',
  agentType: 'kimi',
  env: {},
} as AgentConfigMeta;

const customConfig: AgentConfigMeta = {
  id: 'agent-config-custom',
  machineId,
  name: 'My ACP',
  cliType: 'custom',
  agentType: 'custom-acp',
  env: {},
} as AgentConfigMeta;

describe('machine flock agent config opt-out', () => {
  it('records an opt-out when a managed builtin config is deleted', async () => {
    const { repo, flock } = createFakeRepo();
    await upsertMachineAgentConfig(repo, workspaceId, kimiConfig);
    expect(Object.keys(await readMachineAgentConfigs(repo, workspaceId, machineId))).toHaveLength(
      1
    );

    await deleteMachineAgentConfig(repo, workspaceId, kimiConfig);

    // Row gone, opt-out kept -- that record is how the next startup auto-registration
    // knows the user removed it.
    expect(await readMachineAgentConfigs(repo, workspaceId, machineId)).toEqual({});
    expect(await readMachineBuiltinAgentOptOuts(repo, workspaceId, machineId)).toEqual(
      new Set(['kimi'])
    );
    const optOutRow = flock.rows.get(JSON.stringify(machineFlockKeys.builtinAgentOptOut('kimi')));
    expect(optOutRow?.value).toEqual({ v: 1, removedAt: expect.any(Number) });
  });

  it('clears the opt-out when the same builtin type is added back', async () => {
    const { repo } = createFakeRepo();
    await upsertMachineAgentConfig(repo, workspaceId, kimiConfig);
    await deleteMachineAgentConfig(repo, workspaceId, kimiConfig);
    expect(await readMachineBuiltinAgentOptOuts(repo, workspaceId, machineId)).toEqual(
      new Set(['kimi'])
    );

    // Adding it back retracts the removal, so the opt-out has to disappear with it, or
    // the list holds it while startup still treats it as removed.
    await upsertMachineAgentConfig(repo, workspaceId, {
      ...kimiConfig,
      id: 'agent-config-kimi-2',
    } as AgentConfigMeta);

    expect(await readMachineBuiltinAgentOptOuts(repo, workspaceId, machineId)).toEqual(new Set());
    expect(Object.keys(await readMachineAgentConfigs(repo, workspaceId, machineId))).toHaveLength(
      1
    );
  });

  it('does not record an opt-out for non-managed configs', async () => {
    const { repo } = createFakeRepo();
    await upsertMachineAgentConfig(repo, workspaceId, customConfig);
    await deleteMachineAgentConfig(repo, workspaceId, customConfig);

    // Custom providers are outside startup auto-registration, so no opt-out is needed or wanted.
    expect(await readMachineBuiltinAgentOptOuts(repo, workspaceId, machineId)).toEqual(new Set());
  });

  it('records an opt-out even when the config row is already gone', async () => {
    const { repo } = createFakeRepo();
    // The row never existed, so the delete only writes the opt-out -- that change still has
    // to be persisted and must not be swallowed by the "row unchanged" early return.
    await deleteMachineAgentConfig(repo, workspaceId, kimiConfig);

    expect(await readMachineBuiltinAgentOptOuts(repo, workspaceId, machineId)).toEqual(
      new Set(['kimi'])
    );
  });
});
