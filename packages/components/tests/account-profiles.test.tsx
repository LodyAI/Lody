// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfigId, MachineId, SessionId } from '@lody/shared';
import {
  SessionAccountSelector,
  AccountProfilesPanel,
} from '../src/components/settings/account-profiles';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  switch: vi.fn(),
  loginProps: vi.fn(),
  runtime: {},
}));
vi.mock('../src/atoms/runtime', () => ({ activeWorkspaceRuntimeAtom: 'runtime' }));
vi.mock('../src/atoms/workspace-context', () => ({ currentWorkspaceIdAtom: 'workspace' }));
vi.mock('jotai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jotai')>();
  return {
    ...actual,
    useAtomValue: (atom: string) => (atom === 'runtime' ? mocks.runtime : 'workspace-1'),
  };
});
vi.mock('react-i18next', () => {
  const t = (_key: string, fallback: string) => fallback;
  return { useTranslation: () => ({ t }) };
});
vi.mock('../src/components/settings/acp-authentication-panel', () => ({
  AcpAuthenticationPanel: (props: { accountProfileId?: string }) => {
    mocks.loginProps(props);
    return <div data-login={props.accountProfileId} />;
  },
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const target = {
  configId: 'config-codex' as AgentConfigId,
  machineId: 'machine-1' as MachineId,
  agentType: 'codex' as const,
  sessionId: 'session-1' as SessionId,
};
const profiles = [
  {
    accountProfileId: 'system-default',
    label: 'System Default',
    identity: 'work@example.com',
    status: 'authenticated',
  },
  { accountProfileId: 'account-b', label: 'Account B', status: 'authenticated' },
];
let cleanup: (() => Promise<void>) | undefined;
beforeEach(() => {
  mocks.runtime = { requestAccountProfiles: mocks.list, requestSessionAccountSwitch: mocks.switch };
});
afterEach(async () => {
  await cleanup?.();
  vi.clearAllMocks();
});
async function render(node: React.ReactNode) {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  cleanup = async () => {
    await act(async () => root.unmount());
    element.remove();
  };
  await act(async () => root.render(node));
  return element;
}
function accountTrigger(element: HTMLElement): HTMLButtonElement {
  const trigger = element.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
  if (!trigger) throw new Error('Account menu trigger is missing');
  return trigger;
}
async function key(element: Element, value: string) {
  await act(async () => {
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
    );
  });
}
async function openMenu(element: HTMLElement) {
  const trigger = accountTrigger(element);
  trigger.focus();
  await key(trigger, 'Enter');
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
}
function menuItem(label: string): HTMLElement {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
    (candidate) => candidate.textContent?.startsWith(label)
  );
  if (!item) throw new Error(`Account menu item ${label} is missing`);
  return item;
}
async function chooseAccount(label: string) {
  await act(async () => menuItem(label).click());
}
async function closeMenu() {
  const menu = document.querySelector('[role="menu"]');
  if (!menu) throw new Error('Account menu is missing');
  await key(menu, 'Escape');
}
describe('account controls', () => {
  it('opens with the keyboard and exposes identity and selected account in the menu', async () => {
    mocks.list.mockResolvedValue({ success: true, profiles });
    mocks.switch.mockResolvedValue({ success: true });
    const element = await render(<SessionAccountSelector {...target} />);
    const trigger = accountTrigger(element);
    expect(trigger.textContent).toBe('System Default');
    expect(trigger.getAttribute('aria-label')).toBe('Account: System Default');
    await openMenu(element);
    const current = menuItem('System Default');
    expect(current.getAttribute('aria-checked')).toBe('true');
    expect(current.textContent).toContain('work@example.com');
    expect(current.textContent).toContain('Signed in');
    const next = menuItem('Account B');
    expect(next.getAttribute('aria-checked')).toBe('false');
    next.focus();
    await key(next, 'Enter');
    expect(mocks.switch).toHaveBeenCalledWith(
      expect.objectContaining({ accountProfileId: 'account-b' })
    );
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.textContent).toBe('System Default');
    await openMenu(element);
    await closeMenu();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the current account and prevents another selection while a switch is pending', async () => {
    const response = Promise.withResolvers<{ success: boolean }>();
    mocks.list.mockResolvedValue({ success: true, profiles });
    mocks.switch.mockReturnValue(response.promise);
    const element = await render(<SessionAccountSelector {...target} />);
    const trigger = accountTrigger(element);
    await openMenu(element);
    await chooseAccount('Account B');
    expect(trigger.disabled).toBe(true);
    expect(trigger.getAttribute('aria-busy')).toBe('true');
    expect(trigger.textContent).toBe('System Default');
    expect(element.querySelector('[role="status"]')?.textContent).toBe('Switching account…');
    await act(async () => response.resolve({ success: true }));
    expect(trigger.disabled).toBe(false);
    expect(trigger.textContent).toBe('System Default');
    expect(element.querySelector('[role="status"]')).toBeNull();
  });

  it('keeps the menu disabled until account status has loaded', async () => {
    const response = Promise.withResolvers<{ success: boolean; profiles: typeof profiles }>();
    mocks.list.mockReturnValue(response.promise);
    const element = await render(<SessionAccountSelector {...target} />);
    expect(accountTrigger(element).disabled).toBe(true);
    expect(accountTrigger(element).getAttribute('aria-busy')).toBe('true');
    await act(async () => response.resolve({ success: true, profiles }));
    expect(accountTrigger(element).disabled).toBe(false);
  });

  it('coalesces mounted siblings and does not probe disabled selectors', async () => {
    mocks.list.mockResolvedValue({ success: true, profiles });
    const element = await render(
      <>
        <SessionAccountSelector {...target} />
        <SessionAccountSelector {...target} sessionId={'session-2' as SessionId} />
        <SessionAccountSelector
          {...target}
          machineId={'hidden-machine' as MachineId}
          enabled={false}
        />
      </>
    );
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(element.querySelectorAll('button[aria-haspopup="menu"]')).toHaveLength(3);
    expect(
      element.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')[2]?.disabled
    ).toBe(true);
  });

  it('publishes a Settings authentication refresh to an already mounted selector', async () => {
    mocks.list.mockResolvedValue({ success: true, profiles });
    const element = await render(
      <>
        <AccountProfilesPanel {...target} />
        <SessionAccountSelector {...target} />
      </>
    );
    const signIn = [...element.querySelectorAll('button')].find(
      (button) => button.textContent === 'Sign in'
    );
    expect(signIn).toBeDefined();
    await act(async () => signIn?.click());
    const authProps = mocks.loginProps.mock.calls.at(-1)?.[0];
    expect(authProps).toBeDefined();
    mocks.list.mockResolvedValue({
      success: true,
      profiles: [
        ...profiles,
        { accountProfileId: 'new-account', label: 'New account', status: 'authenticated' },
      ],
    });
    await act(async () => authProps.onAuthenticated());
    await openMenu(element);
    expect(menuItem('New account')).toBeDefined();
  });
  it('keeps the durable binding visible when a switch fails', async () => {
    mocks.list.mockResolvedValue({ success: true, profiles });
    mocks.switch.mockResolvedValue({ success: false, error: 'Target auth invalid' });
    const element = await render(<SessionAccountSelector {...target} />);
    const trigger = accountTrigger(element);
    expect(trigger.textContent).toBe('System Default');
    await openMenu(element);
    await chooseAccount('Account B');
    expect(mocks.switch).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', accountProfileId: 'account-b' })
    );
    expect(trigger.textContent).toBe('System Default');
    expect(element.textContent).toContain('Target auth invalid');
  });
  it('renders the existing native login once directly under System Default', async () => {
    mocks.list.mockResolvedValue({ success: true, profiles });
    const element = await render(
      <AccountProfilesPanel
        {...target}
        systemDefaultAuthentication={<span data-default-login>Native login</span>}
      />
    );
    expect(element.querySelectorAll('[data-default-login]')).toHaveLength(1);
    const text = element.textContent ?? '';
    expect(text.indexOf('Native login')).toBeGreaterThan(text.indexOf('work@example.com'));
    expect(text.indexOf('Native login')).toBeLessThan(text.indexOf('Account B'));
  });
  it('ignores the old provider response after the target changes', async () => {
    const oldResponse = Promise.withResolvers<{ success: boolean; profiles: typeof profiles }>();
    mocks.list.mockImplementationOnce(() => oldResponse.promise);
    mocks.list.mockResolvedValue({
      success: true,
      profiles: [
        {
          accountProfileId: 'system-default',
          label: 'System Default',
          identity: 'claude@example.com',
          status: 'authenticated',
        },
      ],
    });
    const element = document.createElement('div');
    document.body.append(element);
    const root = createRoot(element);
    cleanup = async () => {
      await act(async () => root.unmount());
      element.remove();
    };
    await act(async () => root.render(<SessionAccountSelector {...target} />));
    await act(async () => root.render(<SessionAccountSelector {...target} agentType="claude" />));
    await act(async () => oldResponse.resolve({ success: true, profiles }));
    await openMenu(element);
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('claude@example.com');
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('work@example.com');
  });
  it('does not retain selectable profiles from a target whose replacement failed to load', async () => {
    mocks.list.mockResolvedValueOnce({ success: true, profiles });
    mocks.list.mockRejectedValueOnce(new Error('New provider status failed'));
    const element = document.createElement('div');
    document.body.append(element);
    const root = createRoot(element);
    cleanup = async () => {
      await act(async () => root.unmount());
      element.remove();
    };
    await act(async () => root.render(<SessionAccountSelector {...target} />));
    await openMenu(element);
    expect(menuItem('Account B')).toBeDefined();
    await closeMenu();
    await act(async () => root.render(<SessionAccountSelector {...target} agentType="claude" />));
    expect(element.textContent).not.toContain('Account B');
    expect(accountTrigger(element).textContent).toBe('System Default');
    expect(element.textContent).toContain('New provider status failed');
  });

  it('retries failed status detection without creating or authenticating an account', async () => {
    mocks.list.mockRejectedValueOnce(new Error('Status unavailable'));
    mocks.list.mockResolvedValueOnce({ success: true, profiles });
    const element = await render(<AccountProfilesPanel {...target} />);
    const retry = [...element.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry'
    )!;
    await act(async () => retry.click());
    expect(element.textContent).toContain('work@example.com');
    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(mocks.list.mock.calls.every(([request]) => request.action === 'list')).toBe(true);
    expect(mocks.loginProps).not.toHaveBeenCalled();
  });

  it('waits for durable metadata even when the switch response succeeds', async () => {
    mocks.list.mockResolvedValue({ success: true, profiles });
    mocks.switch.mockResolvedValue({ success: true, accountProfileId: 'account-b' });
    const element = await render(<SessionAccountSelector {...target} />);
    const trigger = accountTrigger(element);
    await openMenu(element);
    await chooseAccount('Account B');
    expect(trigger.textContent).toBe('System Default');
    expect(element.querySelector('[role="alert"]')).toBeNull();
  });

  it('preserves a deleted profile binding while allowing manual selection of System Default', async () => {
    mocks.list.mockResolvedValue({ success: true, profiles: [profiles[0]] });
    mocks.switch.mockResolvedValue(null);
    const element = await render(
      <SessionAccountSelector {...target} accountProfileId="deleted-account" />
    );
    const trigger = accountTrigger(element);
    expect(trigger.textContent).toBe('Unavailable account');
    expect(element.textContent).toContain('Unavailable account');
    await openMenu(element);
    expect(menuItem('Unavailable account').getAttribute('aria-checked')).toBe('true');
    await chooseAccount('System Default');
    expect(trigger.textContent).toBe('Unavailable account');
    expect(element.textContent).toContain('Could not switch account');
    expect(mocks.switch).toHaveBeenCalledWith(
      expect.objectContaining({ accountProfileId: 'system-default' })
    );
  });
  it('disables switching during an active request', async () => {
    mocks.list.mockResolvedValue({ success: true, profiles });
    const element = await render(<SessionAccountSelector {...target} busy />);
    expect(accountTrigger(element).disabled).toBe(true);
    expect(mocks.switch).not.toHaveBeenCalled();
  });
  it('starts added account login only in its isolated profile', async () => {
    mocks.list.mockImplementation(async (request) =>
      request.action === 'create'
        ? {
            success: true,
            profiles: [
              ...profiles,
              { accountProfileId: 'account-c', label: 'Account C', status: 'unauthenticated' },
            ],
          }
        : { success: true, profiles }
    );
    const onBeforeStart = vi.fn(async () => {});
    const element = await render(
      <AccountProfilesPanel
        {...target}
        configId={'config-codex' as AgentConfigId}
        onBeforeStart={onBeforeStart}
      />
    );
    const add = [...element.querySelectorAll('button')].find(
      (button) => button.textContent === '+ Add account'
    )!;
    await act(async () => add.click());
    expect(element.querySelector('[data-login]')?.getAttribute('data-login')).toBe('account-c');
    expect(mocks.loginProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        configId: 'config-codex',
        onBeforeStart,
        accountProfileId: 'account-c',
      })
    );
    expect(element.textContent).toContain('System Default');
  });

  it('does not create or start account login when saving the provider fails', async () => {
    mocks.list.mockResolvedValue({ success: true, profiles });
    const element = await render(
      <AccountProfilesPanel
        {...target}
        onBeforeStart={async () => {
          throw new Error('Provider save failed');
        }}
      />
    );
    const add = [...element.querySelectorAll('button')].find(
      (button) => button.textContent === '+ Add account'
    )!;
    await act(async () => add.click());
    expect(element.querySelector('[role="alert"]')?.textContent).toBe('Provider save failed');
    expect(element.querySelector('[data-login]')).toBeNull();
    expect(mocks.list.mock.calls.map(([request]) => request.action)).toEqual(['list']);
  });
});
