// @vitest-environment jsdom

import { act, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  ACP_CAPABILITY_CACHE_VERSION,
  PROVIDER_SETUP_PROTOCOL_VERSION,
  getAcpCapabilityCacheKey,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineId,
  type MachineViewMeta,
} from '@lody/shared';
import {
  AgentConfigDialog,
  type AgentConfigDialogMode,
  type AgentConfigSubmitPayload,
} from '../src/components/settings/agent-config-dialog';
import * as machineAuthenticationHook from '../src/hooks/use-machine-acp-authentication';
import { initI18n } from '../src/i18n';
import { TooltipProvider } from '../src/ui/tooltip';

const machineId = 'machine-test' as MachineId;
const claudeConfigId = 'claude-config' as AgentConfigId;
const codexConfigId = 'codex-config' as AgentConfigId;
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

const createCodexMachine = (): MachineViewMeta => ({
  ...createMachine('Codex workstation'),
  acpCapabilities: {
    [getAcpCapabilityCacheKey(codexConfigId)]: {
      cliType: 'builtin',
      agentType: 'codex',
      cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
      sourceVersion: 'codex@1.0.0',
      modes: [],
      models: [],
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'gpt-5.6-sol',
          options: [
            { value: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
            { value: 'gpt-5.6-other', name: 'GPT-5.6 Other' },
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
      availableCommands: [],
      fetchedAt: Date.now(),
    },
  },
});

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

  beforeEach(async () => {
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
      cliType: args.cliType,
      agentType: args.agentType,
      success: true,
    }),
    onManagedRuntimeSelected?: ComponentProps<typeof AgentConfigDialog>['onManagedRuntimeSelected']
  ) => {
    await act(async () => {
      root?.render(
        <TooltipProvider>
          <AgentConfigDialog
            open
            onOpenChange={vi.fn()}
            mode={mode}
            machine={machine}
            onSubmit={onSubmit}
            onRefreshCapabilities={onRefreshCapabilities}
            onCheckBinaryStatus={onCheckBinaryStatus}
            onManagedRuntimeSelected={onManagedRuntimeSelected}
          />
        </TooltipProvider>
      );
    });
  };

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

  it('collects the DeepSeek API Key directly and keeps Harness out of managed runtime setup', async () => {
    const onManagedRuntimeSelected = vi.fn();
    const onCheckBinaryStatus = vi.fn(async () => ({ status: 'not-installed' as const }));
    const onSubmit = vi.fn(async (_payload: AgentConfigSubmitPayload) => {});
    await renderDialog(
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

    expect(onManagedRuntimeSelected).not.toHaveBeenCalled();
    expect(onCheckBinaryStatus).not.toHaveBeenCalled();
    const apiKeyInput = document.body.querySelector<HTMLInputElement>('#deepseek-api-key');
    expect(apiKeyInput?.type).toBe('password');
    const createButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Create'
    );
    expect(createButton?.disabled).toBe(true);

    await act(async () => {
      setNativeInputValue(apiKeyInput!, 'sk-deepseek-test');
    });

    const environmentSection = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Additional environment variables')
    );
    await act(async () => {
      environmentSection?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.textContent).toContain(
      'Optional: set DEEPSEEK_BASE_URL here to use a compatible endpoint.'
    );
    const envTextArea = Array.from(
      document.body.querySelectorAll<HTMLTextAreaElement>('textarea')
    ).at(-1);
    expect(envTextArea?.value).not.toContain('DEEPSEEK_API_KEY');
    await act(async () => {
      setNativeTextAreaValue(envTextArea!, 'DEEPSEEK_BASE_URL=https://api.deepseek.com');
    });
    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

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
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const firstId = onSubmit.mock.calls[0]?.[0].id;

    await renderDialog(
      { kind: 'create', initialForm: { name: 'Claude' } },
      createMachine('Workstation refreshed'),
      onSubmit
    );
    await clickSave();
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));

    expect(onSubmit.mock.calls[1]?.[0].id).toBe(firstId);
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
    expect(onSubmit).not.toHaveBeenCalled();

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
        cliType: args.cliType,
        agentType: args.agentType,
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
      expect(onSubmit).not.toHaveBeenCalled();
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
      cliType: args.cliType,
      agentType: args.agentType,
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
        cliType: args.cliType,
        agentType: args.agentType,
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
    }
  );

  it('does not create a built-in provider when its live probe fails', async () => {
    const onSubmit = vi.fn(async () => {});
    const onRefreshCapabilities = vi.fn<RefreshCapabilities>(async (args) => ({
      type: 'machine/acp-capabilities-refresh_response',
      machineId: args.machineId,
      configId: args.configId,
      cliType: args.cliType,
      agentType: args.agentType,
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
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('revalidates a built-in provider when its environment changes after a successful test', async () => {
    const onSubmit = vi.fn(async () => {});
    const onRefreshCapabilities = vi.fn<RefreshCapabilities>(async (args) => ({
      type: 'machine/acp-capabilities-refresh_response',
      machineId: args.machineId,
      configId: args.configId,
      cliType: args.cliType,
      agentType: args.agentType,
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

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
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

  it('saves a normalized title reasoning effort after the title model changes', async () => {
    const onSubmit = vi.fn(async () => {});
    const config = {
      id: codexConfigId,
      machineId,
      name: 'Codex',
      description: undefined,
      cliType: 'builtin',
      agentType: 'codex',
      env: {},
      titleGeneration: {
        configOptionValues: {
          model: 'gpt-5.6-other',
          reasoning_effort: 'ultra',
        },
      },
    } as AgentConfigMeta;

    await renderDialog({ kind: 'edit', config }, createCodexMachine(), onSubmit);

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
            model: 'gpt-5.6-other',
            reasoning_effort: 'medium',
          },
        },
      })
    );
  });
});
