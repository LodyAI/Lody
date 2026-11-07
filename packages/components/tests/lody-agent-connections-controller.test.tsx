// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfigId, MachineId } from '@lody/shared';
import { LodyAgentConnectionsController } from '../src/components/settings/lody-agent-connections-controller';
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
let container: HTMLDivElement;
let root: Root;

function credentials(...ids: string[]) {
  return {
    type: 'sorbet/credentials-list',
    credentials: ids.map((providerId) => ({ providerId, type: 'oauth' })),
  };
}
const noProviders = { type: 'sorbet/providers-list', providers: [] };
function rowIds() {
  return [...container.querySelectorAll('[data-connection-id]')].map((row) =>
    row.getAttribute('data-connection-id')
  );
}
function button(label: string, scope: ParentNode = document) {
  const found = [...scope.querySelectorAll('button')].find(
    (item) => item.getAttribute('aria-label') === label || item.textContent?.trim() === label
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
/** React reads the native setter, so a plain assignment would not reach state. */
async function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function field(label: string) {
  const id = [...document.querySelectorAll('label')]
    .find((item) => item.textContent?.trim() === label)
    ?.getAttribute('for');
  return document.getElementById(id ?? '') as HTMLInputElement | HTMLTextAreaElement;
}
async function render(props: {
  key?: string;
  machine?: MachineId;
  config?: AgentConfigId;
  refreshVersion?: number;
  onProvidersChanged?: () => Promise<void>;
}) {
  await act(async () =>
    root.render(
      <LodyAgentConnectionsController
        key={props.key}
        machineId={props.machine ?? machineId}
        configId={props.config ?? configId}
        supported
        refreshVersion={props.refreshVersion ?? 0}
        onProvidersChanged={props.onProvidersChanged}
      />
    )
  );
}

describe('LodyAgentConnectionsController', () => {
  beforeEach(async () => {
    await initI18n();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    mocks.runtime.requestLocalSorbetProviders.mockResolvedValue(noProviders);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    mocks.runtime.requestLocalSorbetCredentials.mockReset();
    mocks.runtime.requestLocalSorbetProviders.mockReset();
  });

  it('ignores a response for a target that is no longer shown', async () => {
    let resolveOld!: (value: unknown) => void;
    mocks.runtime.requestLocalSorbetCredentials.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      })
    );
    mocks.runtime.requestLocalSorbetCredentials.mockResolvedValue(credentials('new'));
    await render({ key: 'a' });
    await render({ key: 'b', config: 'config-b' as AgentConfigId });
    await act(async () => resolveOld(credentials('old')));
    expect(rowIds()).toEqual(['new']);
  });

  it('keeps the last list on screen while a later read is in flight', async () => {
    mocks.runtime.requestLocalSorbetCredentials.mockResolvedValueOnce(credentials('anthropic'));
    await render({});
    let resolveNext!: (value: unknown) => void;
    mocks.runtime.requestLocalSorbetCredentials.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveNext = resolve;
      })
    );
    await render({ refreshVersion: 1 });
    expect(rowIds()).toEqual(['anthropic']);
    await act(async () => resolveNext(credentials('anthropic', 'openai')));
    expect(rowIds()).toEqual(['anthropic', 'openai']);
  });

  it('re-probes the agent after a custom endpoint is saved', async () => {
    mocks.runtime.requestLocalSorbetCredentials.mockResolvedValue(credentials());
    const stored: unknown[] = [];
    mocks.runtime.requestLocalSorbetProviders.mockImplementation(async (_machine, request) => {
      if (request.method === 'sorbet/providers-create') {
        const provider = { id: 'created-1', ...request.params.provider };
        stored.push(provider);
        return { type: 'sorbet/providers-create', provider };
      }
      return { type: 'sorbet/providers-list', providers: stored };
    });
    const onProvidersChanged = vi.fn(async () => {});
    await render({ onProvidersChanged });
    await click(button('Add endpoint'));
    await typeInto(field('Name'), 'Acme Gateway');
    await typeInto(field('Base URL'), 'https://gateway.acme.dev/v1');
    await click(button('Add endpoint', document.querySelector('[role="dialog"]')!));

    // The definition alone changes nothing a person can act on: the agent only
    // advertises `<provider>:api_key` once the capability probe reads it again.
    expect(onProvidersChanged).toHaveBeenCalledTimes(1);
    expect(rowIds()).toEqual(['created-1']);
    expect(container.textContent).toContain('Needs an API key');
  });

  it('removes an endpoint by deleting its definition', async () => {
    mocks.runtime.requestLocalSorbetCredentials.mockResolvedValue(credentials());
    let providers = [
      {
        id: 'acme',
        name: 'Acme Gateway',
        protocol: 'openai-completions',
        baseUrl: 'https://gateway.acme.dev/v1',
        models: [{ id: 'large' }],
      },
    ];
    mocks.runtime.requestLocalSorbetProviders.mockImplementation(async (_machine, request) => {
      if (request.method === 'sorbet/providers-delete') {
        providers = providers.filter((provider) => provider.id !== request.params.providerId);
        return { type: 'sorbet/providers-delete' };
      }
      return { type: 'sorbet/providers-list', providers };
    });
    await render({});
    await click(button('Remove Acme Gateway'));
    await click(button('Remove', document.querySelector('[role="alertdialog"]')!));
    expect(rowIds()).toEqual([]);
    expect(
      mocks.runtime.requestLocalSorbetCredentials.mock.calls.map(([, r]) => r.method)
    ).not.toContain('sorbet/credentials-logout');
  });

  it('keeps an unconfirmed logout visible without retrying, until the person checks again', async () => {
    mocks.runtime.requestLocalSorbetCredentials.mockResolvedValueOnce(credentials('remote'));
    mocks.runtime.requestLocalSorbetCredentials.mockRejectedValueOnce(new Error('timeout'));
    await render({ machine: 'remote' as MachineId });
    await click(button('Remove remote'));
    await click(button('Remove', document.querySelector('[role="alertdialog"]')!));
    expect(rowIds()).toEqual(['remote']);
    expect(container.textContent).toContain('Removal not confirmed');
    expect(
      mocks.runtime.requestLocalSorbetCredentials.mock.calls.map(([target, request]) => [
        target,
        request.method,
      ])
    ).toEqual([
      ['remote', 'sorbet/credentials-list'],
      ['remote', 'sorbet/credentials-logout'],
    ]);

    mocks.runtime.requestLocalSorbetCredentials.mockResolvedValueOnce(credentials());
    await click(button('Check again'));
    expect(rowIds()).toEqual([]);
  });

  it('frees the list when a read lands while a removal is in flight', async () => {
    mocks.runtime.requestLocalSorbetCredentials.mockResolvedValueOnce(credentials('alpha', 'beta'));
    let finishLogout!: (value: unknown) => void;
    mocks.runtime.requestLocalSorbetCredentials.mockReturnValueOnce(
      new Promise((resolve) => {
        finishLogout = resolve;
      })
    );
    await render({});
    await click(button('Remove alpha'));
    await click(button('Remove', document.querySelector('[role="alertdialog"]')!));
    expect(button('Remove beta').disabled).toBe(true);

    mocks.runtime.requestLocalSorbetCredentials.mockResolvedValueOnce(credentials('alpha', 'beta'));
    await render({ refreshVersion: 1 });
    mocks.runtime.requestLocalSorbetCredentials.mockResolvedValue(credentials('beta'));
    await act(async () => finishLogout({ type: 'sorbet/credentials-logout' }));

    expect(rowIds()).toEqual(['beta']);
    expect(button('Remove beta').disabled).toBe(false);
  });

  it('keeps a removal unconfirmed when the only read since it began started before it settled', async () => {
    mocks.runtime.requestLocalSorbetCredentials.mockResolvedValueOnce(credentials('alpha'));
    let failLogout!: (reason: unknown) => void;
    mocks.runtime.requestLocalSorbetCredentials.mockReturnValueOnce(
      new Promise((_, reject) => {
        failLogout = reject;
      })
    );
    await render({});
    await click(button('Remove alpha'));
    await click(button('Remove', document.querySelector('[role="alertdialog"]')!));

    let finishEarlyRead!: (value: unknown) => void;
    mocks.runtime.requestLocalSorbetCredentials.mockReturnValueOnce(
      new Promise((resolve) => {
        finishEarlyRead = resolve;
      })
    );
    await render({ refreshVersion: 1 });
    await act(async () => failLogout(new Error('timeout')));
    expect(container.textContent).toContain('Removal not confirmed');

    // This read was asked before the logout's outcome became unknown, so it cannot answer it.
    await act(async () => finishEarlyRead(credentials('alpha')));
    expect(container.textContent).toContain('Removal not confirmed');

    mocks.runtime.requestLocalSorbetCredentials.mockResolvedValueOnce(credentials());
    await click(button('Check again'));
    expect(rowIds()).toEqual([]);
  });

  it('reads saved sign-ins and custom endpoints one after the other', async () => {
    let finishCredentials!: (value: unknown) => void;
    mocks.runtime.requestLocalSorbetCredentials.mockReturnValueOnce(
      new Promise((resolve) => {
        finishCredentials = resolve;
      })
    );
    await render({});
    // Each list starts its own agent process on the machine against one data directory.
    expect(mocks.runtime.requestLocalSorbetProviders).not.toHaveBeenCalled();
    await act(async () => finishCredentials(credentials('alpha')));
    expect(mocks.runtime.requestLocalSorbetProviders).toHaveBeenCalledOnce();
    expect(rowIds()).toEqual(['alpha']);
  });
});
