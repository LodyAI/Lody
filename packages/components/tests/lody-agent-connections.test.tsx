// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LodyAgentConnections,
  type LodyAgentConnectionsProps,
} from '../src/components/settings/lody-agent-connections';
import { initI18n } from '../src/i18n';

let container: HTMLDivElement;
let root: Root;
const props: LodyAgentConnectionsProps = {
  status: 'ready',
  credentials: [
    { providerId: 'anthropic', type: 'oauth' },
    { providerId: 'openrouter', type: 'api-key' },
    { providerId: 'acme', type: 'api-key' },
  ],
  providers: [
    {
      id: 'acme',
      name: 'Acme Gateway',
      protocol: 'openai-completions',
      baseUrl: 'https://gateway.acme.dev/v1',
      models: [{ id: 'acme-large' }, { id: 'acme-small' }],
    },
    {
      id: 'local',
      name: 'Local gateway',
      protocol: 'anthropic-messages',
      baseUrl: 'http://127.0.0.1:8787',
      models: [{ id: 'lody-large' }],
    },
  ],
  uncertainRemovalIds: [],
  onRetry: vi.fn(),
  onRemove: vi.fn(),
  onCreate: vi.fn(async () => {}),
};

async function render(overrides: Partial<LodyAgentConnectionsProps> = {}) {
  await act(async () => root.render(<LodyAgentConnections {...props} {...overrides} />));
}
function button(label: string, scope: ParentNode = document) {
  const found = [...scope.querySelectorAll('button')].find(
    (item) => item.getAttribute('aria-label') === label || item.textContent?.trim() === label
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
function row(name: string) {
  const found = [...container.querySelectorAll('[data-connection-id]')].find((item) =>
    item.textContent?.includes(name)
  );
  if (!found) throw new Error(`Missing row ${name}`);
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
  const labelNode = [...document.querySelectorAll('label')].find(
    (item) => item.textContent?.trim() === label
  );
  const id = labelNode?.getAttribute('for');
  const found = id ? document.getElementById(id) : null;
  if (!found) throw new Error(`Missing field ${label}`);
  return found as HTMLInputElement | HTMLTextAreaElement;
}

describe('LodyAgentConnections', () => {
  beforeEach(async () => {
    await initI18n();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(props.onRetry).mockReset();
    vi.mocked(props.onRemove).mockReset();
    vi.mocked(props.onCreate).mockReset();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('lists accounts and custom endpoints as one set of connections', async () => {
    await render();
    const rows = [...container.querySelectorAll('[data-connection-id]')].map((item) =>
      item.getAttribute('data-connection-id')
    );
    // A custom endpoint's credential is the endpoint's own key, not a second account.
    expect(rows).toEqual(['anthropic', 'openrouter', 'acme', 'local']);
    expect(row('anthropic').textContent).toContain('Signed in');
    expect(row('openrouter').textContent).toContain('API key');
    expect(row('Acme Gateway').textContent).toContain('Custom endpoint, 2 models');
    expect(row('Local gateway').textContent).toContain('Needs an API key');
    expect(container.textContent).not.toContain('oauth');
  });

  it('keeps the last list on screen while it refreshes', async () => {
    await render({ status: 'loading' });
    expect(row('Acme Gateway')).toBeTruthy();
  });

  it('draws nothing during a first read that has nothing to show yet', async () => {
    await render({ status: 'loading', credentials: [], providers: [] });
    // An empty card would promise a shape the read has not delivered.
    expect(container.querySelector('section')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('lists ways to sign in inside the same card, without an empty notice', async () => {
    await render({
      credentials: [],
      providers: [],
      signIn: <div data-testid="sign-in-methods">Claude</div>,
    });
    const methods = container.querySelector('[data-testid="sign-in-methods"]');
    expect(methods).not.toBeNull();
    expect(container.textContent).not.toContain('No connections');
    await render({ signIn: <div data-testid="sign-in-methods">Claude</div> });
    const card = container.querySelector('[data-connection-id]')!.parentElement!.parentElement!;
    expect(card.contains(container.querySelector('[data-testid="sign-in-methods"]'))).toBe(true);
  });

  it('offers a retry when the list cannot be read', async () => {
    await render({ status: 'error', credentials: [], providers: [] });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not read connections'
    );
    await click(button('Try again'));
    expect(props.onRetry).toHaveBeenCalledOnce();
  });

  it('removes only the confirmed connection', async () => {
    await render();
    await click(button('Remove Acme Gateway'));
    expect(document.body.textContent).toContain(
      'Remove Acme Gateway and its API key from this machine?'
    );
    await click(button('Cancel'));
    expect(props.onRemove).not.toHaveBeenCalled();
    await click(button('Remove anthropic'));
    const dialog = document.querySelector('[role="alertdialog"]')!;
    await click(button('Remove', dialog));
    expect(props.onRemove).toHaveBeenCalledWith({ kind: 'account', id: 'anthropic' });
  });

  it('keeps a row whose removal was not confirmed and lets the person check again', async () => {
    await render({ uncertainRemovalIds: ['openrouter'] });
    expect(row('openrouter').textContent).toContain('Removal not confirmed');
    await click(button('Check again', row('openrouter')));
    expect(props.onRetry).toHaveBeenCalledOnce();
  });

  it('adds a custom endpoint in one form and keeps the draft when saving fails', async () => {
    vi.mocked(props.onCreate).mockRejectedValueOnce(new Error('bad endpoint'));
    await render({ providers: [], credentials: [] });
    await click(button('Add endpoint'));
    await typeInto(field('Name'), 'Acme Gateway');
    const group = document.querySelector('[role="radiogroup"]')!;
    const labelId = group.getAttribute('aria-labelledby');
    expect(labelId && document.getElementById(labelId)?.textContent).toBe('Compatible with');
    expect([...group.querySelectorAll('[role="radio"]')]).toHaveLength(3);
    const anthropic = [...group.querySelectorAll('label')].find(
      (label) => label.textContent?.trim() === 'Anthropic'
    )!;
    await click(anthropic.querySelector<HTMLElement>('[role="radio"]')!);
    await typeInto(field('Base URL'), ' https://gateway.acme.dev ');
    await typeInto(field('Models'), 'acme-large\nacme-small, acme-tiny');
    const dialog = document.querySelector('[role="dialog"]')!;
    await click(button('Add endpoint', dialog));
    expect(props.onCreate).toHaveBeenCalledWith({
      name: 'Acme Gateway',
      protocol: 'anthropic-messages',
      baseUrl: 'https://gateway.acme.dev',
      models: [{ id: 'acme-large' }, { id: 'acme-small' }, { id: 'acme-tiny' }],
    });
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('Could not add');
    expect(field('Name').value).toBe('Acme Gateway');

    await click(button('Add endpoint', dialog));
    expect(props.onCreate).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
