// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfigId, MachineId, SessionId } from '@lody/shared';
import {
  SessionAccountSelector,
  AccountProfilesPanel,
} from '../src/components/settings/account-profiles';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  switch: vi.fn(),
  loginProps: vi.fn(),
}));
vi.mock('../src/atoms/runtime', () => ({ activeWorkspaceRuntimeAtom: 'runtime' }));
vi.mock('../src/atoms/workspace-context', () => ({ currentWorkspaceIdAtom: 'workspace' }));
vi.mock('jotai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jotai')>();
  const runtime = { requestAccountProfiles: mocks.list, requestSessionAccountSwitch: mocks.switch };
  return {
    ...actual,
    useAtomValue: (atom: string) => (atom === 'runtime' ? runtime : 'workspace-1'),
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
describe('account controls', () => {
  it('keeps the durable binding visible when a switch fails', async () => {
    mocks.list.mockResolvedValue({ success: true, profiles });
    mocks.switch.mockResolvedValue({ success: false, error: 'Target auth invalid' });
    const element = await render(<SessionAccountSelector {...target} />);
    const select = element.querySelector('select')!;
    expect(select.value).toBe('system-default');
    await act(async () => {
      select.value = 'account-b';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(mocks.switch).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', accountProfileId: 'account-b' })
    );
    expect(select.value).toBe('system-default');
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
    expect(element.textContent).toContain('claude@example.com');
    expect(element.textContent).not.toContain('work@example.com');
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
    expect(element.textContent).toContain('Account B');
    await act(async () => root.render(<SessionAccountSelector {...target} agentType="claude" />));
    expect(element.textContent).not.toContain('Account B');
    expect(element.querySelector('select')?.value).toBe('system-default');
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
    const select = element.querySelector('select')!;
    await act(async () => {
      select.value = 'account-b';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(select.value).toBe('system-default');
    expect(element.querySelector('[role="alert"]')).toBeNull();
  });

  it('preserves a deleted profile binding while allowing manual selection of System Default', async () => {
    mocks.list.mockResolvedValue({ success: true, profiles: [profiles[0]] });
    mocks.switch.mockResolvedValue(null);
    const element = await render(
      <SessionAccountSelector {...target} accountProfileId="deleted-account" />
    );
    const select = element.querySelector('select')!;
    expect(select.value).toBe('deleted-account');
    expect(element.textContent).toContain('Unavailable account');
    await act(async () => {
      select.value = 'system-default';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(select.value).toBe('deleted-account');
    expect(element.textContent).toContain('Could not switch account');
    expect(mocks.switch).toHaveBeenCalledWith(
      expect.objectContaining({ accountProfileId: 'system-default' })
    );
  });
  it('disables switching during an active request', async () => {
    mocks.list.mockResolvedValue({ success: true, profiles });
    const element = await render(<SessionAccountSelector {...target} busy />);
    expect(element.querySelector('select')?.disabled).toBe(true);
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
