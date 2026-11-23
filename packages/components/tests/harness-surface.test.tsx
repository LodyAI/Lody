// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDefaultStore } from 'jotai';
import type {
  AcpCapabilityCacheEntry,
  AgentConfigMeta,
  WorkspaceMcpServerMeta,
} from '@lody/shared';

import { __agentConfigs } from '../src/atoms/agents';
import {
  ModelsPanel,
  PermissionsPanel,
  PluginsPanel,
  ProvidersPanel,
} from '../src/components/harness/panels';
import { getHarness, harness, type HarnessState } from '../src/components/harness/store';
import type { DeviceCapabilities } from '../src/components/harness/device-capabilities';

// The machine bridge is mocked at the boundary the panel reads: the resolved
// Sorbet target plus the ACP capability fold. The full <Harness/> surface —
// machine index, pairing sheet, settings chrome — is exercised by the shell's
// own consumers; this suite asserts the Models page's real-data mapping.
const capabilities = vi.hoisted(() => ({
  current: { status: 'ready', models: [] } as DeviceCapabilities,
}));
vi.mock('../src/components/harness/device-capabilities', () => ({
  useDeviceCapabilities: () => capabilities.current,
}));

const machine = vi.hoisted(() => ({
  supportsEdit: true,
  discovered: [] as Array<{
    selector: string;
    providerId: string;
    modelId: string;
    displayName: string;
  }>,
}));
vi.mock('../src/components/harness/sorbet', () => ({
  useSorbetTarget: () => null,
  useHarnessMachine: () => ({ machine: { id: 'machine-a' } }),
  supportsSorbetEndpointEdit: () => machine.supportsEdit,
  sorbet: {
    refresh: async (providerId?: string) => {
      const state = getHarness();
      harness.applyRemote({
        credentials: state.credentials,
        customs: state.customs,
        status: 'ready',
        models: machine.discovered.filter(
          (model) => !providerId || model.providerId === providerId
        ),
      });
    },
    updateEndpoint: async (
      providerId: string,
      endpoint: Pick<HarnessState['customs'][number], 'name' | 'protocol' | 'baseUrl'>
    ) => {
      const state = getHarness();
      harness.applyRemote({
        credentials: state.credentials,
        models: state.models,
        status: 'ready',
        customs: state.customs.map((custom) =>
          custom.id === providerId ? { ...custom, ...endpoint } : custom
        ),
      });
    },
  },
}));

vi.mock('../src/atoms/agents', async () => {
  const { atom } = await import('jotai');
  const __agentConfigs = atom<AgentConfigMeta[]>([]);
  return {
    __agentConfigs,
    getAllAgentConfigAtom: atom((get) => get(__agentConfigs)),
    cmdUpdateAgentConfigAtom: atom(null, (get, set, config: AgentConfigMeta) => {
      set(
        __agentConfigs,
        get(__agentConfigs).map((row) => (row.id === config.id ? config : row))
      );
    }),
  };
});
const reprobed = vi.hoisted(() => [] as string[]);
vi.mock('../src/hooks/use-refresh-machine-acp-capabilities', () => ({
  useRefreshMachineAcpCapabilities: () => async (args: { machineId: string }) => {
    reprobed.push(args.machineId);
    return { success: true };
  },
}));
vi.mock('../src/components/harness/machines', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/components/harness/machines')>()),
  useActiveDevice: () => ({
    device: { id: 'machine-a', name: 'MyMac', kind: 'laptop', status: 'online' },
    devices: [],
  }),
}));
const mcp = vi.hoisted(() => ({ servers: [] as WorkspaceMcpServerMeta[] }));
vi.mock('../src/hooks/use-workspace-mcp-catalog', () => ({
  useWorkspaceMcpCatalog: () => ({ servers: mcp.servers, synced: true }),
  useWorkspaceMcpCatalogActions: () => ({
    upsert: async (entry: WorkspaceMcpServerMeta) => {
      mcp.servers = mcp.servers.map((server) => (server.id === entry.id ? entry : server));
    },
    remove: async () => {},
  }),
}));

const lodyAgent = (machineId: string): AgentConfigMeta =>
  ({
    id: `sorbet-${machineId}`,
    machineId,
    name: 'Lody Agent',
    description: undefined,
    cliType: 'builtin',
    agentType: 'sorbet',
    env: {},
  }) as AgentConfigMeta;
const configs = () => getDefaultStore().get(__agentConfigs);
const defaultsOn = (machineId: string) =>
  configs().find((config) => config.machineId === machineId)?.sessionDefaults;

const sorbetEntry = (overrides: Partial<AcpCapabilityCacheEntry>): AcpCapabilityCacheEntry => ({
  cliType: 'builtin',
  agentType: 'sorbet',
  modes: [],
  models: [],
  fetchedAt: 0,
  ...overrides,
});

const withCapabilities = (current: DeviceCapabilities) => {
  capabilities.current = current;
};

/**
 * The Models page draws what the agent's capability probe advertised — the
 * model pool, its group names and the effort ladder — never the drawn
 * catalogue. A page that fell back to `MODELS`, or drew a three-rung ladder
 * the agent does not offer, is what these cases exist to catch.
 */
// jsdom has no layout, and the surface measures the group its selection pill
// travels in. The observer only has to exist here; nothing is laid out.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (!('ResizeObserver' in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
}

describe('harness models page', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    harness.reset();
    getDefaultStore().set(__agentConfigs, [lodyAgent('machine-a'), lodyAgent('machine-b')]);
    reprobed.length = 0;
    capabilities.current = { status: 'ready', models: [] };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = () =>
    act(async () => {
      root.render(<ModelsPanel scope="profile" />);
    });

  it('draws the Models page from the probe, not the catalogue', async () => {
    withCapabilities({
      status: 'ready',
      capability: sorbetEntry({}),
      models: [
        { id: 'anthropic/claude-fable-5', name: 'Claude Fable 5', meta: '200K' },
        { id: 'gateway/meridian-2', name: 'Meridian 2', group: 'Gateway' },
      ],
      modelOption: undefined,
      effortOption: {
        id: 'reasoning_effort',
        name: 'Reasoning effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'high',
        options: [
          { value: 'minimal', name: 'Minimal' },
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
          { value: 'xhigh', name: 'Extra high' },
        ],
      },
    });
    await render();

    // Both model selects read the capability fold — and the effort Segmented
    // shows the agent's own ladder with its current rung selected, not the
    // catalogue's Low/Medium/High. The list stays closed, so the names ride
    // in the hidden listbox markup; the trigger's value text resolves them.
    const combobox = container.querySelector('[role="combobox"]') as HTMLElement;
    expect(combobox).toBeTruthy();
    await act(async () => {
      combobox.click();
    });
    const names = [...document.querySelectorAll('[role="listbox"] [role="option"]')].map(
      (el) => el.textContent
    );
    expect(names.join('\n')).toContain('Claude Fable 5');
    expect(names).toContain('Meridian 2');
    // Group labels come from the option's own `group`, not a provider guess.
    expect(document.body.textContent).toContain('Gateway');
    const effort = [...container.querySelectorAll('[role="radio"]')].map((el) => el.textContent);
    expect(effort).toEqual(['Minimal', 'Low', 'High', 'Extra high']);
    expect(
      [...container.querySelectorAll('[role="radio"]')]
        .find((el) => el.textContent === 'High')
        ?.getAttribute('aria-checked')
    ).toBe('true');
    expect(container.textContent).not.toContain('DeepSeek Reasoner');
  });

  it('makes the picked model and effort what new conversations start with on every device', async () => {
    withCapabilities({
      status: 'ready',
      capability: sorbetEntry({}),
      models: [
        { id: 'anthropic/claude-fable-5', name: 'Claude Fable 5' },
        { id: 'gateway/meridian-2', name: 'Meridian 2' },
      ],
      modelOption: {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'anthropic/claude-fable-5',
        options: [],
      },
      effortOption: {
        id: 'thought_level',
        name: 'Thinking',
        category: 'thought_level',
        type: 'select',
        currentValue: 'low',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
        ],
      },
    });
    await render();

    expect(
      [...container.querySelectorAll('[role="radio"]')]
        .find((el) => el.textContent === 'Low')
        ?.getAttribute('aria-checked')
    ).toBe('true');

    await act(async () => {
      (container.querySelector('[role="combobox"]') as HTMLElement).click();
    });
    await act(async () => {
      const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((el) =>
        el.textContent?.includes('Meridian 2')
      )!;
      option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      option.click();
    });
    await act(async () => {
      (
        [...container.querySelectorAll('[role="radio"]')].find(
          (el) => el.textContent === 'High'
        ) as HTMLElement
      ).click();
    });

    for (const machineId of ['machine-a', 'machine-b']) {
      expect(defaultsOn(machineId)).toEqual({
        configOptionValues: { model: 'gateway/meridian-2', thought_level: 'high' },
      });
    }
    expect(new Set(reprobed)).toEqual(new Set(['machine-a', 'machine-b']));
  });

  it('keeps Lody Agent settings it cannot apply visible but disabled', async () => {
    withCapabilities({
      status: 'ready',
      capability: sorbetEntry({}),
      models: [{ id: 'anthropic/claude-fable-5', name: 'Claude Fable 5' }],
      modelOption: undefined,
      effortOption: undefined,
    });
    await render();
    expect(container.textContent).toContain('Subagent model');
    expect(container.textContent).toContain('Fallback');
    expect(container.textContent).toContain('Not supported by Lody Agent yet');
    await act(async () => {
      (container.querySelector('[aria-label="Fallback"]') as HTMLElement).click();
    });
    expect(defaultsOn('machine-a')).toBeUndefined();
    expect(defaultsOn('machine-b')).toBeUndefined();
  });

  it('disables the effort ladder when the agent advertises none', async () => {
    withCapabilities({
      status: 'ready',
      capability: sorbetEntry({}),
      models: [{ id: 'anthropic/claude-fable-5', name: 'Claude Fable 5' }],
      modelOption: undefined,
      effortOption: undefined,
    });
    await render();

    const group = container.querySelector('[role="radiogroup"]');
    expect(group?.getAttribute('aria-disabled')).toBe('true');
    expect(container.textContent).toContain('Not advertised by this agent');
    for (const button of container.querySelectorAll('[role="radio"]')) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('says what it can when the agent advertises no models', async () => {
    withCapabilities({
      status: 'ready',
      capability: sorbetEntry({}),
      models: [],
      modelOption: undefined,
      effortOption: undefined,
    });
    await render();

    expect(container.textContent).toContain('Connect a provider first');
  });
});

describe('harness providers page: custom endpoints', () => {
  let container: HTMLDivElement;
  let root: Root;

  const gateway = {
    id: 'gateway',
    name: 'Magpie Gateway',
    protocol: 'openai-responses' as const,
    baseUrl: 'http://127.0.0.1:3425',
    models: [],
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    harness.reset();
    machine.supportsEdit = true;
    machine.discovered = [
      { selector: 'gateway/m-1', providerId: 'gateway', modelId: 'm-1', displayName: 'Meridian 1' },
      { selector: 'other/x', providerId: 'other', modelId: 'x', displayName: 'Other X' },
    ];
    harness.applyRemote({
      credentials: {
        gateway: { provider: 'gateway', method: 'key', account: 'API key', addedAt: 0 },
      },
      customs: [gateway],
      models: [],
      status: 'ready',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = () =>
    act(async () => {
      root.render(<ProvidersPanel />);
    });
  const button = (label: string) =>
    container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;

  it('lists the models Sorbet discovered for the endpoint after a refresh', async () => {
    await render();
    expect(container.textContent).toContain('No models discovered yet');

    await act(async () => {
      button('Refresh models for Magpie Gateway')!.click();
    });

    expect(container.textContent).toContain('Meridian 1');
    expect(container.textContent).not.toContain('Other X');
  });

  it('edits the endpoint in place', async () => {
    await render();
    await act(async () => {
      button('Edit Magpie Gateway')!.click();
    });
    const name = container.querySelector(
      'input[placeholder="Company gateway"]'
    ) as HTMLInputElement;
    expect(name.value).toBe('Magpie Gateway');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(name, 'Team Gateway');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector('form') as HTMLFormElement).requestSubmit();
    });

    expect(getHarness().customs[0]?.name).toBe('Team Gateway');
    expect(container.textContent).toContain('Team Gateway');
    expect(container.querySelector('form')).toBeNull();
  });

  it('offers no edit on a daemon without endpoint updates', async () => {
    machine.supportsEdit = false;
    await render();
    expect(button('Edit Magpie Gateway')).toBeNull();
    expect(button('Refresh models for Magpie Gateway')).not.toBeNull();
  });
});

describe('harness permissions and plugins pages', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    harness.reset();
    getDefaultStore().set(__agentConfigs, [lodyAgent('machine-a'), lodyAgent('machine-b')]);
    reprobed.length = 0;
    capabilities.current = {
      status: 'ready',
      models: [],
      modelOption: undefined,
      effortOption: undefined,
      capability: sorbetEntry({
        configOptions: [
          {
            id: 'permission_mode',
            name: 'Permissions',
            type: 'select',
            currentValue: 'ask',
            options: [
              { value: 'ask', name: 'Ask' },
              { value: 'full-access', name: 'Full access' },
            ],
          },
        ],
      }),
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const card = (title: string) =>
    [...container.querySelectorAll('[role="radio"]')].find((el) =>
      el.textContent?.includes(title)
    ) as HTMLButtonElement;

  it('sets one device to full access without touching the others', async () => {
    await act(async () => {
      root.render(<PermissionsPanel scope={{ device: 'machine-a' }} />);
    });
    expect(card('Ask first').getAttribute('aria-checked')).toBe('true');
    expect(card('Automatic review').disabled).toBe(true);

    await act(async () => {
      card('Full access').click();
    });

    expect(defaultsOn('machine-a')).toEqual({
      configOptionValues: { permission_mode: 'full-access' },
    });
    expect(defaultsOn('machine-b')).toBeUndefined();
    expect(reprobed).toEqual(['machine-a']);
    expect(card('Full access').getAttribute('aria-checked')).toBe('true');
    for (const chip of container.querySelectorAll('[aria-pressed]'))
      expect((chip as HTMLButtonElement).disabled).toBe(true);
  });

  it('attaches a workspace MCP server to new conversations by default', async () => {
    mcp.servers = [
      {
        id: 'github' as WorkspaceMcpServerMeta['id'],
        name: 'GitHub',
        transport: 'http',
        description: 'Issues and pull requests',
        enabledByDefault: false,
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    await act(async () => {
      root.render(<PluginsPanel />);
    });
    expect(container.textContent).toContain('Issues and pull requests');
    expect(container.textContent).not.toContain('Repo map');

    await act(async () => {
      (container.querySelector('[aria-label="Attach GitHub by default"]') as HTMLElement).click();
    });
    expect(mcp.servers[0]?.enabledByDefault).toBe(true);
  });
});
