import { describe, expect, it, vi } from 'vitest';
import {
  ACP_CAPABILITY_CACHE_VERSION,
  getAcpCapabilityCacheKey,
  type AcpCapabilityCacheEntry,
  type AgentConfigId,
  type MachineViewMeta,
  type MachineAcpBinaryProgressMessage,
  type MachineId,
  machineFlockKeys,
  serializeMachineFlockKey,
  type AgentConfigMeta,
  type MachineFlockRowMap,
  type MachineFlockScanRow,
  type WorkspaceId,
} from '@lody/shared';
import { resolveInitialOnboardingProviderStatus } from '../src/components/onboarding/provider-status';
import {
  createProviderTestRunRegistry,
  providerTestActivityFromProgress,
} from '../src/components/onboarding/provider-test-state';
import { createStore } from 'jotai';
import {
  cmdCreateProviderSetupAtom,
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

describe('provider-status', () => {
  const config = {
    id: 'builtin-kimi' as AgentConfigId,
    cliType: 'builtin' as const,
    agentType: 'kimi',
  };

  const runtimeEntry: AcpCapabilityCacheEntry = {
    cliType: 'builtin',
    agentType: 'kimi',
    cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
    provenance: 'runtime',
    sourceVersion: 'builtin-kimi:0.29.0',
    modes: [],
    models: [],
    configOptions: [],
    availableCommands: [],
    fetchedAt: 1,
  };

  function capabilities(
    entry: AcpCapabilityCacheEntry,
    targetConfig: typeof config = config
  ): MachineViewMeta['acpCapabilities'] {
    return { [getAcpCapabilityCacheKey(targetConfig.id)]: entry };
  }

  describe('resolveInitialOnboardingProviderStatus', () => {
    it('does not treat missing or static capabilities as verified', () => {
      expect(resolveInitialOnboardingProviderStatus(config, undefined)).toBe('untested');
      expect(
        resolveInitialOnboardingProviderStatus(
          config,
          capabilities({ ...runtimeEntry, provenance: undefined })
        )
      ).toBe('untested');
    });

    it('treats parsed runtime probes as verified across cache versions', () => {
      expect(resolveInitialOnboardingProviderStatus(config, capabilities(runtimeEntry))).toBe(
        'passed'
      );
      expect(
        resolveInitialOnboardingProviderStatus(
          config,
          capabilities({ ...runtimeEntry, cacheVersion: ACP_CAPABILITY_CACHE_VERSION - 1 })
        )
      ).toBe('passed');
    });
  });
});

describe('provider-test-state', () => {
  const configId = 'provider-1' as AgentConfigId;

  function progress(
    status: MachineAcpBinaryProgressMessage['status'],
    percent?: number
  ): MachineAcpBinaryProgressMessage {
    return {
      type: 'machine/acp-binary-progress',
      machineId: 'machine-1' as MachineId,
      agentType: 'kimi',
      status,
      percent,
    };
  }

  describe('providerTestActivityFromProgress', () => {
    it('does not present a runtime that already failed as still checking', () => {
      for (const status of ['error', 'unsupported-platform', 'incompatible-host'] as const) {
        expect(providerTestActivityFromProgress(progress(status))).toEqual({
          phase: 'runtime-failed',
        });
      }
    });
  });

  describe('createProviderTestRunRegistry', () => {
    it('detaches without aborting, so leaving the step does not cancel the work', () => {
      // Leaving the provider step must stop the screen committing a result it can
      // no longer show, and nothing more. The machine drops a refresh once its
      // last consumer leaves, so aborting here would make "continue" quietly mean
      // "abandon this agent" — the opposite of what the UI offers at that moment.
      const registry = createProviderTestRunRegistry();
      const detached = registry.start(configId);

      registry.detachAll();

      expect(detached.signal.aborted).toBe(false);
      expect(registry.isCurrent(configId, detached)).toBe(false);
      expect(registry.finish(configId, detached)).toBe(false);
    });
  });
});

describe('provider-setup-writer', () => {
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
        name: 'Bub',
        description: undefined,
        cliType: 'builtin',
        agentType: 'bub',
        env: {},
        prompt: '',
      };

      await store.set(cmdCreateProviderSetupAtom, config);

      expect(flockRowPut.mock.calls[0]).toEqual([
        flockDocId,
        machineFlockKeys.providerSetup(setupId),
        expect.objectContaining({
          id: setupId,
          machineId,
          status: 'queued',
          attempt: 1,
        }),
      ]);
      expect(store.get(getAllProviderSetupsAtom)).toEqual([
        expect.objectContaining({ id: setupId, status: 'queued', attempt: 1 }),
      ]);
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
      expect(flockRowDelete).not.toHaveBeenCalled();

      markerAccepted.resolve();
      await cancelPromise;

      expect(flockRowDelete.mock.calls).toEqual([
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
    });
  });
});
