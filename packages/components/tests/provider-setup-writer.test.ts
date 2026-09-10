import { createStore } from 'jotai';
import { describe, expect, it, vi } from 'vitest';
import {
  buildLodyCodexCustomProviderEnv,
  LODY_CODEX_API_KEY_ENV,
  machineFlockKeys,
  serializeMachineFlockKey,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineFlockRowMap,
  type MachineFlockScanRow,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';

import {
  cmdCreateProviderSetupAtom,
  cmdRequestProviderCredentialCleanupAtom,
  cmdRetryProviderSetupAtom,
  deleteProviderSetupAtom,
  getAllAgentConfigAtom,
  getAllProviderSetupsAtom,
} from '../src/atoms/agents';
import {
  machineFlockRowsByWorkspaceAtom,
  setMachineFlockRowsForMachineAtom,
} from '../src/atoms/machine-flock';
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '../src/atoms/workspace-context';

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('ProviderSetup WorkspaceWriter integration', () => {
  it('authors create, retry, and durable-first cancel through the writer while projecting local state before mirror sync', async () => {
    const store = createStore();
    const workspaceId = 'workspace-provider-setup-writer' as WorkspaceId;
    const workspaceSlug = 'workspace-provider-setup-writer';
    const machineId = 'machine-provider-setup-writer' as MachineId;
    const setupId = 'provider-setup-writer' as AgentConfigId;
    const flockDocId = `${workspaceId}:mf:${machineId}`;
    const mirrorRows = new Map<string, MachineFlockScanRow>();
    const markerAccepted = createDeferred();

    const rendererSet = vi.fn();
    const rendererDelete = vi.fn();
    const rendererCommit = vi.fn();
    const flush = vi.fn(async () => undefined);
    const syncOnce = vi.fn(async () => undefined);
    const openFlockDoc = vi.fn(async () => ({
      flock: {
        scan: vi.fn(() => mirrorRows.values()),
        set: rendererSet,
        delete: rendererDelete,
        commit: rendererCommit,
      },
      syncOnce,
      joinRoom: vi.fn(),
    }));

    const flockRowPut = vi.fn(async (_flockDocId: string, key: readonly string[]) => {
      if (key[0] === 'providerSetupCancellation') {
        await markerAccepted.promise;
      }
    });
    const flockRowDelete = vi.fn(async (_flockDocId: string, key: readonly string[]) => {
      if (key[0] === 'providerSetup') {
        throw new Error('injected-delete-interruption');
      }
    });

    store.set(runtimeAtom, {
      workspaceId,
      workspaceSlug,
      repo: { openFlockDoc, flush },
      writer: { flockRowPut, flockRowDelete },
    } as unknown as WorkspaceRuntime);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, workspaceSlug);

    const config: AgentConfigMeta = {
      id: setupId,
      machineId,
      name: 'Managed Codex',
      description: undefined,
      cliType: 'builtin',
      agentType: 'codex',
      env: buildLodyCodexCustomProviderEnv(
        {},
        { baseUrl: 'https://relay.example.com/v1', credentialRevision: 'revision-1' }
      ),
      prompt: '',
    };

    await store.set(cmdCreateProviderSetupAtom, config);

    expect(flockRowPut.mock.calls[0]).toEqual([
      flockDocId,
      machineFlockKeys.providerSetup(setupId),
      expect.objectContaining({
        id: setupId,
        machineId,
        status: 'awaiting-auth',
        attempt: 1,
        operation: 'create',
        credentialRevision: 'revision-1',
      }),
    ]);
    expect(store.get(getAllProviderSetupsAtom)).toEqual([
      expect.objectContaining({ id: setupId, status: 'awaiting-auth', attempt: 1 }),
    ]);
    const writtenSetup = flockRowPut.mock.calls[0]?.[2] as { config: AgentConfigMeta };
    expect(writtenSetup.config.env[LODY_CODEX_API_KEY_ENV]).toBeUndefined();
    expect(mirrorRows.size).toBe(0);

    const createdSetup = store.get(getAllProviderSetupsAtom)[0]!;
    const setupKey = machineFlockKeys.providerSetup(setupId);
    store.set(setMachineFlockRowsForMachineAtom, {
      workspaceId,
      machineId,
      rows: {
        [serializeMachineFlockKey(setupKey)]: {
          key: setupKey,
          value: {
            ...createdSetup,
            status: 'failed',
            failureCode: 'verification-failed',
          },
        },
      },
      mode: 'merge',
    });

    await store.set(cmdRetryProviderSetupAtom, setupId);

    expect(flockRowPut.mock.calls[1]).toEqual([
      flockDocId,
      setupKey,
      expect.not.objectContaining({ failureCode: expect.anything() }),
    ]);
    expect(store.get(getAllProviderSetupsAtom)).toEqual([
      expect.objectContaining({ id: setupId, status: 'queued', attempt: 2 }),
    ]);

    const configKey = machineFlockKeys.agentConfig(setupId);
    const unrelatedKey = machineFlockKeys.dotlodyPath();
    store.set(setMachineFlockRowsForMachineAtom, {
      workspaceId,
      machineId,
      rows: {
        [serializeMachineFlockKey(configKey)]: { key: configKey, value: config },
        [serializeMachineFlockKey(unrelatedKey)]: {
          key: unrelatedKey,
          value: '/tmp/.lody',
        },
      },
      mode: 'merge',
    });
    expect(store.get(getAllAgentConfigAtom)).toEqual([config]);

    const cancelPromise = store.set(deleteProviderSetupAtom, setupId);
    const cancellationKey = machineFlockKeys.providerSetupCancellation(setupId);

    expect(flockRowPut).toHaveBeenCalledTimes(3);
    expect(flockRowPut.mock.calls[2]).toEqual([
      flockDocId,
      cancellationKey,
      expect.objectContaining({ v: 1, id: setupId, machineId }),
    ]);
    expect(flockRowDelete).toHaveBeenCalledTimes(2);

    markerAccepted.resolve();
    await cancelPromise;

    expect(flockRowDelete.mock.calls).toEqual([
      [flockDocId, cancellationKey],
      [flockDocId, cancellationKey],
      [flockDocId, setupKey],
      [flockDocId, configKey],
    ]);
    const finalRows = store.get(machineFlockRowsByWorkspaceAtom)[String(workspaceId)]?.[
      String(machineId)
    ] as MachineFlockRowMap;
    expect(finalRows[serializeMachineFlockKey(cancellationKey)]).toEqual({
      key: cancellationKey,
      value: expect.objectContaining({ v: 1, id: setupId, machineId }),
    });
    expect(finalRows[serializeMachineFlockKey(setupKey)]).toBeUndefined();
    expect(finalRows[serializeMachineFlockKey(configKey)]).toBeUndefined();
    expect(finalRows[serializeMachineFlockKey(unrelatedKey)]).toEqual({
      key: unrelatedKey,
      value: '/tmp/.lody',
    });
    expect(store.get(getAllProviderSetupsAtom)).toEqual([]);
    expect(store.get(getAllAgentConfigAtom)).toEqual([]);

    expect(rendererSet).not.toHaveBeenCalled();
    expect(rendererDelete).not.toHaveBeenCalled();
    expect(rendererCommit).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
    expect(syncOnce).not.toHaveBeenCalled();

    await store.set(cmdRequestProviderCredentialCleanupAtom, {
      id: setupId,
      machineId,
      credentialRevision: 'revision-1',
    });
    expect(flockRowPut).toHaveBeenLastCalledWith(
      flockDocId,
      machineFlockKeys.providerCredentialCleanup(setupId, 'revision-1'),
      expect.objectContaining({
        id: setupId,
        machineId,
        credentialRevision: 'revision-1',
      })
    );
  });
});
