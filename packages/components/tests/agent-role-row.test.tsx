// @vitest-environment jsdom
import { act, createElement, useState, type ComponentProps } from 'react';
import { Provider, createStore } from 'jotai';
import { Flock } from '@loro-dev/flock-wasm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  AGENT_ROLE_VERSION,
  createLegacyWorkspaceCatalogCommands,
  workspaceFlockKeys,
  type WorkspaceId,
  type MachineCatalogSettingsPort,
  type MachineMeta,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleId,
  type MachineId,
} from '@lody/shared';

const nativeMachines = vi.hoisted(() => ({ machines: new Map<MachineId, MachineMeta>() }));
vi.mock('../src/hooks/use-visible-machine-metas', () => ({
  useVisibleMachineMetas: () => nativeMachines,
}));
vi.mock('../src/components/settings/memory-setting', () => ({ RoleMemoryPicker: () => null }));

import {
  AgentRoleEditorDialog,
  openAgentRoleEditorForCreate,
  type AgentRoleEditorState,
} from '../src/components/settings/agent-role-editor-dialog';
import { createAgentRoleFormValue } from '../src/lib/agent-role-form';
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import { userAtom } from '../src/atoms';
import { setWorkspaceContextAtom } from '../src/atoms/workspace-context';
import { getAllAgentConfigAtom, getAllAgentConfigListAtom } from '../src/atoms/agents';
import { nativeMachineCatalogSettingsAtom } from '../src/atoms/native-machine-catalog';
import { AgentRoleRow } from '../src/components/settings/agent-roles-setting';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const role: AgentRole = {
  v: AGENT_ROLE_VERSION,
  id: 'role-1' as AgentRoleId,
  ownerUserId: 'user-1',
  visibility: 'private',
  name: 'Code Reviewer',
  emoji: '🔍',
  machineId: 'machine-1' as MachineId,
  agentConfigId: 'config-1' as AgentConfigId,
  runConfig: { modelId: 'gpt-5.6-sol', configOptionValues: { thought_level: 'high' } },
  revision: 2,
  createdAt: 1,
  updatedAt: 2,
};

type RowProps = ComponentProps<typeof AgentRoleRow>;
type RowTarget = RowProps['targets'][number];

const agentConfig: Pick<AgentConfigMeta, 'cliType' | 'agentType' | 'brandId' | 'env' | 'name'> = {
  cliType: 'builtin',
  agentType: 'codex',
  env: {},
  name: 'Codex',
};

const target = (overrides: Partial<RowTarget> = {}): RowTarget => ({
  machineId: 'machine-1' as MachineId,
  label: 'MacBook',
  online: true,
  availability: { kind: 'available' },
  runConfig: role.runConfig,
  agentConfig,
  ...overrides,
});

const linux = target({ machineId: 'machine-2' as MachineId, label: 'Linux box', online: false });

const baseProps: RowProps = {
  role,
  targets: [target()],
  canManage: true,
  onEdit: () => undefined,
  onRemove: () => undefined,
};

describe('AgentRoleRow', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    nativeMachines.machines.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = undefined;
    }
    container?.remove();
    container = undefined;
  });

  const render = async (props: Partial<RowProps> = {}): Promise<HTMLDivElement> => {
    await act(async () => {
      root?.render(createElement(AgentRoleRow, { ...baseProps, ...props }));
    });
    return container as HTMLDivElement;
  };

  it('selects a native summary in the real Role editor and durably saves only its config id and public pins', async () => {
    const store = createStore();
    const workspaceId = 'lw_role_summary' as WorkspaceId;
    const machineId = 'machine-native' as MachineId;
    const configId = 'config-native' as AgentConfigId;
    const summary = {
      id: configId,
      machineId,
      name: 'Node-owned custom Agent',
      cliType: 'custom' as const,
      agentType: 'custom-native',
    };
    const machine = {
      id: machineId,
      name: 'Native machine',
      userId: 'user-1',
      cliVersion: '0.0.0',
      os: 'macos',
      sessions: [],
    } as MachineMeta;
    nativeMachines.machines.set(machineId, machine);
    const settings: MachineCatalogSettingsPort = {
      binding: { accountId: 'user-1', workspaceId },
      generation: 'native-generation',
      agents: [summary],
      setups: [],
      editor: () => {
        throw new Error('Role editor must not load private Agent editor');
      },
      execute: async () => {
        throw new Error('Role creation must not edit the Agent catalog');
      },
    };
    const flock = new Flock('role-native-summary');
    const commands = createLegacyWorkspaceCatalogCommands({
      binding: { accountId: 'user-1', workspaceId },
      put: async (key, value) => {
        flock.set(key, value);
        flock.commit();
      },
      remove: async (key) => {
        flock.delete(key);
        flock.commit();
      },
      upload: async () => {},
    });
    const snapshot = {
      synced: true,
      generation: 'native-generation',
      projection: {
        agents: [summary],
        acp: [
          {
            configId,
            cliType: summary.cliType,
            agentType: summary.agentType,
            publicCapability: {
              cliType: summary.cliType,
              agentType: summary.agentType,
              authority: 'authoritative',
              canValidateRolePins: true,
              models: [{ modelId: 'native-model', name: 'Node public model' }],
              modes: [],
            },
          },
        ],
      },
    };
    const runtime = {
      workspaceId,
      workspaceSlug: 'native-summary',
      accountId: 'user-1',
      workspaceCatalogCommands: commands,
      ownsNativeMachineCatalog: () => true,
      nativeMachineCatalogSource: { readProjection: () => snapshot },
      repo: {
        openFlockDoc: async () => {
          throw new Error('Role must not reopen old MF/Meta Flock');
        },
      },
      writer: {
        flockRowPut: async () => {
          throw new Error('Role must use its domain command');
        },
      },
    } as unknown as WorkspaceRuntime;
    store.set(setWorkspaceContextAtom, { workspaceId, slug: 'native-summary' });
    store.set(runtimeAtom, runtime);
    store.set(userAtom, { id: 'user-1', name: 'Synthetic', email: 'synthetic@example.test' });
    store.set(nativeMachineCatalogSettingsAtom, settings);
    expect(store.get(getAllAgentConfigAtom)).toEqual([]);
    expect(store.get(getAllAgentConfigListAtom)).toEqual([summary]);
    let saved: AgentRole | undefined;
    function Harness() {
      const value = createAgentRoleFormValue(machineId);
      value.name = 'Native summary reviewer';
      const [editor, setEditor] = useState<AgentRoleEditorState | null>(() =>
        openAgentRoleEditorForCreate(value)
      );
      return createElement(AgentRoleEditorDialog, {
        editor,
        accessibleRoles: [],
        onChange: setEditor,
        onClose: () => setEditor(null),
        onSaved: (role) => {
          saved = role;
        },
        source: 'settings',
      });
    }
    await act(async () => {
      root!.render(createElement(Provider, { store }, createElement(Harness)));
    });
    const config = document.querySelector<HTMLButtonElement>(
      '[role="combobox"][aria-label="Agent config"]'
    );
    expect(config).not.toBeNull();
    expect(config!.disabled).toBe(false);
    await act(async () => {
      config!.click();
    });
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (node) => node.textContent === summary.name
    );
    expect(option).toBeDefined();
    await act(async () => {
      option!.click();
    });
    expect(config!.textContent).toContain(summary.name);
    expect(document.body.textContent).toContain('Node public model');
    const model = document.querySelector<HTMLButtonElement>(
      '[role="combobox"][aria-label="Model"]'
    );
    expect(model).not.toBeNull();
    await act(async () => {
      model!.click();
    });
    const modelOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (node) => node.textContent === 'Node public model'
    );
    expect(modelOption).toBeDefined();
    await act(async () => {
      modelOption!.click();
    });
    const save = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === 'Create role'
    );
    expect(save).toBeDefined();
    await act(async () => {
      save!.click();
    });
    expect(saved?.agentConfigId).toBe(configId);
    expect(saved?.machineId).toBe(machineId);
    expect(saved?.runConfig.configOptionValues?.model).toBe('native-model');
    expect(flock.get(workspaceFlockKeys.agentRole(saved!.id))).toMatchObject({
      agentConfigId: configId,
      machineId,
    });
    expect(JSON.stringify(saved)).not.toMatch(/customAcp|runtimeOverrides|sourceVersion|env/);
  });

  it('renders advertised labels for encoded model IDs and pinned options', async () => {
    const modelId = 'dsh-route:WyJzeW50aGV0aWMiLCJtb2RlbCJd';
    const runConfig = {
      modelId,
      modeId: 'agent-full-access',
      configOptionValues: { thought_level: 'high', fast_mode: true, disabled: false },
    };
    const selectorOptions: NonNullable<RowTarget['selectorOptions']> = {
      modelOptions: [{ value: modelId, label: 'Example Model' }],
      modeOptions: [{ value: 'agent-full-access', label: 'Full access' }],
      configOptionSelectors: [
        {
          type: 'select',
          configId: 'thought_level',
          label: 'Reasoning',
          currentValue: 'low',
          options: [
            { value: 'high', label: 'High' },
            { value: 'low', label: 'Low' },
          ],
        },
        {
          type: 'boolean',
          configId: 'fast_mode',
          label: 'Fast mode',
          currentValue: false,
          options: [],
        },
      ],
    };
    const view = await render({ targets: [target({ runConfig, selectorOptions })] });
    expect(view.textContent).toContain('Example Model · High · Full access · Fast mode');
    expect(view.textContent).not.toContain(modelId);
    expect(view.textContent).not.toContain('disabled');
    expect(runConfig.modelId).toBe(modelId);

    // Capability loss preserves the saved pins instead of substituting defaults.
    await render({ targets: [target({ runConfig })] });
    expect(view.textContent).toContain(modelId);
    expect(view.textContent).toContain('agent-full-access');
  });

  it('does not collapse different model IDs that share a display name', async () => {
    const selectorOptions = {
      modelOptions: [
        { value: 'route-a/model', label: 'Example Model' },
        { value: 'route-b/model', label: 'Example Model' },
      ],
      modeOptions: [],
      configOptionSelectors: [],
    };
    const view = await render({
      targets: [
        target({ runConfig: { modelId: 'route-a/model' }, selectorOptions }),
        target({ ...linux, runConfig: { modelId: 'route-b/model' }, selectorOptions }),
      ],
    });
    expect(view.textContent).toContain('Configured per machine');
    expect(view.textContent).not.toContain('Example Model');
  });

  it('names a reason about the binding, and leaves the machine to its dot', async () => {
    const missing = await render({
      targets: [
        target({
          availability: { kind: 'unavailable', reason: 'agent_config_missing' },
          agentConfig: undefined,
        }),
      ],
    });
    expect(missing.textContent).toContain('its agent config no longer exists');
    // Still listed and still editable: nothing was substituted for it.
    expect(missing.querySelector('button[aria-label="Edit"]')).not.toBeNull();

    // The machine's dot already carries its status; saying it again is noise.
    const offline = await render({
      targets: [
        target({ online: false, availability: { kind: 'unavailable', reason: 'machine_offline' } }),
      ],
    });
    expect(offline.textContent).not.toContain('Unavailable');
    expect(offline.textContent).toContain('offline');
    expect(offline.querySelector('button[aria-label="Edit"]')).not.toBeNull();
  });

  it('says it is still checking rather than claiming a role is broken', async () => {
    const view = await render({ targets: [target({ availability: { kind: 'unknown' } })] });
    expect(view.textContent).toContain('Checking availability');
    expect(view.textContent).not.toContain('Unavailable');
  });

  it('offers no delete for a role owned by another member', async () => {
    const view = await render({
      role: { ...role, ownerUserId: 'user-2', visibility: 'workspace' },
      canManage: false,
    });
    expect(view.textContent).toContain('Workspace');
    expect(view.querySelector('button[aria-label="Remove"]')).toBeNull();
  });

  it('says the role is configured per machine instead of picking one summary', async () => {
    const view = await render({
      targets: [target(), { ...linux, runConfig: { modelId: 'luna' } }],
    });
    expect(view.textContent).toContain('Configured per machine');
    expect(view.textContent).not.toContain('gpt-5.6-sol');
  });
});
