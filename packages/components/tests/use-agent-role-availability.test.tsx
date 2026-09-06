// @vitest-environment jsdom

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore, type Store } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACP_CAPABILITY_CACHE_VERSION,
  CURSOR_PARAMETERIZED_MODEL_PICKER_SOURCE_VERSION_SUFFIX,
  getAcpCapabilityCacheKey,
  getLodyMachinePresenceKey,
  machineFlockKeys,
  selectMentionableAgentRoles,
  serializeMachineFlockKey,
  type AcpCapabilityCacheEntry,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleAvailability,
  type AgentRoleId,
  type LodyPresenceInstanceId,
  type MachineId,
  type MachineViewMeta,
  type WorkspaceId,
} from '@lody/shared';

const visibleMachines = vi.hoisted(() => ({ machines: new Map<MachineId, MachineViewMeta>() }));

vi.mock('../src/hooks/use-visible-machine-metas', () => ({
  useVisibleMachineMetas: () => visibleMachines,
}));
// Flock subscription is an I/O boundary; publish its snapshots into the real atoms below.
vi.mock('../src/hooks/use-machine-flock-agent-configs', () => ({
  useMachineFlockAgentConfigsForMachineIds: () => {},
}));

import { setMachineFlockRowsForMachineAtom } from '../src/atoms/machine-flock';
import { lodyPresenceNowMsAtom, lodyPresenceStatesAtom } from '../src/atoms/presence';
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import { useAgentRoleAvailability } from '../src/hooks/use-workspace-agent-roles';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const machineId = 'cursor-machine' as MachineId;
const workspaceId = 'role-workspace' as WorkspaceId;
const configId = 'cursor-config' as AgentConfigId;
const currentModelId = 'model-b';
const legacyModelId = 'model-b-legacy-variant';
const now = 1_000;
const agentConfig: AgentConfigMeta = {
  id: configId,
  machineId,
  name: 'Cursor',
  cliType: 'registry',
  agentType: 'cursor',
  env: {},
  prompt: '',
};

const capability = (): AcpCapabilityCacheEntry => ({
  cliType: 'registry',
  agentType: 'cursor',
  cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
  sourceVersion: `synthetic-cursor${CURSOR_PARAMETERIZED_MODEL_PICKER_SOURCE_VERSION_SUFFIX}`,
  provenance: 'runtime',
  models: [{ modelId: currentModelId, name: 'Model B' }],
  modes: [],
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      category: 'model',
      currentValue: currentModelId,
      options: [{ value: currentModelId, name: 'Model B' }],
    },
  ],
  fetchedAt: now,
});

const role = (runConfig: AgentRole['runConfig']): AgentRole => ({
  v: 1,
  id: 'cursor-role' as AgentRoleId,
  revision: 1,
  name: 'Cursor reviewer',
  visibility: 'private',
  ownerUserId: 'role-owner',
  machineId,
  agentConfigId: configId,
  runConfig,
  createdAt: now,
  updatedAt: now,
});

type Snapshot = { availability: AgentRoleAvailability; mentionableIds: AgentRoleId[] };

describe('useAgentRoleAvailability', () => {
  let root: Root;
  let container: HTMLDivElement;
  let store: Store;
  let snapshot: Snapshot | undefined;

  function Harness({ role: selectedRole }: { role: AgentRole }) {
    const { resolve } = useAgentRoleAvailability([selectedRole]);
    useEffect(() => {
      snapshot = {
        availability: resolve(selectedRole),
        mentionableIds: selectMentionableAgentRoles([selectedRole], {
          currentUserId: selectedRole.ownerUserId,
          scope: { kind: 'machine', machineId },
          getAvailability: resolve,
        }).map((item) => item.id),
      };
    }, [resolve, selectedRole]);
    return null;
  }

  function publishCapability(entry?: AcpCapabilityCacheEntry) {
    visibleMachines.machines = new Map([
      [
        machineId,
        {
          id: machineId,
          name: 'Cursor machine',
          cliVersion: '0.0.0',
          os: 'linux',
          sessions: [],
          raceLimits: {},
          acpCapabilities: entry ? { [getAcpCapabilityCacheKey(configId)]: entry } : {},
        },
      ],
    ]);
  }

  async function publishAgentConfig() {
    const key = machineFlockKeys.agentConfig(configId);
    await act(async () => {
      store.set(setMachineFlockRowsForMachineAtom, {
        workspaceId,
        machineId,
        rows: { [serializeMachineFlockKey(key)]: { key, value: agentConfig } },
      });
    });
  }

  async function render(selectedRole: AgentRole) {
    await act(async () => {
      root.render(
        <Provider store={store}>
          <Harness role={selectedRole} />
        </Provider>
      );
    });
  }

  beforeEach(() => {
    snapshot = undefined;
    store = createStore();
    store.set(runtimeAtom, { workspaceId, workspaceSlug: 'role-workspace' } as WorkspaceRuntime);
    store.set(lodyPresenceNowMsAtom, now);
    const instanceId = 'cursor-instance' as LodyPresenceInstanceId;
    store.set(lodyPresenceStatesAtom, {
      [getLodyMachinePresenceKey(machineId, instanceId)]: {
        kind: 'machine',
        machineId,
        instanceId,
        updatedAt: now,
      },
    });
    publishCapability();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it.each(['modelId', 'configOptionValues'] as const)(
    'withholds a legacy Cursor Role stored through %s until its owner selects an advertised model',
    async (channel) => {
      const selection = (modelId: string): AgentRole['runConfig'] =>
        channel === 'modelId' ? { modelId } : { configOptionValues: { model: modelId } };
      const savedRole = role(selection(legacyModelId));

      await render(savedRole);
      expect(snapshot).toEqual({ availability: { kind: 'unknown' }, mentionableIds: [] });

      await publishAgentConfig();
      expect(snapshot).toEqual({ availability: { kind: 'unknown' }, mentionableIds: [] });

      publishCapability(capability());
      await render(savedRole);
      expect(snapshot).toEqual({
        availability: { kind: 'unavailable', reason: 'model_unsupported' },
        mentionableIds: [],
      });

      await render({ ...savedRole, revision: 2, runConfig: selection(currentModelId) });
      expect(snapshot).toEqual({
        availability: { kind: 'available' },
        mentionableIds: [savedRole.id],
      });
      expect(savedRole.runConfig).toEqual(selection(legacyModelId));
    }
  );

  it('keeps an expired capability cache unknown until a current snapshot arrives', async () => {
    const savedRole = role({ modelId: currentModelId });
    await publishAgentConfig();
    publishCapability({ ...capability(), cacheVersion: ACP_CAPABILITY_CACHE_VERSION - 1 });
    await render(savedRole);
    expect(snapshot).toEqual({ availability: { kind: 'unknown' }, mentionableIds: [] });

    publishCapability(capability());
    await render(savedRole);
    expect(snapshot).toEqual({
      availability: { kind: 'available' },
      mentionableIds: [savedRole.id],
    });
  });
});
