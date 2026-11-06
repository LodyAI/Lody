// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROVIDER_SETUP_PROTOCOL_VERSION,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineId,
  type MachineViewMeta,
  type ProviderSetupTask,
} from '@lody/shared';
import { developerModeEnabledAtom, lodyAgentBetaEnabledAtom } from '../src/atoms/settings';
import { resolveLodyAgentState } from '../src/components/settings/lody-agent-setting';
import { useVisibleSettingsTabs } from '../src/components/settings/settings-tabs';
import { TestCloudPlatformProvider } from './test-platform';

const machineId = 'machine-a' as MachineId;
const otherMachineId = 'machine-b' as MachineId;

function machine(protocolCapabilities?: MachineViewMeta['protocolCapabilities']): MachineViewMeta {
  return {
    id: machineId,
    name: 'Workstation',
    cliVersion: '0.60.0',
    os: 'macOS',
    sessions: [],
    raceLimits: {},
    ...(protocolCapabilities ? { protocolCapabilities } : {}),
  } as MachineViewMeta;
}
const setupCapable = machine({ providerSetup: PROVIDER_SETUP_PROTOCOL_VERSION });

function config(id: string, overrides: Partial<AgentConfigMeta> = {}): AgentConfigMeta {
  return {
    id: id as AgentConfigId,
    machineId,
    name: 'Lody Agent',
    cliType: 'builtin',
    agentType: 'sorbet',
    ...overrides,
  } as AgentConfigMeta;
}
function setup(config: AgentConfigMeta): ProviderSetupTask {
  return {
    v: 1,
    id: config.id,
    machineId: config.machineId,
    config,
    status: 'running',
    attempt: 1,
    createdAt: 1,
    updatedAt: 1,
  } as ProviderSetupTask;
}

describe('resolveLodyAgentState', () => {
  it('uses the Lody Agent configured on the selected machine', () => {
    const state = resolveLodyAgentState({
      machine: setupCapable,
      configs: [
        config('claude', { agentType: 'claude' }),
        config('elsewhere', { machineId: otherMachineId }),
        config('sorbet-b'),
        config('sorbet-a'),
      ],
      setups: [],
    });
    expect(state).toMatchObject({ kind: 'ready', config: { id: 'sorbet-a' } });
  });

  it('shows an installation in progress before the config is published', () => {
    const queued = config('queued');
    const state = resolveLodyAgentState({
      machine: setupCapable,
      configs: [],
      setups: [setup(config('other', { machineId: otherMachineId })), setup(queued)],
    });
    expect(state).toMatchObject({ kind: 'setup', setup: { id: 'queued' } });
  });

  it('prefers the published config over a setup row that has not been cleared yet', () => {
    const published = config('published');
    expect(
      resolveLodyAgentState({
        machine: setupCapable,
        configs: [published],
        setups: [setup(published)],
      })
    ).toMatchObject({ kind: 'ready' });
  });

  it('offers setup only on a machine that can install it', () => {
    expect(resolveLodyAgentState({ machine: setupCapable, configs: [], setups: [] })).toEqual({
      kind: 'absent',
    });
    expect(resolveLodyAgentState({ machine: machine(), configs: [], setups: [] })).toEqual({
      kind: 'unsupported',
    });
  });
});

describe('Lody Agent settings entry', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('appears only while developer mode and the Lody Agent beta are both on', () => {
    const store = createStore();
    function Entries() {
      return <>{useVisibleSettingsTabs().map((tab) => `${tab.id} `)}</>;
    }
    const renderEntries = () =>
      act(() =>
        root.render(
          <TestCloudPlatformProvider>
            <Provider store={store}>
              <Entries />
            </Provider>
          </TestCloudPlatformProvider>
        )
      );
    renderEntries();
    expect(container.textContent).not.toContain('lody-agent');
    act(() => store.set(lodyAgentBetaEnabledAtom, true));
    renderEntries();
    expect(container.textContent).not.toContain('lody-agent');
    act(() => store.set(developerModeEnabledAtom, true));
    renderEntries();
    expect(container.textContent).toContain('lody-agent');
  });
});
