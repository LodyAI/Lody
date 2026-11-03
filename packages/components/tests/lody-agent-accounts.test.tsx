// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LodyAgentAccounts,
  type LodyAgentAccountsProps,
} from '../src/components/settings/lody-agent-accounts';
import { initI18n } from '../src/i18n';

let container: HTMLDivElement;
let root: Root;
const refresh = vi.fn();
const remove = vi.fn();
const props: LodyAgentAccountsProps = {
  status: 'ready',
  credentials: [
    { providerId: 'alpha', type: 'oauth' },
    { providerId: 'beta', type: 'api-key' },
  ],
  onRefresh: refresh,
  onRemove: remove,
};
async function render(overrides: Partial<LodyAgentAccountsProps> = {}) {
  await act(async () => root.render(<LodyAgentAccounts {...props} {...overrides} />));
}
function button(label: string) {
  const found = [...document.querySelectorAll('button')].find(
    (item) => item.getAttribute('aria-label') === label || item.textContent?.trim() === label
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}

describe('LodyAgentAccounts', () => {
  beforeEach(async () => {
    await initI18n();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    refresh.mockReset();
    remove.mockReset();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  it('renders loading, error, unsupported and empty states and delegates refresh', async () => {
    await render({ status: 'loading' });
    expect(container.textContent).toContain('Loading credentials');
    expect(button('Refresh').disabled).toBe(true);
    await render({ status: 'error', error: 'Unavailable' });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Unavailable');
    await click(button('Refresh'));
    expect(refresh).toHaveBeenCalledOnce();
    await render({ status: 'unsupported' });
    expect(container.textContent).toContain('unsupported');
    expect(button('Refresh').disabled).toBe(true);
    await render({ credentials: [] });
    expect(container.textContent).toContain('No credentials saved on this machine');
  });
  it('requires confirmation and removes the selected credential only', async () => {
    await render();
    expect(container.textContent).toContain('does not verify authentication');
    await click(button('Remove beta (api-key)'));
    expect(document.body.textContent).toContain(
      'Remove the api-key credential for beta from this machine?'
    );
    await click(button('Cancel'));
    expect(remove).not.toHaveBeenCalled();
    await click(button('Remove beta (api-key)'));
    const dialog = document.querySelector('[role="alertdialog"]')!;
    await click(
      [...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Remove')!
    );
    expect(remove).toHaveBeenCalledWith({ providerId: 'beta', type: 'api-key' });
    await render({ removingProviderId: 'beta', error: 'Removal failed' });
    expect(container.textContent).toContain('Removal failed');
    expect(button('Remove alpha (oauth)').disabled).toBe(true);
  });
});
