// @vitest-environment jsdom
import { getRateLimitEntryKey } from '@lody/shared';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentConfigId,
  AgentConfigMeta,
  ClientToServer,
  MachineAcpBinaryProgressMessage,
  MachineId,
  MachineViewMeta,
  WorkspaceId,
} from '@lody/shared';

import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import { currentWorkspaceIdAtom } from '../src/atoms/workspace-context';
import { ProviderRow } from '../src/components/settings/provider-row';
import {
  useRefreshMachineAcpCapabilities,
  type AcpModelOptionsRefreshProgress,
} from '../src/hooks/use-refresh-machine-acp-capabilities';
import { initI18n } from '../src/i18n';
import {
  createCodexResetForecastStore,
  setCodexResetForecastStoreForTests,
} from '../src/lib/codex-reset-forecast-store';

const machineId = 'machine-test' as MachineId;
const machine: MachineViewMeta = {
  id: machineId,
  name: 'Workstation',
  cliVersion: '0.76.0',
  os: 'macOS',
  sessions: [],
  raceLimits: {},
};

const makeConfig = (
  overrides: Pick<AgentConfigMeta, 'cliType' | 'agentType'>
): AgentConfigMeta => ({
  id: `config-${overrides.agentType}` as AgentConfigId,
  machineId,
  name: overrides.agentType,
  env: {},
  ...overrides,
});

describe('ProviderRow reauthentication', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    setCodexResetForecastStoreForTests(null);
  });

  const renderConfig = async (config: AgentConfigMeta) => {
    await act(async () => {
      root.render(
        <ProviderRow config={config} machine={machine} onEdit={vi.fn()} onRefresh={vi.fn()} />
      );
    });
  };

  it('shows quota only for a Provider that declares the capability, including custom ACP', async () => {
    const config = makeConfig({ cliType: 'custom', agentType: 'example' });
    const quotaMachine: MachineViewMeta = { ...machine };
    // Use the same public key encoder as the daemon's Flock projection.
    quotaMachine.raceLimits = {
      [getRateLimitEntryKey('example', 'example', config.id)]: {
        limitId: 'example',
        scope: { providerId: 'example' },
        windows: [{ usedPercent: 30, windowDurationSeconds: 18000, resetsAtEpochSeconds: null }],
      },
    };
    const render = async () =>
      act(async () => {
        root.render(
          <ProviderRow
            config={config}
            machine={{ ...quotaMachine }}
            onEdit={() => {}}
            onRefresh={() => {}}
          />
        );
      });
    await render();
    expect(container.textContent).not.toContain('70%');
    quotaMachine.acpCapabilities = {
      [config.id]: {
        cliType: 'custom',
        agentType: 'example',
        modes: [],
        models: [],
        fetchedAt: 1,
        rateLimits: { version: 1 },
      },
    };
    await render();
    expect(container.textContent).toContain('70%');
  });

  it.each([
    ['codex', 'OPENAI_API_KEY'],
    ['claude', 'ANTHROPIC_BASE_URL'],
    ['grok', 'XAI_API_KEY'],
  ])(
    'shows only the owning %s quota with tool env, and hides account overrides',
    async (agentType, accountKey) => {
      const config = {
        ...makeConfig({ cliType: 'builtin', agentType }),
        env: { OP_TOKEN: 'synthetic' },
      };
      const quotaMachine: MachineViewMeta = {
        ...machine,
        acpCapabilities: {
          [config.id]: {
            cliType: 'builtin',
            agentType,
            modes: [],
            models: [],
            fetchedAt: 1,
            rateLimits: { version: 1 },
          },
        },
        raceLimits: Object.fromEntries(
          [
            [config.id, 30],
            ['another-provider', 90],
          ].map(([id, usedPercent]) => [
            getRateLimitEntryKey(agentType, agentType, id as AgentConfigId),
            {
              limitId: agentType,
              scope: { providerId: agentType },
              windows: [{ usedPercent, windowDurationSeconds: 18000, resetsAtEpochSeconds: null }],
            },
          ])
        ),
      };
      const render = async (env: Record<string, string>) =>
        act(async () => {
          root.render(
            <ProviderRow config={{ ...config, env }} machine={quotaMachine} onEdit={() => {}} />
          );
        });
      await render(config.env);
      expect(container.textContent).toContain('70%');
      expect(container.textContent).not.toContain('10%');
      await render({ ...config.env, [accountKey]: 'synthetic' });
      expect(container.textContent).not.toContain('70%');
      await render(config.env);
      expect(container.textContent).toContain('70%');
    }
  );

  // Asserts on rendered text rather than a mocked panel: the row must not grow a
  // sign-in affordance again, whichever component would provide it.
  const hasSignInAction = () =>
    Array.from(container.querySelectorAll('button')).some((button) =>
      button.textContent?.includes('Sign in')
    );

  it('loads the forecast only after its direct action is selected', async () => {
    const store = createCodexResetForecastStore({
      fetchStatus: async () => ({
        status: { watch: null, scheduledReset: null, latestReset: null },
        etag: null,
        maxAgeMs: 60_000,
      }),
    });
    setCodexResetForecastStoreForTests(store);
    await renderConfig(makeConfig({ cliType: 'builtin', agentType: 'codex' }));
    expect(store.getState().status).toBe('idle');
    expect(container.textContent).toContain('Reset forecast');
    expect(container.textContent).not.toContain('Quota details');
    const forecast = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Reset forecast'
    );
    expect(forecast).toBeDefined();
    await act(async () => forecast?.click());
    expect(store.getState().status).toBe('ready');
    expect(document.body.textContent).toContain('No reset forecast right now.');
  });
});

describe('ProviderRow model option refresh', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('names each model while the refresh reads its options, then clears', async () => {
    let reportProgress!: (progress: {
      modelId: string;
      modelName: string;
      index: number;
      total: number;
    }) => void;
    let finish!: () => void;
    const onRefresh = vi.fn(
      (_config: AgentConfigMeta, options?: { onModelOptionsProgress?: typeof reportProgress }) =>
        new Promise<void>((resolve) => {
          reportProgress = (progress) => options?.onModelOptionsProgress?.(progress);
          finish = resolve;
        })
    );
    await act(async () => {
      root.render(
        <ProviderRow
          config={makeConfig({ cliType: 'builtin', agentType: 'dimcode' })}
          machine={machine}
          onEdit={vi.fn()}
          onRefresh={onRefresh}
        />
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label^="Manage"]');
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      trigger?.click();
    });
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) =>
      node.textContent?.includes('Refresh models and modes')
    );
    await act(async () => item?.click());

    await act(async () =>
      reportProgress({
        modelId: 'deepseek-flash',
        modelName: 'DeepSeek Flash',
        index: 2,
        total: 40,
      })
    );
    const statusText = () =>
      [...container.querySelectorAll('[role="status"]')].map((node) => node.textContent).join('');
    expect(statusText()).toContain('Reading options for DeepSeek Flash (2/40)');

    await act(async () => finish());
    expect(statusText()).not.toContain('Reading options');
  });

  it('omits readModelOptions by default and opts in only when explicitly requested', async () => {
    type RefreshMessage = Extract<ClientToServer, { type: 'machine/acp-capabilities-refresh' }>;
    const sent: RefreshMessage[] = [];
    const requestMachineAcpCapabilitiesRefresh = vi.fn(
      async (
        message: RefreshMessage,
        options?: { onProgress?: (progress: MachineAcpBinaryProgressMessage) => void }
      ) => {
        sent.push(message);
        options?.onProgress?.({
          type: 'machine/acp-binary-progress',
          machineId,
          agentType: 'devin',
          status: 'reading-model-options',
          configId: message.configId,
          modelId: 'fusion-1',
          modelName: 'Fusion 1',
          modelIndex: 1,
          modelCount: 169,
        });
        return {
          type: 'machine/acp-capabilities-refresh_response' as const,
          machineId,
          configId: message.configId,
          cliType: 'builtin' as const,
          agentType: 'devin',
          success: false,
          authRequired: true,
        };
      }
    );

    const store = createStore();
    store.set(currentWorkspaceIdAtom, 'ws-test' as WorkspaceId);
    store.set(runtimeAtom, {
      workspaceId: 'ws-test' as WorkspaceId,
      requestMachineAcpCapabilitiesRefresh,
    } as unknown as WorkspaceRuntime);

    let refresh!: ReturnType<typeof useRefreshMachineAcpCapabilities>;
    function Harness() {
      refresh = useRefreshMachineAcpCapabilities();
      return null;
    }

    await act(async () => {
      root.render(
        <Provider store={store}>
          <Harness />
        </Provider>
      );
    });

    const configId = 'config-devin' as AgentConfigId;
    await act(async () => {
      await refresh({ machineId, configId });
    });
    expect(sent[0]).toMatchObject({
      type: 'machine/acp-capabilities-refresh',
      machineId,
      configId,
      force: true,
    });
    expect(sent[0]?.readModelOptions).toBeUndefined();

    const observedProgress: AcpModelOptionsRefreshProgress[] = [];
    await act(async () => {
      await refresh({
        machineId,
        configId,
        readModelOptions: true,
        onModelOptionsProgress: (progress) => observedProgress.push(progress),
      });
    });
    expect(sent[1]?.readModelOptions).toBe(true);
    expect(observedProgress).toEqual([
      { modelId: 'fusion-1', modelName: 'Fusion 1', index: 1, total: 169 },
    ]);
  });
});
