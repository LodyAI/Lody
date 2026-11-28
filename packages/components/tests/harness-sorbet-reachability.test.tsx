// @vitest-environment jsdom
/**
 * A machine publishes the Sorbet store capabilities from its own daemon and the
 * `Remote` pair only from an encrypted workspace. A browser in a plaintext
 * workspace therefore sees a current daemon that serves nobody but itself, which
 * is neither an old daemon nor an empty machine.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDefaultStore } from 'jotai';
import type { AgentConfigMeta, AgentConfigId, MachineId, MachineViewMeta } from '@lody/shared';

import { localMachineIdAtom } from '../src/atoms/local-probe';
import { activeWorkspaceRuntimeAtom } from '../src/atoms/runtime';
import { Setup } from '../src/components/harness/setup';
import { ModelsPanel, ProvidersPanel } from '../src/components/harness/panels';
import { SorbetBridge, sorbetStoreAccess } from '../src/components/harness/sorbet';
import { getHarness, harness } from '../src/components/harness/store';

const machineId = 'e20474f8-cbe8-4541-836c-0dd97332bd46' as MachineId;
const otherMachineId = 'other-machine' as MachineId;

/** Local-only store capabilities: what a current daemon publishes in a plaintext workspace. */
const PLAINTEXT_DAEMON = { sorbetCredentials: 1, sorbetProviders: 3, sorbetHostSettings: 1 };
/** The same daemon in an encrypted workspace. */
const ENCRYPTED_DAEMON = {
  ...PLAINTEXT_DAEMON,
  sorbetCredentialsRemote: 1,
  sorbetProvidersRemote: 3,
  sorbetHostSettingsRemote: 1,
};

function machine(overrides: Partial<MachineViewMeta> = {}): MachineViewMeta {
  return {
    id: machineId,
    name: 'MyMac',
    cliVersion: '0.60.0',
    os: 'darwin',
    sessions: [],
    raceLimits: {},
    protocolCapabilities: PLAINTEXT_DAEMON,
    ...overrides,
  } as MachineViewMeta;
}

const lodyAgent = {
  id: 'sorbet-config' as AgentConfigId,
  machineId,
  name: 'Lody Agent',
  description: undefined,
  cliType: 'builtin',
  agentType: 'sorbet',
  env: {},
} as AgentConfigMeta;

/**
 * The bridge's boundary: the active runtime's Sorbet RPCs, the machine index
 * and the local-machine identity. Everything above them — the store, the status
 * decisions, the panels — is the real code under test. Both atoms stay writable
 * for the whole file: a derived one would cache the first answer here.
 */
const mounted = vi.hoisted(() => ({
  machine: null as unknown,
  calls: [] as string[],
  configs: [] as unknown[],
}));

const runtime = {
  requestLocalSorbetCredentials: async (_machineId: string, request: { method: string }) => {
    mounted.calls.push(request.method);
    return {
      type: 'sorbet/credentials-list',
      credentials: [{ providerId: 'anthropic', type: 'oauth' }],
    };
  },
  requestLocalSorbetProviders: async (_machineId: string, request: { method: string }) => {
    mounted.calls.push(request.method);
    if (request.method === 'sorbet/providers-list') {
      return {
        type: 'sorbet/providers-list',
        providers: [
          {
            id: 'gateway',
            name: 'Acme Gateway',
            protocol: 'openai-completions',
            baseUrl: 'https://gateway.example.com/v1',
            models: [],
          },
        ],
      };
    }
    return { type: 'sorbet/models-list', models: [] };
  },
  requestLocalSorbetHostSettings: async () => {
    mounted.calls.push('sorbet/host-settings-get');
    return { type: 'sorbet/host-settings-get', settings: {} };
  },
};

vi.mock('@/atoms/runtime', async (importOriginal) => {
  const { atom } = await import('jotai');
  return {
    ...(await importOriginal<typeof import('../src/atoms/runtime')>()),
    activeWorkspaceRuntimeAtom: atom(null as unknown),
  };
});

vi.mock('@/atoms/local-probe', async (importOriginal) => {
  const { atom } = await import('jotai');
  return {
    ...(await importOriginal<typeof import('../src/atoms/local-probe')>()),
    localMachineIdAtom: atom(null as string | null),
  };
});

vi.mock('@/components/harness/machines', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/components/harness/machines')>()),
  useHarnessDevices: () => ({
    devices: [],
    machines: new Map([[machineId, mounted.machine]]),
    activeDevice: machineId,
    select: () => {},
    isLoading: false,
  }),
  useActiveDevice: () => ({
    device: { id: machineId, name: 'MyMac', kind: 'laptop', status: 'online' },
    devices: [],
  }),
}));

vi.mock('@/hooks/use-machine-flock-agent-configs', () => ({
  useMachineFlockAgentConfigsForMachineIds: () => {},
}));

/** One stable atom per read: a fresh atom would resubscribe on every render. */
vi.mock('@/atoms/agents', async () => {
  const { atom } = await import('jotai');
  const configs = atom(() => mounted.configs);
  return {
    getAgentConfigsByMachineAtomFamily: () => configs,
    getAllAgentConfigAtom: configs,
    cmdUpdateAgentConfigAtom: atom(null),
  };
});

vi.mock('@/hooks/use-refresh-machine-acp-capabilities', () => ({
  useRefreshMachineAcpCapabilities: () => async () => ({ success: true }),
}));

vi.mock('@/components/harness/device-capabilities', () => ({
  useDeviceCapabilities: () => ({
    status: 'ready',
    models: [],
    capability: undefined,
    modelOption: undefined,
    effortOption: undefined,
  }),
}));

vi.mock('@/hooks/use-workspace-mcp-catalog', () => ({
  useWorkspaceMcpCatalog: () => ({ servers: [], synced: true }),
  useWorkspaceMcpCatalogActions: () => ({ upsert: async () => {}, remove: async () => {} }),
}));

vi.mock('@/components/settings/acp-authentication-panel', () => ({
  AcpAuthenticationPanel: () => <div data-auth-panel="true" />,
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!('ResizeObserver' in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
}

describe('sorbetStoreAccess', () => {
  it('reads its own machine over the direct capabilities', () => {
    expect(sorbetStoreAccess(machine(), machineId)).toBe('store');
  });

  it('reads a remote machine once the workspace advertises the remote capabilities', () => {
    expect(
      sorbetStoreAccess(machine({ protocolCapabilities: ENCRYPTED_DAEMON }), otherMachineId)
    ).toBe('store');
  });

  it('separates a current daemon behind a plaintext workspace from an old daemon', () => {
    expect(sorbetStoreAccess(machine(), otherMachineId)).toBe('needs-encryption');
    expect(
      sorbetStoreAccess(
        machine({ protocolCapabilities: { sorbetCredentials: 1, sorbetProviders: 1 } }),
        otherMachineId
      )
    ).toBe('outdated');
    expect(sorbetStoreAccess(machine({ protocolCapabilities: {} }), otherMachineId)).toBe(
      'outdated'
    );
  });
});

describe('an unreadable machine store', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    harness.reset();
    mounted.calls.length = 0;
    mounted.machine = machine();
    mounted.configs = [lodyAgent];
    getDefaultStore().set(activeWorkspaceRuntimeAtom, runtime);
    getDefaultStore().set(localMachineIdAtom, null);
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container.remove();
  });

  /** Mount and let the bridge's sequential reads settle; `loading` is the only wait signal. */
  const render = async (node: ReactNode) => {
    root = createRoot(container);
    await act(async () => {
      root?.render(node);
    });
    for (let turn = 0; turn < 20 && getHarness().status === 'loading'; turn += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };

  it('reports the workspace before reaching for RPC the machine does not answer', async () => {
    await render(
      <SorbetBridge>
        <span>surface</span>
      </SorbetBridge>
    );

    expect(getHarness().status).toBe('unreachable');
    expect(mounted.calls).toEqual([]);
    expect(getHarness().credentials).toEqual({});
    expect(getHarness().customs).toEqual([]);
  });

  it('reads the same machine from its own host', async () => {
    getDefaultStore().set(localMachineIdAtom, machineId);
    await render(
      <SorbetBridge>
        <span>surface</span>
      </SorbetBridge>
    );
    expect(getHarness().status).toBe('ready');
    expect(mounted.calls).toContain('sorbet/credentials-list');
    expect(mounted.calls).toContain('sorbet/providers-list');
  });

  it('reads a remote machine once the workspace advertises the remote capabilities', async () => {
    mounted.machine = machine({ protocolCapabilities: ENCRYPTED_DAEMON });
    await render(
      <SorbetBridge>
        <span>surface</span>
      </SorbetBridge>
    );
    expect(getHarness().status).toBe('ready');
    expect(Object.keys(getHarness().credentials)).toEqual(['anthropic']);
    expect(getHarness().customs.map((custom) => custom.name)).toEqual(['Acme Gateway']);
  });

  it('does not claim an endpoint list it could not read', async () => {
    await render(
      <SorbetBridge>
        <ProvidersPanel />
      </SorbetBridge>
    );

    const text = container.textContent ?? '';
    expect(text).toContain('Endpoints on this machine cannot be read from this app.');
    expect(text).not.toContain('No endpoints yet');
    const add = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Add endpoint'
    );
    expect(add?.hasAttribute('disabled')).toBe(true);
  });

  it('does not ask for a provider before a model list it could not read', async () => {
    await render(
      <SorbetBridge>
        <ModelsPanel scope="profile" />
      </SorbetBridge>
    );

    const text = container.textContent ?? '';
    expect(text).toContain('Models on this machine cannot be read from this app.');
    expect(text).not.toContain('Connect a provider first');
  });

  it('lets setup continue past providers it cannot read', async () => {
    await render(
      <SorbetBridge>
        <Setup />
      </SorbetBridge>
    );

    expect(container.textContent).toContain('This app cannot read this machine’s connections');
    const next = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.trim().startsWith('Continue')
    );
    expect(next?.hasAttribute('disabled')).toBe(false);
  });

  it('reviews the provider row as unreadable rather than as none', async () => {
    harness.step(4);
    await render(
      <SorbetBridge>
        <Setup />
      </SorbetBridge>
    );

    const text = container.textContent ?? '';
    expect(text).toContain('Not readable from this app');
    expect(text).not.toContain('None connected');
  });
});
