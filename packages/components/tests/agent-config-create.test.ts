import { createStore } from 'jotai';
import { describe, expect, it, vi } from 'vitest';
import {
  machineFlockKeys,
  serializeMachineFlockKey,
  type AgentConfigId,
  type MachineFlockKey,
  type MachineFlockScanRow,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';

import { cmdCreateAgentConfigAtom, getAllAgentConfigAtom } from '../src/atoms/agents';
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '../src/atoms/workspace-context';

function never(): Promise<never> {
  return new Promise<never>(() => undefined);
}

describe('cmdCreateAgentConfigAtom', () => {
  it('authors the machine flock row through the writer and updates agent config atoms without waiting for sync', async () => {
    const store = createStore();
    const workspaceId = 'workspace-agent-config-create-test' as WorkspaceId;
    const workspaceSlug = 'workspace-agent-config-create-test';
    const machineId = 'machine-agent-config-create-test' as MachineId;
    const rows = new Map<string, MachineFlockScanRow>();
    const fakeFlock = {
      scan: vi.fn(() => rows.values()),
      set: vi.fn((key: MachineFlockKey, value: unknown) => {
        rows.set(serializeMachineFlockKey(key), { key, value });
      }),
      delete: vi.fn((key: MachineFlockKey) => {
        rows.delete(serializeMachineFlockKey(key));
      }),
      commit: vi.fn(),
    };
    const flush = vi.fn(() => never());
    const openFlockDoc = vi.fn(async () => ({
      flock: fakeFlock,
      syncOnce: vi.fn(() => never()),
      joinRoom: vi.fn(),
    }));

    // The write is authored through the writer seam. In this direct-mode mock the
    // writer applies the row into the same fake flock the read-back reads, so the
    // agent-config atom converges without awaiting any remote sync.
    const flockRowPut = vi.fn(async (_docId: string, key: MachineFlockKey, value: unknown) => {
      rows.set(serializeMachineFlockKey(key), { key, value });
    });

    store.set(runtimeAtom, {
      workspaceId,
      workspaceSlug,
      repo: { openFlockDoc, flush },
      writer: { flockRowPut } as unknown as WorkspaceRuntime['writer'],
    } as unknown as WorkspaceRuntime);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, workspaceSlug);

    const createPromise = store.set(cmdCreateAgentConfigAtom, {
      id: 'config-immediate-acp' as AgentConfigId,
      machineId,
      name: 'Immediate ACP Provider',
      description: undefined,
      cliType: 'custom',
      agentType: 'custom-immediate-acp',
      customAcp: { command: 'node', args: ['server.js'] },
      env: { API_KEY: 'test' },
      prompt: 'use this provider',
    });

    const createdId = await createPromise;
    const rowId = serializeMachineFlockKey(machineFlockKeys.agentConfig(createdId));
    const createdRow = rows.get(rowId);

    expect(flockRowPut).toHaveBeenCalledWith(
      `${workspaceId}:mf:${machineId}`,
      machineFlockKeys.agentConfig(createdId),
      expect.objectContaining({ id: createdId, machineId })
    );
    expect(createdRow?.value).toMatchObject({
      id: createdId,
      machineId,
      name: 'Immediate ACP Provider',
      cliType: 'custom',
      agentType: 'custom-immediate-acp',
      customAcp: { command: 'node', args: ['server.js'] },
      env: { API_KEY: 'test' },
      prompt: 'use this provider',
    });

    expect(store.get(getAllAgentConfigAtom)).toEqual([
      expect.objectContaining({
        id: createdId,
        machineId,
        name: 'Immediate ACP Provider',
      }),
    ]);
  });
});

it('routes native provider atoms through finite management commands and safe setup summaries without touching retired MF or Meta writers', async () => {
  const { openNativeMachineCatalogTestGroup, machineA, binding, deferred } =
    await import('./native-machine-catalog.test-support');
  const {
    cmdUpdateAgentConfigAtom,
    deleteAgentConfigAtom,
    cmdCreateProviderSetupAtom,
    cmdRetryProviderSetupAtom,
    deleteProviderSetupAtom,
    getAllAgentConfigListAtom,
    getAllProviderSetupsAtom,
  } = await import('../src/atoms/agents');
  const { nativeMachineCatalogSettingsAtom } = await import('../src/atoms/native-machine-catalog');
  const group = await openNativeMachineCatalogTestGroup([machineA]);
  const store = createStore();
  const retired = () => {
    throw new Error('Retired MF or Meta writer must not open');
  };
  const off = group.source.subscribe(() =>
    store.set(nativeMachineCatalogSettingsAtom, group.source.getSnapshot())
  );
  const until = (predicate: () => boolean) => {
    const ready = deferred<void>();
    const check = () => {
      if (predicate()) {
        detach();
        ready.resolve();
      }
    };
    const detach = group.source.subscribe(check);
    check();
    return ready.promise;
  };
  try {
    await group.source.start();
    store.set(runtimeAtom, {
      ...binding,
      workspaceSlug: 'native-provider',
      ownsNativeMachineCatalog: () => true,
      nativeMachineCatalogSource: group.source,
      repo: { openFlockDoc: retired, getDocMeta: retired },
      writer: { flockRowPut: retired, flockRowDelete: retired, deleteDoc: retired },
    } as unknown as WorkspaceRuntime);
    store.set(currentWorkspaceIdAtom, binding.workspaceId);
    store.set(currentWorkspaceSlugAtom, 'native-provider');
    store.set(nativeMachineCatalogSettingsAtom, group.source.getSnapshot());
    const config = {
      id: 'native-atom-created' as AgentConfigId,
      machineId: machineA,
      name: 'Created',
      cliType: 'builtin' as const,
      agentType: 'claude',
      env: { API_KEY: 'SYNTHETIC_NATIVE_ATOM_SECRET' },
      prompt: 'SYNTHETIC_PRIVATE_PROMPT',
    };
    const created = until(() =>
      group.source.getSnapshot().agents.some((value) => value.id === config.id)
    );
    expect(await store.set(cmdCreateAgentConfigAtom, config)).toBe(config.id);
    await created;
    expect(store.get(getAllAgentConfigAtom)).toEqual([]);
    expect(JSON.stringify(store.get(getAllAgentConfigListAtom))).not.toContain(
      'SYNTHETIC_NATIVE_ATOM_SECRET'
    );
    const renamed = until(() =>
      group.source
        .getSnapshot()
        .agents.some((value) => value.id === config.id && value.name === 'Renamed')
    );
    await store.set(cmdUpdateAgentConfigAtom, { ...config, name: 'Renamed' });
    await renamed;
    expect(
      (
        await group.client.flockGet(
          group.namespace,
          group.rooms.get(machineA)!,
          machineFlockKeys.agentConfig(config.id)
        )
      ).value
    ).toMatchObject({ name: 'Renamed', env: config.env, prompt: config.prompt });
    await store.set(deleteAgentConfigAtom, config.id);
    expect(
      (
        await group.client.flockGet(
          group.namespace,
          group.rooms.get(machineA)!,
          machineFlockKeys.agentConfig(config.id)
        )
      ).found
    ).toBe(false);
    const setup = { ...config, id: 'native-atom-setup' as AgentConfigId, agentType: 'bub' };
    const queued = until(() =>
      group.source.getSnapshot().setups.some((value) => value.id === setup.id)
    );
    await store.set(cmdCreateProviderSetupAtom, setup);
    await queued;
    expect(store.get(getAllProviderSetupsAtom)).toEqual([]);
    expect(JSON.stringify(group.source.getSnapshot().setups)).not.toContain(
      'SYNTHETIC_NATIVE_ATOM_SECRET'
    );
    const retried = until(() =>
      group.source
        .getSnapshot()
        .setups.some((value) => value.id === setup.id && value.attempt === 2)
    );
    await store.set(cmdRetryProviderSetupAtom, setup.id);
    await retried;
    await store.set(deleteProviderSetupAtom, setup.id);
    expect(
      (
        await group.client.flockGet(
          group.namespace,
          group.rooms.get(machineA)!,
          machineFlockKeys.providerSetupCancellation(setup.id)
        )
      ).value
    ).toMatchObject({ id: setup.id, machineId: machineA });
    expect(
      (
        await group.client.flockGet(
          group.namespace,
          group.rooms.get(machineA)!,
          machineFlockKeys.providerSetup(setup.id)
        )
      ).found
    ).toBe(false);
  } finally {
    off();
    await group.close();
  }
});
