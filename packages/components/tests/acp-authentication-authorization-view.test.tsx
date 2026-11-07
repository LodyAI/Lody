// @vitest-environment jsdom

import { act } from 'react';
import { Provider, createStore } from 'jotai';
import { localProbeAttemptedAtom, localProbeResultAtom } from '../src/atoms/local-probe';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getMachineRoomId,
  type AgentConfigId,
  type MachineAcpAuthenticateResponse,
  type MachineId,
} from '@lody/shared';
import { machineMetaCacheAtom } from '../src/atoms/doc-meta';
import * as authenticationHook from '../src/hooks/use-machine-acp-authentication';
import * as machineFlock from '../src/hooks/use-machine-flock-rows';

import {
  AcpAuthenticationPanel,
  AcpAuthenticationAuthorizationView,
  AcpAuthenticationInteractionView,
  isAllowedAcpAuthorizationUrl,
} from '../src/components/settings/acp-authentication-panel';
import { initI18n } from '../src/i18n';

describe('AcpAuthenticationAuthorizationView', () => {
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
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('shows remote guidance only for remote builtin Sorbet', async () => {
    const store = createStore();
    store.set(localProbeAttemptedAtom, true);
    store.set(localProbeResultAtom, { ok: true, machineId: 'local' });
    Object.defineProperty(window, '__LODY_ELECTRON__', { configurable: true, value: true });
    const renderPanel = async (machineId: string, agentType: string) => {
      await act(async () => {
        root.render(
          <Provider store={store}>
            <AcpAuthenticationPanel
              machineId={machineId as MachineId}
              cliType="builtin"
              agentType={agentType}
            />
          </Provider>
        );
      });
    };
    try {
      await renderPanel('remote', 'sorbet');
      expect(container.textContent).toContain('choose device sign-in');
      expect(container.textContent).toContain('localhost callback points to the remote machine');
      expect(container.textContent).toContain('Radius supports device sign-in');
      await renderPanel('local', 'sorbet');
      expect(container.textContent).not.toContain('choose device sign-in');
      await renderPanel('remote', 'codex');
      expect(container.textContent).not.toContain('choose device sign-in');
    } finally {
      Reflect.deleteProperty(window, '__LODY_ELECTRON__');
    }
  });

  it.each([
    { progress: true, verified: true },
    { progress: true, verified: false },
    { progress: false, verified: true },
  ])(
    'handles authentication progress=$progress and verification=$verified',
    async ({ progress, verified }) => {
      vi.spyOn(window, 'open').mockReturnValue(null);
      const store = createStore();
      const machineId = 'local' as MachineId;
      store.set(machineMetaCacheAtom, {
        [getMachineRoomId(machineId)]: {
          id: machineId,
          protocolCapabilities: { acpAuthenticationInteractions: 2 },
        } as never,
      });
      let onProgress:
        | NonNullable<authenticationHook.MachineAcpAuthenticationArgs['onProgress']>
        | undefined;
      let resolveResponse!: (response: MachineAcpAuthenticateResponse) => void;
      const promise = new Promise<MachineAcpAuthenticateResponse>((resolve) => {
        resolveResponse = resolve;
      });
      vi.spyOn(authenticationHook, 'useMachineAcpAuthentication').mockReturnValue({
        startAuthentication: (args) => {
          onProgress = args.onProgress;
          return { requestId: 'auth-1', promise };
        },
        cancelAuthentication: vi.fn(),
        submitAuthorizationCode: vi.fn(),
        submitAuthenticationInput: vi.fn(),
      });
      vi.spyOn(machineFlock, 'resyncMachineFlockRows').mockResolvedValue(undefined as never);
      const onAuthenticated = vi.fn();
      await act(async () => {
        root.render(
          <Provider store={store}>
            <AcpAuthenticationPanel
              machineId={machineId}
              configId={'provider-1' as AgentConfigId}
              cliType="builtin"
              agentType="codex"
              onAuthenticated={onAuthenticated}
            />
          </Provider>
        );
      });
      const start = Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Sign in with')
      );
      expect(start?.disabled).toBe(false);
      await act(async () => {
        start?.click();
      });
      const base = {
        type: 'machine/acp-authentication-progress' as const,
        machineId,
        requestId: 'auth-1',
        agentType: 'codex',
      };
      await act(async () => {
        onProgress?.({
          ...base,
          status: 'authorization',
          authorizationUrl: 'https://example.test',
          requiresAuthorizationConsent: true,
          interactionId: 'consent-1',
        });
      });
      expect(container.textContent).toContain('Finish signing in');
      if (progress) {
        await act(async () => {
          onProgress?.({ ...base, status: 'authenticated' });
        });
        expect(container.textContent).toContain('Sign-in completed. Verifying provider');
        expect(container.textContent).not.toContain('Waiting for');
        expect(container.textContent).not.toContain('Finish signing in');
        expect(container.textContent).toContain('Cancel');
      } else {
        expect(container.textContent).toContain('Waiting for');
      }
      expect(onAuthenticated).not.toHaveBeenCalled();
      await act(async () => {
        resolveResponse({
          type: 'machine/acp-authenticate_response',
          machineId,
          requestId: 'auth-1',
          agentType: 'codex',
          success: true,
          disposition: 'authenticated',
          capabilitiesRefreshed: verified,
          ...(!verified ? { authRequired: true, error: 'Authentication required' } : {}),
        });
        await promise;
      });
      expect(container.textContent).not.toContain('Verifying provider');
      if (verified) {
        expect(container.textContent).toContain('sign-in completed');
        expect(onAuthenticated).toHaveBeenCalledOnce();
      } else {
        expect(container.textContent).toContain('Authentication required');
        expect(onAuthenticated).not.toHaveBeenCalled();
      }
    }
  );

  it('names the waiting step with the time spent so far', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-11-05T10:00:00Z'));
    try {
      vi.spyOn(window, 'open').mockReturnValue(null);
      const store = createStore();
      const machineId = 'local' as MachineId;
      store.set(machineMetaCacheAtom, {
        [getMachineRoomId(machineId)]: {
          id: machineId,
          protocolCapabilities: { acpAuthenticationInteractions: 2 },
        } as never,
      });
      vi.spyOn(authenticationHook, 'useMachineAcpAuthentication').mockReturnValue({
        startAuthentication: () => ({
          requestId: 'auth-1',
          promise: new Promise<MachineAcpAuthenticateResponse>(() => {}),
        }),
        cancelAuthentication: vi.fn(),
        submitAuthorizationCode: vi.fn(),
        submitAuthenticationInput: vi.fn(),
      });
      await act(async () => {
        root.render(
          <Provider store={store}>
            <AcpAuthenticationPanel
              machineId={machineId}
              configId={'provider-1' as AgentConfigId}
              cliType="builtin"
              agentType="codex"
            />
          </Provider>
        );
      });
      const start = () =>
        Array.from(container.querySelectorAll('button')).find((button) =>
          button.textContent?.includes('Sign in with')
        );
      await act(async () => {
        start()?.click();
      });
      const status = () => container.querySelector('[role="status"]');
      expect(status()?.textContent).toContain('Waiting for');
      expect(status()?.textContent).toContain('0:00');
      await act(async () => {
        vi.advanceTimersByTime(67_000);
      });
      expect(status()?.textContent).toContain('1:07');
      // Waiting is not an action, so it is not drawn as a button.
      expect(
        Array.from(container.querySelectorAll('button')).some((button) =>
          button.textContent?.includes('Waiting for')
        )
      ).toBe(false);

      expect(
        Array.from(container.querySelectorAll('button')).some(
          (button) => button.textContent?.trim() === 'Cancel'
        )
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lays sign-in methods out as rows and waits in the row that was chosen', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const store = createStore();
    const machineId = 'local' as MachineId;
    const configId = 'lody-agent' as AgentConfigId;
    store.set(machineMetaCacheAtom, {
      [getMachineRoomId(machineId)]: {
        id: machineId,
        protocolCapabilities: {
          acpAuthenticationInteractions: 2,
          acpAuthenticationMethodSelection: 1,
        },
        acpCapabilities: {
          [configId]: {
            cliType: 'builtin',
            agentType: 'sorbet',
            cacheVersion: 12,
            modes: [],
            models: [],
            fetchedAt: 1,
            authMethods: [
              {
                id: 'anthropic:oauth',
                name: 'Claude',
                description: 'Use your Claude subscription',
                type: 'agent',
              },
              { id: 'openai:oauth', name: 'ChatGPT', type: 'agent' },
            ],
          },
        },
      } as never,
    });
    const started: (string | undefined)[] = [];
    vi.spyOn(authenticationHook, 'useMachineAcpAuthentication').mockReturnValue({
      startAuthentication: (args) => {
        started.push(args.methodId);
        return {
          requestId: 'auth-1',
          promise: new Promise<MachineAcpAuthenticateResponse>(() => {}),
        };
      },
      cancelAuthentication: vi.fn(),
      submitAuthorizationCode: vi.fn(),
      submitAuthenticationInput: vi.fn(),
    });
    await act(async () => {
      root.render(
        <Provider store={store}>
          <AcpAuthenticationPanel
            machineId={machineId}
            configId={configId}
            cliType="builtin"
            agentType="sorbet"
            layout="rows"
          />
        </Provider>
      );
    });
    const row = (name: string) =>
      Array.from(container.querySelectorAll('[data-auth-method-id]')).find((item) =>
        item.textContent?.includes(name)
      )!;
    const signIn = (name: string) =>
      Array.from(row(name).querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Sign in'
      );
    expect(row('Claude').textContent).toContain('Use your Claude subscription');
    expect(container.textContent).not.toContain('Choose a sign-in method');

    await act(async () => {
      signIn('ChatGPT')?.click();
    });
    expect(started).toEqual(['openai:oauth']);
    // The wait replaces the button the person pressed, in that row.
    expect(row('ChatGPT').querySelector('[role="status"]')?.textContent).toContain('0:00');
    expect(signIn('ChatGPT')).toBeUndefined();
    expect(
      Array.from(row('ChatGPT').querySelectorAll('button')).some(
        (button) => button.textContent?.trim() === 'Cancel'
      )
    ).toBe(true);
    expect(signIn('Claude')?.disabled).toBe(true);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it('starts the selected custom endpoint API key method', async () => {
    const store = createStore();
    const machineId = 'local' as MachineId;
    const configId = 'lody-agent' as AgentConfigId;
    store.set(machineMetaCacheAtom, {
      [getMachineRoomId(machineId)]: {
        id: machineId,
        protocolCapabilities: {
          acpAuthenticationInteractions: 2,
          acpAuthenticationMethodSelection: 1,
        },
        acpCapabilities: {
          [configId]: {
            cliType: 'builtin',
            agentType: 'sorbet',
            cacheVersion: 12,
            modes: [],
            models: [],
            authMethods: [
              { id: 'sorbet:gateway:api_key', name: 'Gateway API key', type: 'agent' },
              { id: 'sorbet:other:api_key', name: 'Other API key', type: 'agent' },
            ],
          },
        },
      } as never,
    });
    const started: (string | undefined)[] = [];
    let onProgress: authenticationHook.MachineAcpAuthenticationArgs['onProgress'];
    vi.spyOn(authenticationHook, 'useMachineAcpAuthentication').mockReturnValue({
      startAuthentication: (args) => {
        started.push(args.methodId);
        onProgress = args.onProgress;
        return {
          requestId: 'auth-1',
          promise: new Promise<MachineAcpAuthenticateResponse>(() => {}),
        };
      },
      cancelAuthentication: vi.fn(),
      submitAuthorizationCode: vi.fn(),
      submitAuthenticationInput: vi.fn(),
    });
    await act(async () =>
      root.render(
        <Provider store={store}>
          <AcpAuthenticationPanel
            machineId={machineId}
            configId={configId}
            cliType="builtin"
            agentType="sorbet"
            layout="action"
            onlyMethodId="sorbet:gateway:api_key"
          />
        </Provider>
      )
    );
    const action = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Enter API key'
    );
    expect(action?.disabled).toBe(false);
    await act(async () => action?.click());
    expect(started).toEqual(['sorbet:gateway:api_key']);
    expect(document.body.querySelector('[role="dialog"] [role="status"]')).not.toBeNull();
    await act(async () =>
      onProgress?.({
        type: 'machine/acp-authentication-progress',
        machineId,
        requestId: 'auth-1',
        agentType: 'sorbet',
        status: 'input-required',
        interactionId: 'key-form',
        message: 'Enter your API key',
        form: { fields: [{ id: 'key', type: 'secret', label: 'API key', required: true }] },
      })
    );
    expect(document.body.querySelector('[role="dialog"] input[type="password"]')).not.toBeNull();
  });

  it('explains the remote return value when a code can be submitted', async () => {
    await act(async () => {
      root.render(
        <AcpAuthenticationAuthorizationView
          provider="Lody Agent"
          authorization={{
            authorizationUrl: 'https://example.test',
            acceptsAuthorizationCode: true,
          }}
          authorizationCode=""
          authorizationCodeSubmitted={false}
          submittingAuthorizationCode={false}
          userCodeCopied={false}
          onOpenAuthorization={vi.fn()}
          onCopyUserCode={vi.fn()}
          onAuthorizationCodeChange={vi.fn()}
          onSubmitAuthorizationCode={vi.fn()}
          remoteSorbet
        />
      );
    });
    expect(container.textContent).toContain('Paste the code or return URL');
    expect(container.textContent).not.toContain('returning automatically');
  });

  it('allows only HTTP(S) authorization pages', () => {
    expect(isAllowedAcpAuthorizationUrl('https://provider.example.test/oauth')).toBe(true);
    expect(isAllowedAcpAuthorizationUrl('http://127.0.0.1:8787/callback')).toBe(true);
    expect(isAllowedAcpAuthorizationUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedAcpAuthorizationUrl('file:///tmp/credential')).toBe(false);
    expect(isAllowedAcpAuthorizationUrl('not a url')).toBe(false);
  });

  it('renders ACP method selection and submits the selected method id', async () => {
    const onSubmit = vi.fn();
    await act(async () => {
      root.render(
        <AcpAuthenticationInteractionView
          interaction={{
            type: 'methods',
            interactionId: 'methods-1',
            methods: [
              { type: 'agent', id: 'oauth', name: 'Browser OAuth' },
              { type: 'terminal', id: 'terminal', name: 'Terminal login' },
            ],
          }}
          values={{}}
          submitting={false}
          onValuesChange={vi.fn()}
          onSubmit={onSubmit}
        />
      );
    });

    const oauth = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Browser OAuth')
    );
    await act(async () => oauth?.click());
    expect(onSubmit).toHaveBeenCalledWith({ action: 'accept', methodId: 'oauth' });
    expect(container.textContent).not.toContain('Terminal login');
  });

  it('renders text, secret, and select authentication fields without exposing secret input', async () => {
    const onSubmit = vi.fn();
    await act(async () => {
      root.render(
        <AcpAuthenticationInteractionView
          interaction={{
            type: 'form',
            interactionId: 'form-1',
            message: 'Complete provider sign-in',
            form: {
              fields: [
                { id: 'email', type: 'text', label: 'Email', required: true },
                { id: 'token', type: 'secret', label: 'Token', required: true },
                {
                  id: 'account',
                  type: 'select',
                  label: 'Account',
                  required: true,
                  options: [{ value: 'work', label: 'Work' }],
                },
              ],
            },
          }}
          values={{ email: 'user@example.com', token: 'hidden', account: 'work' }}
          submitting={false}
          onValuesChange={vi.fn()}
          onSubmit={onSubmit}
        />
      );
    });

    expect(container.querySelectorAll('input')[0]?.type).toBe('text');
    expect(container.querySelectorAll('input')[1]?.type).toBe('password');
    expect(container.querySelector('[role="combobox"]')?.textContent).toBe('Work');
    const continueButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Continue')
    );
    await act(async () => continueButton?.click());
    expect(onSubmit).toHaveBeenCalledWith({
      action: 'accept',
      content: { email: 'user@example.com', token: 'hidden', account: 'work' },
    });
  });
});
