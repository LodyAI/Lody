// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfigId, MachineId } from '@lody/shared';
import { LodyAgentAccountsController } from '../src/components/settings/lody-agent-accounts-controller';
import { activeWorkspaceRuntimeAtom } from '../src/atoms/runtime';
import { initI18n } from '../src/i18n';

const mocks = vi.hoisted(() => ({
  runtime: {
    requestLocalSorbetCredentials: vi.fn(),
    requestLocalSorbetProviders: vi.fn(),
  },
  local: 'machine-a',
}));
vi.mock('jotai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('jotai')>()),
  useAtomValue: (atom: unknown) =>
    atom === activeWorkspaceRuntimeAtom ? mocks.runtime : mocks.local,
}));

const machineId = 'machine-a' as MachineId;
const configId = 'config-a' as AgentConfigId;
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  mocks.runtime.requestLocalSorbetCredentials.mockReset();
  mocks.runtime.requestLocalSorbetProviders.mockReset();
});

/** React reads the native setter, so a plain assignment would not reach state. */
async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('LodyAgentAccountsController', () => {
  it('refreshes after login and ignores a response for an unmounted target', async () => {
    await initI18n();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    cleanup = async () => {
      await act(async () => root.unmount());
      container.remove();
    };
    let resolveOld!: (value: unknown) => void;
    mocks.runtime.requestLocalSorbetCredentials.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      })
    );
    mocks.runtime.requestLocalSorbetCredentials.mockResolvedValue({
      type: 'sorbet/credentials-list',
      credentials: [{ providerId: 'new', type: 'oauth' }],
    });
    await act(async () =>
      root.render(
        <LodyAgentAccountsController
          key="a"
          machineId={machineId}
          configId={configId}
          supported
          refreshVersion={0}
        />
      )
    );
    await act(async () =>
      root.render(
        <LodyAgentAccountsController
          key="b"
          machineId={machineId}
          configId={'config-b' as AgentConfigId}
          supported
          refreshVersion={0}
        />
      )
    );
    await act(async () =>
      resolveOld({
        type: 'sorbet/credentials-list',
        credentials: [{ providerId: 'old', type: 'oauth' }],
      })
    );
    expect(container.textContent).toContain('new');
    expect(container.textContent).not.toContain('old');
    mocks.runtime.requestLocalSorbetCredentials.mockResolvedValue({
      type: 'sorbet/credentials-list',
      credentials: [{ providerId: 'signed-in', type: 'oauth' }],
    });
    await act(async () =>
      root.render(
        <LodyAgentAccountsController
          key="b"
          machineId={machineId}
          configId={'config-b' as AgentConfigId}
          supported
          refreshVersion={1}
        />
      )
    );
    expect(container.textContent).toContain('signed-in');
  });
  it('re-probes the agent after a custom provider is saved', async () => {
    await initI18n();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    cleanup = async () => {
      await act(async () => root.unmount());
      container.remove();
    };
    mocks.runtime.requestLocalSorbetCredentials.mockResolvedValue({
      type: 'sorbet/credentials-list',
      credentials: [],
    });
    mocks.runtime.requestLocalSorbetProviders.mockImplementation(async (_machine, request) =>
      request.method === 'sorbet/providers-create'
        ? {
            type: 'sorbet/providers-create',
            provider: { id: 'created-1', ...request.params.provider },
          }
        : { type: 'sorbet/providers-list', providers: [] }
    );
    const onProvidersChanged = vi.fn(async () => {});
    await act(async () =>
      root.render(
        <LodyAgentAccountsController
          machineId={machineId}
          configId={configId}
          supported
          refreshVersion={0}
          onProvidersChanged={onProvidersChanged}
        />
      )
    );
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent?.trim() === 'Add provider')!
        .click()
    );
    await typeInto(container.querySelector('input[placeholder="Acme Gateway"]')!, 'Acme Gateway');
    await typeInto(
      container.querySelector('input[placeholder="https://gateway.example.com/v1"]')!,
      'https://gateway.acme.dev/v1'
    );
    await typeInto(
      container.querySelector('input[placeholder="acme-large, acme-small"]')!,
      'large'
    );
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent?.trim() === 'Save provider')!
        .click()
    );

    // The definition alone changes nothing a person can act on: the agent only
    // advertises `<provider>:api_key` once the capability probe reads it again.
    expect(onProvidersChanged).toHaveBeenCalledTimes(1);
    expect(
      mocks.runtime.requestLocalSorbetProviders.mock.calls.map(([, request]) => request.method)
    ).toContain('sorbet/providers-create');
  });

  it('reports an uncertain remote logout without retrying', async () => {
    await initI18n();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    cleanup = async () => {
      await act(async () => root.unmount());
      container.remove();
    };
    mocks.runtime.requestLocalSorbetCredentials.mockResolvedValueOnce({
      type: 'sorbet/credentials-list',
      credentials: [{ providerId: 'remote', type: 'oauth' }],
    });
    mocks.runtime.requestLocalSorbetCredentials.mockRejectedValueOnce(new Error('timeout'));
    await act(async () =>
      root.render(
        <LodyAgentAccountsController
          machineId={'remote' as MachineId}
          configId={configId}
          supported
          refreshVersion={0}
        />
      )
    );
    const remove = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Remove remote (oauth)'
    )!;
    await act(async () => remove.click());
    const dialog = document.querySelector('[role="alertdialog"]')!;
    await act(async () =>
      [...dialog.querySelectorAll('button')]
        .find((b) => b.textContent?.trim() === 'Remove')!
        .click()
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('may have succeeded');
    expect(
      mocks.runtime.requestLocalSorbetCredentials.mock.calls.map(([requestMachine, request]) => [
        requestMachine,
        request.method,
      ])
    ).toEqual([
      ['remote', 'sorbet/credentials-list'],
      ['remote', 'sorbet/credentials-logout'],
    ]);
  });
});
