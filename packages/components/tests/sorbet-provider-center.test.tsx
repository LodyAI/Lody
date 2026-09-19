// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MACHINE_PROTOCOL_CAPABILITIES,
  SORBET_PROVIDER_CENTER_PROTOCOL_VERSION,
  getMachineRoomId,
  type AgentConfigId,
  type MachineId,
  type MachineMeta,
  type SorbetProviderCenterOperation,
  type SorbetProviderCenterResponse,
  type SorbetProviderCenterSnapshot,
  type WorkspaceId,
} from '@lody/shared';

import { machineMetaCacheAtom } from '../src/atoms/doc-meta';
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '../src/atoms/workspace-context';
import { SorbetProviderCenter } from '../src/components/settings/sorbet-provider-center';
import { initI18n } from '../src/i18n';

vi.mock('../src/components/settings/acp-authentication-panel', () => ({
  AcpAuthenticationPanel: ({ providerName }: { providerName?: string }) => (
    <div data-testid={`authenticate-${providerName ?? 'provider'}`}>
      Authenticate {providerName}
    </div>
  ),
}));

const machineId = 'machine-sorbet' as MachineId;
const configId = 'config-sorbet' as AgentConfigId;
const workspaceId = 'workspace-sorbet' as WorkspaceId;
const workspaceSlug = 'workspace-sorbet';

const oauthSnapshot = (claudeOAuthEnabled = false): SorbetProviderCenterSnapshot => ({
  version: 1,
  claudeOAuthEnabled,
  defaultProviderId: 'openai-codex',
  defaultModelSelector: 'openai-codex/gpt-test',
  providers: [
    {
      id: 'openai-codex',
      name: 'Codex',
      kind: 'oauth',
      credentialType: 'oauth',
      connected: true,
      enabled: true,
      models: [{ id: 'gpt-test', selector: 'openai-codex/gpt-test' }],
    },
    {
      id: 'anthropic',
      name: 'Claude',
      kind: 'oauth',
      connected: false,
      enabled: claudeOAuthEnabled,
      models: [{ id: 'claude-test', selector: 'anthropic/claude-test' }],
    },
  ],
});

const response = (snapshot: SorbetProviderCenterSnapshot): SorbetProviderCenterResponse => ({
  type: 'machine/sorbet-provider-center_response',
  machineId,
  success: true,
  snapshot,
});

const buttonByText = (text: string): HTMLButtonElement => {
  const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.trim() === text
  );
  if (!button) throw new Error(`Expected button "${text}"`);
  return button;
};

const setInputValue = (input: HTMLInputElement, value: string): void => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
    input,
    value
  );
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const setTextAreaValue = (input: HTMLTextAreaElement, value: string): void => {
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set?.call(
    input,
    value
  );
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('SorbetProviderCenter', () => {
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

  const render = async ({
    supported = true,
    requestSorbetProviderCenter = vi.fn(async () => response(oauthSnapshot())),
    setSorbetProviderApiKey = vi.fn(async () => response(oauthSnapshot())),
    onChanged = vi.fn(),
  }: {
    supported?: boolean;
    requestSorbetProviderCenter?: WorkspaceRuntime['requestSorbetProviderCenter'];
    setSorbetProviderApiKey?: WorkspaceRuntime['setSorbetProviderApiKey'];
    onChanged?: () => void;
  } = {}) => {
    const store = createStore();
    store.set(runtimeAtom, {
      workspaceId,
      workspaceSlug,
      requestSorbetProviderCenter,
      setSorbetProviderApiKey,
    } as unknown as WorkspaceRuntime);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, workspaceSlug);
    store.set(machineMetaCacheAtom, {
      [getMachineRoomId(machineId)]: {
        id: machineId,
        name: 'Sorbet Machine',
        protocolCapabilities: supported
          ? {
              [MACHINE_PROTOCOL_CAPABILITIES.sorbetProviderCenter]:
                SORBET_PROVIDER_CENTER_PROTOCOL_VERSION,
            }
          : {},
      } as MachineMeta,
    });
    await act(async () => {
      root.render(
        <Provider store={store}>
          <SorbetProviderCenter
            machineId={machineId}
            configId={configId}
            onBeforeAuthenticate={vi.fn()}
            onChanged={onChanged}
          />
        </Provider>
      );
    });
    return { requestSorbetProviderCenter, setSorbetProviderApiKey, onChanged };
  };

  it('requires the Machine capability before issuing Provider Center RPCs', async () => {
    const requestSorbetProviderCenter = vi.fn(async () => response(oauthSnapshot()));
    await render({ supported: false, requestSorbetProviderCenter });

    expect(container.textContent).toContain(
      'Update or restart this Machine before configuring Sorbet Providers.'
    );
    expect(requestSorbetProviderCenter).not.toHaveBeenCalled();
  });

  it('enables Claude directly without a risk acknowledgement dialog', async () => {
    let snapshot = oauthSnapshot();
    const requestSorbetProviderCenter = vi.fn(
      async (_machineId: MachineId, operation: SorbetProviderCenterOperation) => {
        if (operation.action === 'set-claude-oauth-enabled') {
          snapshot = oauthSnapshot(operation.enabled);
        }
        return response(snapshot);
      }
    );
    const onChanged = vi.fn();
    await render({ requestSorbetProviderCenter, onChanged });
    await vi.waitFor(() => expect(container.textContent).toContain('Enable Claude OAuth'));

    await act(async () => {
      buttonByText('Enable Claude OAuth').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await vi.waitFor(() => {
      expect(requestSorbetProviderCenter).toHaveBeenCalledWith(machineId, {
        action: 'set-claude-oauth-enabled',
        enabled: true,
      });
    });
    expect(document.body.textContent).not.toContain('Review the risk');
    expect(document.body.textContent).not.toContain('I understand');
    expect(container.textContent).toContain('Authenticate Claude');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('creates a custom Provider and sends its API key only through the secret RPC', async () => {
    const operations: SorbetProviderCenterOperation[] = [];
    const requestSorbetProviderCenter = vi.fn(
      async (_machineId: MachineId, operation: SorbetProviderCenterOperation) => {
        operations.push(operation);
        return operation.action === 'create-custom'
          ? { ...response(oauthSnapshot()), affectedProviderId: 'custom-provider' }
          : response(oauthSnapshot());
      }
    );
    const setSorbetProviderApiKey = vi.fn(async () => response(oauthSnapshot()));
    const onChanged = vi.fn();
    await render({ requestSorbetProviderCenter, setSorbetProviderApiKey, onChanged });
    await vi.waitFor(() => expect(container.textContent).toContain('Custom Providers'));

    await act(async () => {
      buttonByText('Add').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const name = container.querySelector<HTMLInputElement>('input:not([type])');
    const endpoint = container.querySelector<HTMLInputElement>('input[type="url"]');
    const models = container.querySelector<HTMLTextAreaElement>('textarea');
    const apiKey = container.querySelector<HTMLInputElement>('input[type="password"]');
    if (!name || !endpoint || !models || !apiKey) throw new Error('Custom Provider form missing');

    await act(async () => {
      setInputValue(name, 'Local Provider');
      setInputValue(endpoint, 'http://127.0.0.1:4545/v1');
      setTextAreaValue(models, 'model-a\nmodel-a\nmodel-b');
      setInputValue(apiKey, 'secret-api-key');
    });
    await act(async () => {
      buttonByText('Save').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await vi.waitFor(() => {
      expect(setSorbetProviderApiKey).toHaveBeenCalledWith(
        machineId,
        'custom-provider',
        'secret-api-key'
      );
    });
    expect(operations).toContainEqual({
      action: 'create-custom',
      provider: {
        name: 'Local Provider',
        protocol: 'openai-responses',
        baseUrl: 'http://127.0.0.1:4545/v1',
        models: [{ id: 'model-a' }, { id: 'model-b' }],
      },
    });
    expect(JSON.stringify(operations)).not.toContain('secret-api-key');
    expect(onChanged).toHaveBeenCalledTimes(2);
  });
});
