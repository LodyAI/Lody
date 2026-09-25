// @vitest-environment jsdom

import { act, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import {
  ACP_CAPABILITY_CACHE_VERSION,
  PROVIDER_SETUP_PROTOCOL_VERSION,
  getAcpCapabilityCacheKey,
  machineFlockKeys,
  serializeMachineFlockKey,
  serializeCustomAcpLaunchSpec,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineId,
  type MachineViewMeta,
  type MachineFlockScanRow,
  type WorkspaceId,
} from '@lody/shared';
import {
  cmdCreateProviderSetupAtom,
  cmdCreateAgentConfigAtom,
  getAllProviderSetupsAtom,
  getAllAgentConfigAtom,
} from '../src/atoms/agents';
import { setMachineFlockRowsForMachineAtom } from '../src/atoms/machine-flock';
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '../src/atoms/workspace-context';
import {
  AgentConfigDialog,
  type AgentConfigDialogMode,
  type AgentConfigSubmitPayload,
} from '../src/components/settings/agent-config-dialog';
import * as machineAuthenticationHook from '../src/hooks/use-machine-acp-authentication';
import { initI18n } from '../src/i18n';
import { Tooltip } from '@lody/ui/tooltip';

const machineId = 'machine-test' as MachineId;
const claudeConfigId = 'claude-config' as AgentConfigId;
const kimiConfigId = 'kimi-config' as AgentConfigId;
type RefreshCapabilities = ComponentProps<typeof AgentConfigDialog>['onRefreshCapabilities'];

/** Omits `protocolCapabilities` by default, so the machine reads as legacy. */
const createMachine = (
  name: string,
  protocolCapabilities?: MachineViewMeta['protocolCapabilities']
): MachineViewMeta => ({
  id: machineId,
  name,
  cliVersion: '0.44.0',
  os: 'macOS',
  sessions: [],
  raceLimits: {},
  ...(protocolCapabilities ? { protocolCapabilities } : {}),
  acpCapabilities: {
    [getAcpCapabilityCacheKey(claudeConfigId)]: {
      cliType: 'builtin',
      agentType: 'claude',
      cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
      sourceVersion: 'claude-code@1.0.0',
      modes: [],
      models: [],
      configOptions: [],
      availableCommands: [],
      fetchedAt: Date.now(),
    },
  },
});

/** A machine whose cached capabilities expose title-eligible config options. */
const createTitleConfigMachine = (): MachineViewMeta => ({
  ...createMachine('Kimi workstation'),
  acpCapabilities: {
    [getAcpCapabilityCacheKey(kimiConfigId)]: {
      cliType: 'builtin',
      agentType: 'kimi',
      cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
      sourceVersion: 'kimi-code@1.0.0',
      // Builtin Kimi is the one agent the dialog holds to an authoritative
      // (real runtime probe) cache entry before it renders config selectors.
      provenance: 'runtime',
      modes: [],
      models: [],
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'kimi-k2',
          options: [
            { value: 'kimi-k2', name: 'Kimi K2' },
            { value: 'kimi-k2-turbo', name: 'Kimi K2 Turbo' },
          ],
        },
        {
          id: 'reasoning_effort',
          name: 'Reasoning effort',
          category: 'thought_level',
          type: 'select',
          currentValue: 'ultra',
          options: [
            { value: 'low', name: 'low' },
            { value: 'medium', name: 'medium' },
            { value: 'max', name: 'max' },
            { value: 'ultra', name: 'ultra' },
          ],
        },
      ],
      // The title model's ladder omits `ultra`, so a stored `ultra` effort is
      // invalid for it and must normalize to the selector's current value.
      // Codex resolves its ladder through a dedicated branch; every other agent
      // goes through this map.
      modelReasoningEfforts: { 'kimi-k2-turbo': ['low', 'medium'] },
      availableCommands: [],
      fetchedAt: Date.now(),
    },
  },
});

const createBuiltinConfig = (overrides: Partial<AgentConfigMeta> = {}): AgentConfigMeta =>
  ({
    id: kimiConfigId,
    machineId,
    name: 'Kimi',
    description: undefined,
    cliType: 'builtin',
    agentType: 'kimi',
    env: {},
    ...overrides,
  }) as AgentConfigMeta;

const getOptionButtons = (): HTMLButtonElement[] =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('button[role="option"]'));

const getSelectedOption = (): HTMLButtonElement | undefined =>
  getOptionButtons().find((button) => button.getAttribute('aria-selected') === 'true');

const getOptionByText = (text: string): HTMLButtonElement => {
  const option = getOptionButtons().find((button) => button.textContent?.includes(text));
  if (!option) {
    throw new Error(`Expected option containing text "${text}"`);
  }
  return option;
};

const setNativeTextAreaValue = (element: HTMLTextAreaElement, value: string): void => {
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value'
  )?.set;
  valueSetter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
};

const setNativeInputValue = (element: HTMLInputElement, value: string): void => {
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )?.set;
  valueSetter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('AgentConfigDialog', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let store: ReturnType<typeof createStore>;

  beforeEach(async () => {
    store = createStore();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = undefined;
    container?.remove();
    container = undefined;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const renderDialog = async (
    mode: AgentConfigDialogMode,
    machine: MachineViewMeta,
    onSubmit = vi.fn(async () => {}),
    onCheckBinaryStatus = vi.fn(async () => ({ status: 'installed' as const })),
    onRefreshCapabilities: RefreshCapabilities = async (args) => ({
      type: 'machine/acp-capabilities-refresh_response' as const,
      machineId: args.machineId,
      configId: args.configId,
      cliType: 'builtin',
      agentType: 'codex',
      success: true,
    }),
    onManagedRuntimeSelected?: ComponentProps<typeof AgentConfigDialog>['onManagedRuntimeSelected'],
    onScanPiExtensions?: ComponentProps<typeof AgentConfigDialog>['onScanPiExtensions']
  ) => {
    await act(async () => {
      root?.render(
        <Provider store={store}>
          <Tooltip.Provider>
            <AgentConfigDialog
              open
              onOpenChange={vi.fn()}
              mode={mode}
              machine={machine}
              onSubmit={onSubmit}
              onRefreshCapabilities={onRefreshCapabilities}
              onCheckBinaryStatus={onCheckBinaryStatus}
              onManagedRuntimeSelected={onManagedRuntimeSelected}
              onScanPiExtensions={onScanPiExtensions}
            />
          </Tooltip.Provider>
        </Provider>
      );
    });
  };

  it('scans Pi without publishing or enabling candidates, then saves only selected paths', async () => {
    const saved: AgentConfigSubmitPayload[] = [];
    const mode: AgentConfigDialogMode = {
      kind: 'edit',
      config: {
        id: 'pi-config' as AgentConfigId,
        machineId,
        name: 'Pi',
        cliType: 'builtin',
        agentType: 'pi',
        env: {},
      },
    };
    const scan = async () => ({
      success: true as const,
      discovery: {
        version: 1 as const,
        agentDir: '/fixture/pi',
        warnings: [],
        extensions: [{ path: '/fixture/plugin.ts', name: 'Plugin', source: 'directory' as const }],
      },
    });
    await renderDialog(
      mode,
      createMachine('Pi machine', { piExtensions: 1 }),
      vi.fn(async (payload: AgentConfigSubmitPayload) => {
        saved.push(payload);
      }),
      undefined,
      undefined,
      undefined,
      scan
    );
    const button = (text: string) =>
      Array.from(document.querySelectorAll('button')).find((node) => node.textContent === text)!;
    await act(async () => {
      button('Scan extensions').click();
    });
    const field = document.querySelector('[aria-label="Pi extensions"]')!;
    expect(field.textContent).toContain('/fixture/pi');
    expect(field.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('false');
    expect(saved).toEqual([]);
    await act(async () => {
      (field.querySelector('[role="checkbox"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      button('Rescan').click();
    });
    expect(field.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      getPrimaryAction('Save').click();
    });
    expect(saved.at(-1)?.runtimeOverrides).toEqual({ piExtensions: ['/fixture/plugin.ts'] });
    await act(async () => {
      (field.querySelector('[role="checkbox"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      getPrimaryAction('Save').click();
    });
    expect(saved.at(-1)?.runtimeOverrides).toBeUndefined();
  });

  it('creates a Pi provider with selected extensions through the live-probe path', async () => {
    const saved: AgentConfigSubmitPayload[] = [];
    const scan = async () => ({
      success: true as const,
      discovery: {
        version: 1 as const,
        agentDir: '/fixture/pi',
        warnings: [],
        extensions: [{ path: '/fixture/plugin.ts', name: 'Plugin', source: 'directory' as const }],
      },
    });
    await renderDialog(
      { kind: 'create' },
      createMachine('Pi machine', {
        piExtensions: 1,
        providerSetup: PROVIDER_SETUP_PROTOCOL_VERSION,
      }),
      vi.fn(async (payload: AgentConfigSubmitPayload) => {
        saved.push(payload);
      }),
      undefined,
      async (args) => ({
        type: 'machine/acp-capabilities-refresh_response' as const,
        machineId: args.machineId,
        configId: args.configId,
        cliType: 'builtin',
        agentType: 'pi',
        success: true,
      }),
      undefined,
      scan
    );
    const button = (text: string) =>
      Array.from(document.querySelectorAll('button')).find((node) => node.textContent === text)!;
    await act(async () => {
      getOptionByText('Pi').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      button('Scan extensions').click();
    });
    const field = document.querySelector('[aria-label="Pi extensions"]')!;
    await act(async () => {
      (field.querySelector('[role="checkbox"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      getPrimaryAction('Create').click();
    });
    await vi.waitFor(() => {
      expect(saved.at(-1)).toMatchObject({
        agentType: 'pi',
        runtimeOverrides: { piExtensions: ['/fixture/plugin.ts'] },
      });
    });
    expect(saved.at(-1)?.backgroundSetup).toBeUndefined();
  });

  it('ignores an old Pi scan after changing providers and saves a manual path on the new provider', async () => {
    const machine = createMachine('Pi machine', { piExtensions: 1 });
    const config: AgentConfigMeta = {
      id: 'old-pi' as AgentConfigId,
      machineId,
      name: 'Pi',
      cliType: 'builtin',
      agentType: 'pi',
      env: {},
    };
    let finish!: (
      result: Awaited<
        ReturnType<NonNullable<ComponentProps<typeof AgentConfigDialog>['onScanPiExtensions']>>
      >
    ) => void;
    const pending = new Promise<Parameters<typeof finish>[0]>((resolve) => {
      finish = resolve;
    });
    const saved: AgentConfigSubmitPayload[] = [];
    const submit = vi.fn(async (payload: AgentConfigSubmitPayload) => {
      saved.push(payload);
    });
    await renderDialog(
      { kind: 'edit', config },
      machine,
      submit,
      undefined,
      undefined,
      undefined,
      () => pending
    );
    const button = (text: string) =>
      Array.from(document.querySelectorAll('button')).find((node) => node.textContent === text)!;
    await act(async () => {
      button('Scan extensions').click();
    });
    await renderDialog(
      { kind: 'edit', config: { ...config, id: 'new-pi' as AgentConfigId } },
      machine,
      submit
    );
    await act(async () => {
      finish({
        success: true,
        discovery: {
          version: 1,
          agentDir: '/old/profile',
          warnings: [],
          extensions: [{ path: '/old/plugin.ts', name: 'Old plugin', source: 'directory' }],
        },
      });
    });
    expect(document.body.textContent).not.toContain('Old plugin');
    await act(async () => {
      setNativeInputValue(
        document.querySelector('input[aria-label="Extension path"]')!,
        ' /fixture/manual.ts '
      );
    });
    await act(async () => {
      button('Add path').click();
    });
    await act(async () => {
      getPrimaryAction('Save').click();
    });
    expect(saved.at(-1)).toMatchObject({
      id: 'new-pi',
      runtimeOverrides: { piExtensions: ['/fixture/manual.ts'] },
    });
  });

  it('does not reset the selected agent type when machine metadata refreshes while creating', async () => {
    const mode: AgentConfigDialogMode = { kind: 'create' };

    await renderDialog(mode, createMachine('Workstation'));
    expect(getSelectedOption()?.textContent).toContain('Kimi Code');
    expect(
      getOptionButtons()
        .slice(0, 5)
        .map((option) => option.textContent)
    ).toEqual([
      expect.stringContaining('Kimi Code'),
      expect.stringContaining('Grok'),
      expect.stringContaining('Claude'),
      expect.stringContaining('Codex'),
      expect.stringContaining('DeepSeek Harness'),
    ]);

    await act(async () => {
      getOptionByText('Custom command').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(getSelectedOption()?.textContent).toContain('Custom command');
    expect(document.body.querySelector('#custom-acp-command')).not.toBeNull();

    await renderDialog(mode, createMachine('Workstation refreshed'));

    expect(getSelectedOption()?.textContent).toContain('Custom command');
    expect(document.body.querySelector('#custom-acp-command')).not.toBeNull();
  });

  it('queues Bub for verification without publishing or probing it from the dialog', async () => {
    const mode: AgentConfigDialogMode = { kind: 'create' };
    const onSubmit = vi.fn(async () => {});
    const onRefreshCapabilities = vi.fn<RefreshCapabilities>(async (args) => ({
      type: 'machine/acp-capabilities-refresh_response' as const,
      machineId: args.machineId,
      configId: args.configId,
      cliType: 'builtin',
      agentType: 'bub',
      success: true,
    }));

    await renderDialog(
      mode,
      createMachine('Workstation', { providerSetup: PROVIDER_SETUP_PROTOCOL_VERSION }),
      onSubmit,
      vi.fn(async () => ({ status: 'installed' as const })),
      onRefreshCapabilities
    );

    await act(async () => {
      getOptionByText('Bub').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(getSelectedOption()?.textContent).toContain('Bub');
    expect(onSubmit).not.toHaveBeenCalled();

    await act(async () => {
      getPrimaryAction('Create').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          cliType: 'builtin',
          agentType: 'bub',
          backgroundSetup: true,
        })
      );
    });
    expect(onRefreshCapabilities).not.toHaveBeenCalled();
  });

  it('does not create Bub against a daemon without deferred provider setup', async () => {
    const onSubmit = vi.fn(async () => {});
    await renderDialog({ kind: 'create' }, createMachine('Legacy workstation'), onSubmit);

    await act(async () => {
      getOptionByText('Bub').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(getPrimaryAction('Create').disabled).toBe(true);
    expect(
      document.body.querySelector<HTMLButtonElement>('button[aria-label="Test agent capabilities"]')
        ?.disabled
    ).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each(['bub', 'dimcode'])('%s setup supports retry and refresh', async (agentType) => {
    const workspaceId = 'workspace-bub-test' as WorkspaceId;
    const workspaceSlug = 'workspace-bub-test';
    const mirrorRows = new Map<string, MachineFlockScanRow>();
    store.set(runtimeAtom, {
      workspaceId,
      workspaceSlug,
      repo: { openFlockDoc: async () => ({ flock: { scan: () => mirrorRows.values() } }) },
      writer: {
        flockRowPut: async (_docId: string, key: MachineFlockScanRow['key'], value: unknown) => {
          mirrorRows.set(serializeMachineFlockKey(key), { key, value } as MachineFlockScanRow);
        },
        flockRowDelete: async (_docId: string, key: MachineFlockScanRow['key']) => {
          mirrorRows.delete(serializeMachineFlockKey(key));
        },
      },
      getMachineAcpBinaryProgress: () => null,
      subscribeMachineAcpBinaryProgress: () => () => {},
    } as unknown as WorkspaceRuntime);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, workspaceSlug);
    const publishRows = () =>
      store.set(setMachineFlockRowsForMachineAtom, {
        workspaceId,
        machineId,
        rows: Object.fromEntries(mirrorRows),
      });
    const onSubmit = async (payload: AgentConfigSubmitPayload) => {
      const { backgroundSetup, ...fields } = payload;
      const config = { ...fields, machineId };
      await store.set(
        backgroundSetup ? cmdCreateProviderSetupAtom : cmdCreateAgentConfigAtom,
        config
      );
    };
    const refresh: RefreshCapabilities = vi.fn(async (args) => ({
      type: 'machine/acp-capabilities-refresh_response',
      ...args,
      cliType: 'builtin',
      agentType,
      success: true,
    }));
    await renderDialog(
      { kind: 'create', initialForm: { agentType, cliType: 'builtin', name: agentType } },
      createMachine('Workstation', { providerSetup: PROVIDER_SETUP_PROTOCOL_VERSION }),
      onSubmit,
      vi.fn(async () => ({ status: 'installed' as const })),
      refresh
    );
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('button[aria-label="Test agent capabilities"]')!
        .click();
    });
    let setup = store.get(getAllProviderSetupsAtom)[0]!;
    expect(setup.config.agentType).toBe(agentType);
    expect(store.get(getAllAgentConfigAtom)).toEqual([]);
    expect(getPrimaryAction('Create').disabled).toBe(true);
    expect(getOptionByText('Claude').disabled).toBe(true);
    expect(refresh).not.toHaveBeenCalled();

    const cancelledId = setup.id;
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('button[aria-label="Delete"]')!.click();
    });
    expect(store.get(getAllProviderSetupsAtom)).toEqual([]);
    expect(
      mirrorRows.has(
        serializeMachineFlockKey(machineFlockKeys.providerSetupCancellation(cancelledId))
      )
    ).toBe(true);
    expect(getOptionByText('Claude').disabled).toBe(false);
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('button[aria-label="Test agent capabilities"]')!
        .click();
    });
    setup = store.get(getAllProviderSetupsAtom)[0]!;
    expect(setup.id).not.toBe(cancelledId);

    await act(async () => {
      const key = machineFlockKeys.providerSetup(setup.id);
      mirrorRows.set(serializeMachineFlockKey(key), {
        key,
        value: {
          ...setup,
          status: 'failed',
          failureCode: 'runtime-unavailable',
        },
      });
      publishRows();
    });
    if (agentType === 'bub') {
      expect(document.body.textContent).toContain('Bub or its ACP server is not installed');
      expect(document.body.textContent).toContain(
        'curl -fsSL https://bub.build/install.sh | bash -- --preset acp'
      );
      expect(document.body.textContent).toContain('Open install guide');
    } else {
      expect(document.body.textContent).toContain(
        'This runtime is not available on the target machine.'
      );
      expect(document.body.textContent).not.toContain('Open install guide');
    }
    await act(async () => {
      getPrimaryAction('Retry').click();
    });
    expect(store.get(getAllProviderSetupsAtom)[0]).toMatchObject({
      status: 'queued',
      attempt: 2,
    });
    expect(document.body.textContent).not.toContain('Install it in one step:');

    await act(async () => {
      mirrorRows.delete(serializeMachineFlockKey(machineFlockKeys.providerSetup(setup.id)));
      const key = machineFlockKeys.agentConfig(setup.id);
      mirrorRows.set(serializeMachineFlockKey(key), { key, value: setup.config });
      publishRows();
    });
    expect(getPrimaryAction('Save').disabled).toBe(false);
    expect(document.body.querySelector('#agent-config-name')?.closest('[hidden]')).toBeNull();
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('button[aria-label="Refresh agent capabilities"]')!
        .click();
    });
    expect(document.body.textContent).toContain('Ready');
    expect(store.get(getAllProviderSetupsAtom)).toEqual([]);
    expect(store.get(getAllAgentConfigAtom).map((config) => config.id)).toEqual([setup.id]);
    expect(refresh).toHaveBeenCalledWith({ machineId, configId: setup.id });
  });

  it('offers installation guidance after an existing Bub refresh fails and allows retry', async () => {
    let installed = false;
    const refresh: RefreshCapabilities = async (args) => ({
      type: 'machine/acp-capabilities-refresh_response',
      ...args,
      cliType: 'builtin',
      agentType: 'bub',
      success: installed,
      ...(installed ? {} : { error: 'spawn bub ENOENT' }),
    });
    await renderDialog(
      { kind: 'edit', config: createBuiltinConfig({ agentType: 'bub', name: 'Bub' }) },
      createMachine('Workstation'),
      vi.fn(async () => {}),
      vi.fn(async () => ({ status: 'installed' as const })),
      refresh
    );
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('button[aria-label="Test agent capabilities"]')!
        .click();
    });
    expect(document.body.textContent).toContain('spawn bub ENOENT');
    expect(document.body.textContent).toContain('Install it in one step:');
    installed = true;
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('button[aria-label="Retry capability probe"]')!
        .click();
    });
    expect(document.body.textContent).not.toContain('Install it in one step:');
    expect(
      document.body.querySelector('button[aria-label="Refresh agent capabilities"]')
    ).not.toBeNull();
  });

  it('reports the selected managed runtime so onboarding can prioritize it', async () => {
    const onManagedRuntimeSelected = vi.fn();
    await renderDialog(
      {
        kind: 'create',
        initialForm: { name: 'Codex', cliType: 'builtin', agentType: 'codex' },
      },
      createMachine('Workstation'),
      undefined,
      undefined,
      undefined,
      onManagedRuntimeSelected
    );

    await vi.waitFor(() => {
      expect(onManagedRuntimeSelected).toHaveBeenLastCalledWith('codex');
    });

    await act(async () => {
      getOptionByText('Claude').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(onManagedRuntimeSelected).toHaveBeenLastCalledWith('claude');
    });
  });

  const getTabByName = (name: string): HTMLButtonElement => {
    const tab = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (button) => button.textContent?.trim() === name
    );
    if (!tab) {
      throw new Error(`Expected tab "${name}"`);
    }
    return tab;
  };

  const selectTab = async (name: string): Promise<void> => {
    // A whole press, not just its first half: the strip is Base UI's now and a
    // tab is taken on the click, while Radix took it on the mousedown.
    await act(async () => {
      const tab = getTabByName(name);
      const press = { bubbles: true, cancelable: true, button: 0 };
      tab.dispatchEvent(new MouseEvent('mousedown', press));
      tab.focus();
      tab.dispatchEvent(new MouseEvent('mouseup', press));
      tab.click();
    });
  };

  const getVisibleDeepSeekEndpointInput = (): HTMLInputElement | null => {
    const input = document.body.querySelector<HTMLInputElement>('#deepseek-endpoint');
    if (!input) return null;
    const panel = input.closest<HTMLElement>('[role="tabpanel"]');
    if (panel?.hidden) return null;
    return input;
  };

  function getPrimaryAction(label: 'Create' | 'Save' | 'Retry'): HTMLButtonElement {
    const button = Array.from(document.body.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === label
    );
    if (!button) {
      throw new Error(`Expected ${label} button`);
    }
    return button;
  }

  const openAdditionalEnvSection = async (): Promise<HTMLTextAreaElement> => {
    const environmentSection = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Additional environment variables')
    );
    await act(async () => {
      environmentSection?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const envTextArea = Array.from(
      document.body.querySelectorAll<HTMLTextAreaElement>('textarea')
    ).at(-1);
    if (!envTextArea) {
      throw new Error('Expected additional environment textarea');
    }
    return envTextArea;
  };

  const renderDeepSeekCreate = (
    onSubmit = vi.fn(async (_payload: AgentConfigSubmitPayload) => {}),
    onManagedRuntimeSelected = vi.fn(),
    onCheckBinaryStatus = vi.fn(async () => ({ status: 'not-installed' as const }))
  ) =>
    renderDialog(
      {
        kind: 'create',
        initialForm: {
          name: 'DeepSeek Harness',
          cliType: 'builtin',
          agentType: 'deepseek',
        },
      },
      createMachine('Workstation'),
      onSubmit,
      onCheckBinaryStatus,
      undefined,
      onManagedRuntimeSelected
    );

  const renderDeepSeekEdit = (
    env: Record<string, string>,
    onSubmit = vi.fn(async (_payload: AgentConfigSubmitPayload) => {})
  ) =>
    renderDialog(
      {
        kind: 'edit',
        config: {
          id: claudeConfigId,
          machineId,
          name: 'DeepSeek Harness',
          description: undefined,
          cliType: 'builtin',
          agentType: 'deepseek',
          env,
        } as AgentConfigMeta,
      },
      createMachine('Workstation'),
      onSubmit
    );

  it('defaults DeepSeek Harness to the official endpoint and keeps it out of managed runtime setup', async () => {
    const onManagedRuntimeSelected = vi.fn();
    const onCheckBinaryStatus = vi.fn(async () => ({ status: 'not-installed' as const }));
    const onSubmit = vi.fn(async (_payload: AgentConfigSubmitPayload) => {});
    await renderDeepSeekCreate(onSubmit, onManagedRuntimeSelected, onCheckBinaryStatus);

    expect(onManagedRuntimeSelected).not.toHaveBeenCalled();
    expect(onCheckBinaryStatus).not.toHaveBeenCalled();
    expect(getTabByName('DeepSeek official').getAttribute('aria-selected')).toBe('true');
    expect(getTabByName('Custom Endpoint').getAttribute('aria-selected')).toBe('false');
    expect(getVisibleDeepSeekEndpointInput()).toBeNull();
    expect(document.body.querySelector('label[for="deepseek-api-key"]')?.textContent).toBe(
      'DeepSeek API Key'
    );
    const apiKeyInput = document.body.querySelector<HTMLInputElement>('#deepseek-api-key');
    expect(apiKeyInput?.type).toBe('password');
    const createButton = getPrimaryAction('Create');
    expect(createButton.disabled).toBe(true);

    await act(async () => {
      setNativeInputValue(apiKeyInput!, 'sk-deepseek-test');
    });
    expect(createButton.disabled).toBe(false);

    const envTextArea = await openAdditionalEnvSection();
    expect(document.body.textContent).toContain(
      'DEEPSEEK_API_KEY and DEEPSEEK_BASE_URL are set above and cannot be overridden here.'
    );
    expect(envTextArea.value).not.toContain('DEEPSEEK_API_KEY');
    expect(envTextArea.value).not.toContain('DEEPSEEK_BASE_URL');

    await act(async () => {
      createButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await vi.waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          cliType: 'builtin',
          agentType: 'deepseek',
          env: {
            DEEPSEEK_API_KEY: 'sk-deepseek-test',
            DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
          },
        })
      );
    });
  });

  it('requires a valid custom DeepSeek endpoint and saves the trimmed URL as-is', async () => {
    const onSubmit = vi.fn(async (_payload: AgentConfigSubmitPayload) => {});
    await renderDeepSeekCreate(onSubmit);

    await selectTab('Custom Endpoint');
    expect(getTabByName('Custom Endpoint').getAttribute('aria-selected')).toBe('true');
    expect(document.body.querySelector('label[for="deepseek-api-key"]')?.textContent).toBe(
      'API Key'
    );

    const apiKeyInput = document.body.querySelector<HTMLInputElement>('#deepseek-api-key');
    await act(async () => {
      setNativeInputValue(apiKeyInput!, 'sk-deepseek-test');
    });
    const createButton = getPrimaryAction('Create');
    expect(createButton.disabled).toBe(true);

    const endpointInput = getVisibleDeepSeekEndpointInput();
    expect(endpointInput).not.toBeNull();
    expect(document.body.querySelector('#deepseek-models')).toBeNull();
    expect(document.body.textContent).toContain(
      'Available models are discovered automatically from the endpoint when this provider is verified.'
    );
    await act(async () => {
      setNativeInputValue(endpointInput!, 'not-a-url');
    });
    expect(createButton.disabled).toBe(true);

    await act(async () => {
      setNativeInputValue(endpointInput!, 'ftp://llm.example.com');
    });
    expect(createButton.disabled).toBe(true);

    await act(async () => {
      setNativeInputValue(endpointInput!, '  https://llm.example.com/open/v1  ');
    });
    expect(createButton.disabled).toBe(false);

    await act(async () => {
      createButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await vi.waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          cliType: 'builtin',
          agentType: 'deepseek',
          env: {
            DEEPSEEK_API_KEY: 'sk-deepseek-test',
            DEEPSEEK_BASE_URL: 'https://llm.example.com/open/v1',
          },
        })
      );
    });
  });

  it.each([
    { label: 'no base URL', env: { DEEPSEEK_API_KEY: 'sk-old' } },
    {
      label: 'the official URL',
      env: { DEEPSEEK_API_KEY: 'sk-old', DEEPSEEK_BASE_URL: 'https://api.deepseek.com' },
    },
    {
      label: 'a trailing slash',
      env: { DEEPSEEK_API_KEY: 'sk-old', DEEPSEEK_BASE_URL: 'https://api.deepseek.com/' },
    },
    {
      label: 'a /v1 path',
      env: { DEEPSEEK_API_KEY: 'sk-old', DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1' },
    },
    {
      label: 'a /v1 trailing slash',
      env: { DEEPSEEK_API_KEY: 'sk-old', DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1/' },
    },
  ])('opens the official DeepSeek tab when editing a config with $label', async ({ env }) => {
    await renderDeepSeekEdit(env);

    expect(getTabByName('DeepSeek official').getAttribute('aria-selected')).toBe('true');
    expect(getVisibleDeepSeekEndpointInput()).toBeNull();
    expect(document.body.querySelector<HTMLInputElement>('#deepseek-api-key')?.value).toBe(
      'sk-old'
    );
  });

  it('opens the custom DeepSeek tab, fills its endpoint, and drops the legacy model override', async () => {
    await renderDeepSeekEdit({
      DEEPSEEK_API_KEY: 'sk-old',
      DEEPSEEK_BASE_URL: 'https://llm.example.com/open',
      ACP_EXTENSION_DSH_MODELS: '["gateway-model","reasoning-model"]',
    });

    expect(getTabByName('Custom Endpoint').getAttribute('aria-selected')).toBe('true');
    expect(getVisibleDeepSeekEndpointInput()?.value).toBe('https://llm.example.com/open');
    expect(document.body.querySelector<HTMLInputElement>('#deepseek-api-key')?.value).toBe(
      'sk-old'
    );
    expect(document.body.querySelector('#deepseek-models')).toBeNull();
  });

  it('keeps DeepSeek key and custom endpoint drafts when switching tabs, and official save drops the custom URL', async () => {
    const onSubmit = vi.fn(async (_payload: AgentConfigSubmitPayload) => {});
    await renderDeepSeekEdit(
      {
        DEEPSEEK_API_KEY: 'sk-old',
        DEEPSEEK_BASE_URL: 'https://llm.example.com/open',
      },
      onSubmit
    );

    await act(async () => {
      setNativeInputValue(
        document.body.querySelector<HTMLInputElement>('#deepseek-api-key')!,
        'sk-updated'
      );
    });
    await act(async () => {
      setNativeInputValue(getVisibleDeepSeekEndpointInput()!, 'https://llm.example.com/open/v1');
    });

    await selectTab('DeepSeek official');
    expect(getVisibleDeepSeekEndpointInput()).toBeNull();
    expect(document.body.querySelector<HTMLInputElement>('#deepseek-api-key')?.value).toBe(
      'sk-updated'
    );

    await selectTab('Custom Endpoint');
    expect(getVisibleDeepSeekEndpointInput()?.value).toBe('https://llm.example.com/open/v1');

    await selectTab('DeepSeek official');
    await act(async () => {
      getPrimaryAction('Save').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          DEEPSEEK_API_KEY: 'sk-updated',
          DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
        },
      })
    );
  });

  it('ignores protected DeepSeek env keys typed in the additional environment textarea', async () => {
    const onSubmit = vi.fn(async (_payload: AgentConfigSubmitPayload) => {});
    await renderDeepSeekCreate(onSubmit);

    await act(async () => {
      setNativeInputValue(
        document.body.querySelector<HTMLInputElement>('#deepseek-api-key')!,
        'sk-deepseek-test'
      );
    });

    const envTextArea = await openAdditionalEnvSection();
    await act(async () => {
      setNativeTextAreaValue(
        envTextArea,
        [
          'DEEPSEEK_API_KEY=sk-from-textarea',
          'DEEPSEEK_BASE_URL=https://evil.example.com',
          'ACP_EXTENSION_DSH_MODELS=["evil-model"]',
          'EXTRA_FLAG=1',
        ].join('\n')
      );
    });
    expect(envTextArea.value).toContain('EXTRA_FLAG=1');
    expect(envTextArea.value).not.toContain('DEEPSEEK_API_KEY');
    expect(envTextArea.value).not.toContain('DEEPSEEK_BASE_URL');
    expect(envTextArea.value).not.toContain('ACP_EXTENSION_DSH_MODELS');

    await act(async () => {
      getPrimaryAction('Create').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          EXTRA_FLAG: '1',
          DEEPSEEK_API_KEY: 'sk-deepseek-test',
          DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
        },
      })
    );
  });

  it('keeps the draft config id stable when create mode props are recreated', async () => {
    const onSubmit = vi.fn(async (_payload: AgentConfigSubmitPayload) => {});
    const clickSave = async () => {
      const createButton = Array.from(document.body.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Create'
      );
      await act(async () => {
        createButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    };

    await renderDialog(
      { kind: 'create', initialForm: { name: 'Claude' } },
      createMachine('Workstation'),
      onSubmit
    );
    await clickSave();
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const firstId = onSubmit.mock.calls[0]?.[0].id;

    await renderDialog(
      { kind: 'create', initialForm: { name: 'Claude' } },
      createMachine('Workstation refreshed'),
      onSubmit
    );
    await clickSave();
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());

    expect(onSubmit.mock.calls.every(([payload]) => payload.id === firstId)).toBe(true);
  });

  it('shows the managed Kimi Node requirement before create', async () => {
    const onSubmit = vi.fn(async () => {});
    await renderDialog(
      { kind: 'create', initialForm: { name: 'Kimi Code' } },
      createMachine('Old Node workstation'),
      onSubmit,
      vi.fn(async () => ({
        status: 'incompatible-host' as const,
        current: '22.18.0',
        required: '22.19.0',
      }))
    );

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain(
        'Kimi Code requires Node ≥22.19.0; this machine is using 22.18.0.'
      );
    });
    const createButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Create'
    );
    expect(createButton?.disabled).toBe(true);
    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('prepares managed Kimi before creating it when its runtime is not downloaded', async () => {
    const onSubmit = vi.fn(async () => {});
    let finishRefresh: ((value: Awaited<ReturnType<RefreshCapabilities>>) => void) | undefined;
    const onRefreshCapabilities = vi.fn<RefreshCapabilities>(
      () =>
        new Promise((resolve) => {
          finishRefresh = (value) => resolve(value);
        })
    );
    await renderDialog(
      { kind: 'create', initialForm: { name: 'Kimi Code' } },
      createMachine('Fresh workstation'),
      onSubmit,
      vi.fn(async () => ({ status: 'not-installed' as const })),
      onRefreshCapabilities
    );

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain(
        'Lody will download and verify it before creating this provider.'
      );
    });
    const createButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Create'
    );
    expect(createButton?.disabled).toBe(false);
    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await vi.waitFor(() => expect(onRefreshCapabilities).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.invocationCallOrder[0]).toBeLessThan(
      onRefreshCapabilities.mock.invocationCallOrder[0]!
    );

    await act(async () => {
      finishRefresh?.({
        type: 'machine/acp-capabilities-refresh_response',
        machineId,
        configId: onRefreshCapabilities.mock.calls[0]![0].configId,
        cliType: 'builtin',
        agentType: 'kimi',
        success: true,
      });
    });
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
  });

  it('persists a managed builtin setup without waiting for its runtime download', async () => {
    const onSubmit = vi.fn(async (_payload: AgentConfigSubmitPayload) => {});
    const onRefreshCapabilities = vi.fn<RefreshCapabilities>();
    await renderDialog(
      {
        kind: 'create',
        initialForm: { name: 'Codex', cliType: 'builtin', agentType: 'codex' },
      },
      createMachine('Fresh workstation', { providerSetup: PROVIDER_SETUP_PROTOCOL_VERSION }),
      onSubmit,
      vi.fn(async () => ({ status: 'not-installed' as const })),
      onRefreshCapabilities
    );

    expect(document.body.textContent).toContain(
      'Lody will download and verify it in the background after you add this provider.'
    );
    const createButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Create'
    );
    if (!createButton) throw new Error('Expected the Create button');
    await act(async () => {
      createButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      cliType: 'builtin',
      agentType: 'codex',
      backgroundSetup: true,
    });
    expect(onRefreshCapabilities).not.toHaveBeenCalled();
  });

  it.each([{ agentType: 'codex', name: 'Codex', accountName: 'ChatGPT' }])(
    'requires $accountName sign-in before creating the provider when credentials are missing',
    async ({ agentType, name, accountName }) => {
      const onSubmit = vi.fn(async () => {});
      const onRefreshCapabilities = vi.fn<RefreshCapabilities>(async (args) => ({
        type: 'machine/acp-capabilities-refresh_response',
        machineId: args.machineId,
        configId: args.configId,
        cliType: 'builtin',
        agentType,
        success: false,
        authRequired: true,
        authMethods: [],
        error: 'Authentication required',
      }));
      await renderDialog(
        {
          kind: 'create',
          initialForm: { name, cliType: 'builtin', agentType },
        },
        createMachine('Fresh workstation'),
        onSubmit,
        vi.fn(async () => ({ status: 'installed' as const })),
        onRefreshCapabilities
      );

      const createButton = Array.from(document.body.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Create'
      );
      expect(createButton).toBeDefined();
      await act(async () => {
        createButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain(`Sign in with ${accountName}`);
      });
      expect(onRefreshCapabilities).toHaveBeenCalledOnce();
      expect(onSubmit).toHaveBeenCalledOnce();
      expect(onSubmit.mock.invocationCallOrder[0]).toBeLessThan(
        onRefreshCapabilities.mock.invocationCallOrder[0]!
      );
    }
  );

  it('continues the pending create after provider sign-in and post-login verification succeed', async () => {
    const authenticationRequestId = 'auth-request';
    vi.spyOn(machineAuthenticationHook, 'useMachineAcpAuthentication').mockReturnValue({
      startAuthentication: () => ({
        requestId: authenticationRequestId,
        promise: Promise.resolve({
          type: 'machine/acp-authenticate_response',
          machineId,
          requestId: authenticationRequestId,
          agentType: 'codex',
          success: true,
          disposition: 'authenticated',
          capabilitiesRefreshed: true,
        }),
      }),
      cancelAuthentication: vi.fn(),
      submitAuthorizationCode: vi.fn(async () => {}),
      submitAuthenticationInput: vi.fn(async () => {}),
    });
    vi.spyOn(window, 'open').mockReturnValue(null);
    const onSubmit = vi.fn(async () => {});
    const onRefreshCapabilities = vi.fn<RefreshCapabilities>(async (args) => ({
      type: 'machine/acp-capabilities-refresh_response',
      machineId: args.machineId,
      configId: args.configId,
      cliType: 'builtin',
      agentType: 'codex',
      success: false,
      authRequired: true,
      authMethods: [],
      error: 'Authentication required',
    }));
    await renderDialog(
      {
        kind: 'create',
        initialForm: { name: 'Codex', cliType: 'builtin', agentType: 'codex' },
      },
      createMachine('Fresh workstation'),
      onSubmit,
      vi.fn(async () => ({ status: 'installed' as const })),
      onRefreshCapabilities
    );

    const createButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Create'
    );
    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const signInButton = await vi.waitFor(() => {
      const button = Array.from(document.body.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === 'Sign in with ChatGPT'
      );
      expect(button).toBeDefined();
      return button;
    });

    await act(async () => {
      signInButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onRefreshCapabilities).toHaveBeenCalledOnce();
  });

  it.each([{ agentType: 'codex', name: 'Codex' }])(
    'automatically creates a verified $agentType provider after its live probe succeeds',
    async ({ agentType, name }) => {
      const onSubmit = vi.fn(async () => {});
      const onRefreshCapabilities = vi.fn<RefreshCapabilities>(async (args) => ({
        type: 'machine/acp-capabilities-refresh_response',
        machineId: args.machineId,
        configId: args.configId,
        cliType: 'builtin',
        agentType,
        success: true,
      }));
      await renderDialog(
        {
          kind: 'create',
          initialForm: { name, cliType: 'builtin', agentType },
        },
        createMachine('Ready workstation'),
        onSubmit,
        vi.fn(async () => ({ status: 'installed' as const })),
        onRefreshCapabilities
      );

      const createButton = Array.from(document.body.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Create'
      );
      await act(async () => {
        createButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
      expect(onRefreshCapabilities).toHaveBeenCalledOnce();
      expect(onSubmit.mock.invocationCallOrder[0]).toBeLessThan(
        onRefreshCapabilities.mock.invocationCallOrder[0]!
      );
    }
  );

  it('persists the provider before probing and surfaces a live-probe failure', async () => {
    const onSubmit = vi.fn(async () => {});
    const onRefreshCapabilities = vi.fn<RefreshCapabilities>(async (args) => ({
      type: 'machine/acp-capabilities-refresh_response',
      machineId: args.machineId,
      configId: args.configId,
      cliType: 'builtin',
      agentType: 'codex',
      success: false,
      error: 'Codex could not reach OpenAI',
    }));
    await renderDialog(
      {
        kind: 'create',
        initialForm: { name: 'Codex', cliType: 'builtin', agentType: 'codex' },
      },
      createMachine('Offline workstation'),
      onSubmit,
      vi.fn(async () => ({ status: 'installed' as const })),
      onRefreshCapabilities
    );

    const createButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Create'
    );
    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Codex could not reach OpenAI');
    });
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.invocationCallOrder[0]).toBeLessThan(
      onRefreshCapabilities.mock.invocationCallOrder[0]!
    );
  });

  it('revalidates a built-in provider when its environment changes after a successful test', async () => {
    const onSubmit = vi.fn(async () => {});
    const onRefreshCapabilities = vi.fn<RefreshCapabilities>(async (args) => ({
      type: 'machine/acp-capabilities-refresh_response',
      machineId: args.machineId,
      configId: args.configId,
      cliType: 'builtin',
      agentType: 'codex',
      success: true,
    }));
    await renderDialog(
      {
        kind: 'create',
        initialForm: { name: 'Codex', cliType: 'builtin', agentType: 'codex' },
      },
      createMachine('Ready workstation'),
      onSubmit,
      vi.fn(async () => ({ status: 'installed' as const })),
      onRefreshCapabilities
    );

    const testButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Test'
    );
    await act(async () => {
      testButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await vi.waitFor(() => expect(onRefreshCapabilities).toHaveBeenCalledOnce());

    const environmentButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Environment variables')
    );
    await act(async () => {
      environmentButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const envTextArea = Array.from(
      document.body.querySelectorAll<HTMLTextAreaElement>('textarea')
    ).at(-1);
    expect(envTextArea).toBeDefined();
    await act(async () => {
      setNativeTextAreaValue(envTextArea!, 'OPENAI_API_KEY=changed');
    });

    const createButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Create'
    );
    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onRefreshCapabilities).toHaveBeenCalledTimes(2);
  });

  const findSignInAgainButton = (): HTMLButtonElement | undefined =>
    Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Sign in again'
    );

  const renderEditingBuiltin = (overrides: Partial<AgentConfigMeta>) =>
    renderDialog(
      {
        kind: 'edit',
        config: {
          id: claudeConfigId,
          machineId,
          name: 'Provider',
          description: undefined,
          cliType: 'builtin',
          agentType: 'claude',
          env: {},
          ...overrides,
        } as AgentConfigMeta,
      },
      createMachine('Workstation')
    );

  it.each(['claude'] as const)(
    'offers signing in again while editing the built-in %s provider',
    async (agentType) => {
      await renderEditingBuiltin({ agentType });

      expect(findSignInAgainButton()).toBeDefined();
    }
  );

  it.each([
    {
      label: 'a DeepSeek preset',
      overrides: {
        brandId: 'deepseek' as const,
        env: {
          ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
          ANTHROPIC_AUTH_TOKEN: 'sk-test',
        },
      },
    },
  ])('hides signing in again while editing $label', async ({ overrides }) => {
    await renderEditingBuiltin(overrides);

    expect(findSignInAgainButton()).toBeUndefined();
  });

  // Claude, Codex and Grok generate their own title over ACP, so the setting is
  // obsolete for them. Kimi keeps it (covered by the normalization test below).
  it.each(['claude', 'codex', 'grok'])(
    'hides the title generation section for builtin %s',
    async (agentType) => {
      await renderDialog(
        { kind: 'edit', config: createBuiltinConfig({ name: 'ACP-owned', agentType }) },
        createTitleConfigMachine()
      );

      expect(document.body.textContent).not.toContain('Title generation');
    }
  );

  it.each([true, false])(
    'uses advertised title ownership in settings: %s',
    async (sessionTitle) => {
      const machine = createTitleConfigMachine();
      const entry = machine.acpCapabilities?.[getAcpCapabilityCacheKey(kimiConfigId)];
      if (!entry) throw new Error('Missing capability fixture');
      entry.sessionTitle = sessionTitle;
      await renderDialog({ kind: 'edit', config: createBuiltinConfig() }, machine);
      expect(document.body.textContent?.includes('Title generation')).toBe(!sessionTitle);
    }
  );

  it.each([true, false])(
    'only hides custom title settings for the matching command: %s',
    async (matches) => {
      const customAcp = { command: 'title-agent', args: ['--acp'] };
      const machine = createTitleConfigMachine();
      const entry = machine.acpCapabilities?.[getAcpCapabilityCacheKey(kimiConfigId)];
      if (!entry) throw new Error('Missing capability fixture');
      Object.assign(entry, {
        cliType: 'custom',
        agentType: 'custom-title',
        sessionTitle: true,
        sourceVersion: `custom:${serializeCustomAcpLaunchSpec(matches ? customAcp : { command: 'other-agent' })}`,
      });
      await renderDialog(
        {
          kind: 'edit',
          config: createBuiltinConfig({
            cliType: 'custom',
            agentType: 'custom-title',
            customAcp,
          }),
        },
        machine
      );
      expect(document.body.textContent?.includes('Title generation')).toBe(!matches);
    }
  );

  it('shows a test hint while idle and updates title options in the open dialog after testing', async () => {
    const mode: AgentConfigDialogMode = { kind: 'edit', config: createBuiltinConfig() };
    const onSubmit = vi.fn(async () => {});
    let finishProbe!: (response: Awaited<ReturnType<RefreshCapabilities>>) => void;
    const onRefreshCapabilities: RefreshCapabilities = () =>
      new Promise((resolve) => {
        finishProbe = resolve;
      });
    const onCheckBinaryStatus = vi.fn(async () => ({ status: 'installed' as const }));
    const renderMachine = (machine: MachineViewMeta) =>
      renderDialog(mode, machine, onSubmit, onCheckBinaryStatus, onRefreshCapabilities);

    await renderMachine(createMachine('Workstation'));
    expect(document.body.textContent).toContain('Click Test to refresh available options.');
    expect(document.body.textContent).not.toContain('Probing capabilities…');

    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('button[aria-label="Test agent capabilities"]')!
        .click();
    });
    expect(document.body.textContent).toContain('Probing capabilities…');
    expect(document.body.textContent).not.toContain('Click Test to refresh available options.');

    // The settings owner supplies a fresh Machine row without replacing dialog mode.
    await renderMachine(createTitleConfigMachine());
    await act(async () => {
      finishProbe({
        type: 'machine/acp-capabilities-refresh_response',
        machineId,
        configId: kimiConfigId,
        cliType: 'builtin',
        agentType: 'kimi',
        success: true,
      });
    });
    expect(document.body.textContent).toContain('Kimi K2');
    expect(document.body.textContent).not.toContain('Probing capabilities…');
    await act(async () => {
      Array.from(document.body.querySelectorAll('button'))
        .find((button) => button.textContent?.trim() === 'Save')!
        .click();
    });
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        titleGeneration: expect.objectContaining({
          configOptionValues: expect.objectContaining({ model: expect.any(String) }),
        }),
      })
    );
  });

  it('returns to the test hint after a failed capability probe', async () => {
    await renderDialog(
      { kind: 'edit', config: createBuiltinConfig() },
      createMachine('Workstation'),
      undefined,
      undefined,
      async () => {
        throw new Error('Agent unavailable');
      }
    );
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('button[aria-label="Test agent capabilities"]')!
        .click();
    });
    expect(document.body.textContent).toContain('Agent unavailable');
    expect(document.body.textContent).toContain('Click Test to refresh available options.');
    expect(document.body.textContent).not.toContain('Probing capabilities…');
  });

  it('saves a normalized title reasoning effort after the title model changes', async () => {
    const onSubmit = vi.fn(async () => {});
    const config = createBuiltinConfig({
      titleGeneration: {
        configOptionValues: {
          model: 'kimi-k2-turbo',
          reasoning_effort: 'ultra',
        },
      },
    });

    await renderDialog({ kind: 'edit', config }, createTitleConfigMachine(), onSubmit);

    expect(document.body.textContent).toContain('Title generation');

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save'
    );
    expect(saveButton).toBeDefined();
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        titleGeneration: {
          configOptionValues: {
            model: 'kimi-k2-turbo',
            reasoning_effort: 'medium',
          },
        },
      })
    );
  });
});
