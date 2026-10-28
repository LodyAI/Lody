// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider, createStore } from 'jotai';
import { PlatformContext } from '@lody/platform/react';
import { createStaticStore, type E2eeManagementState, type PlatformProvider } from '@lody/platform';
import { TEST_CLOUD_PLATFORM } from './test-platform';
import { workspaceContentModeAtom } from '../src/atoms/workspace-content-mode';
import { WorkspaceSettings } from '../src/components/settings/e2ee/workspace-security';
import { E2eeSettingsIcon } from '../src/components/settings/e2ee/security-state';
const navigation = vi.hoisted(() => ({ target: null as unknown }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => async (target: unknown) => {
    navigation.target = target;
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../src/components/settings/account-setting', () => ({
  AccountSettingsComponent: () => <p>ordinary settings</p>,
}));
describe('encrypted workspace settings', () => {
  let root: Root,
    container: HTMLDivElement,
    store: ReturnType<typeof createStore>,
    platform: PlatformProvider;
  let state: E2eeManagementState, fail: boolean, signed: boolean;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    store = createStore();
    fail = signed = false;
    navigation.target = null;
    state = {
      epoch: 0,
      rotationRequired: true,
      updatePending: false,
      mayRotate: true,
      devices: [
        {
          key: 'ab'.repeat(32),
          kind: 'machine',
          machineId: 'synthetic-machine',
          self: false,
          mayRevoke: true,
        },
      ],
    };
    platform = {
      ...TEST_CLOUD_PLATFORM,
      identity: {
        ...TEST_CLOUD_PLATFORM.identity,
        session: createStaticStore({
          status: 'authenticated' as const,
          user: { id: 'account', name: 'Synthetic', email: 'synthetic@example.test' },
        }),
      },
      e2eeWorkspaces: {
        runtime: {
          managementState: async () => state,
          updateKeys: async () => {
            if (fail) throw new Error('e2ee_management_retry');
            signed = true;
            state = { ...state, epoch: 1, rotationRequired: false, updatePending: false };
          },
          revokeDevice: async (_workspace: string, key: string) => {
            state = {
              ...state,
              devices: state.devices.filter((device) => device.key !== key),
              rotationRequired: true,
            };
          },
          refresh: async () => ({}),
        },
      },
    } as unknown as PlatformProvider;
    store.set(workspaceContentModeAtom, {
      accountId: 'account',
      workspaceSlug: 'workspace',
      workspaceId: 'workspace',
      descriptor: {
        workspaceId: 'workspace',
        contentMode: 'e2ee',
        contentModeVersion: 1,
        genesisHash: '11'.repeat(32),
        cryptoOrgId: '11'.repeat(32),
        activation: 'control-only',
      },
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = () =>
    act(async () =>
      root.render(
        <Provider store={store}>
          <PlatformContext.Provider value={platform}>
            <E2eeSettingsIcon />
            <WorkspaceSettings />
          </PlatformContext.Provider>
        </Provider>
      )
    );
  const click = async (key: string) => {
    const button = [...container.querySelectorAll('button')].find(
      (node) => node.textContent === key
    );
    if (!button) throw new Error(`missing ${key}`);
    await act(async () => button.click());
  };
  it('waits for an explicit click, keeps retry and device rows after failure, then completes and clears the badge', async () => {
    await render();
    expect(signed).toBe(false);
    expect(container.querySelector('[role=status]')).not.toBeNull();
    fail = true;
    await click('e2ee.security.complete');
    expect(container.textContent).toContain('e2ee.security.retryHint');
    expect(container.textContent).toContain('synthetic-machine');
    expect(signed).toBe(false);
    fail = false;
    await click('e2ee.security.complete');
    expect(signed).toBe(true);
    expect(container.textContent).toContain('e2ee.security.current');
    expect(container.querySelector('[role=status]')).toBeNull();
  });
  it('shows delegation when no eligible manager exists and permits the separate revoke action', async () => {
    state = { ...state, mayRotate: false };
    await render();
    expect(container.textContent).toContain('e2ee.security.useManager');
    expect(container.querySelector('[role=status]')).toBeNull();
    await click('e2ee.security.revoke');
    expect(container.textContent).not.toContain('synthetic-machine');
    expect(signed).toBe(false);
  });
  it('keeps a continuation action after the epoch committed but installation/ack is pending', async () => {
    state = { ...state, rotationRequired: false, updatePending: true };
    await render();
    expect(container.textContent).toContain('e2ee.security.complete');
    expect(container.querySelector('[role=status]')).not.toBeNull();
  });
  it('reuses the settings badge for a pending link request and clears it after approval', async () => {
    vi.useFakeTimers();
    try {
      state = { ...state, rotationRequired: false };
      let pending = true;
      platform.e2eeWorkspaces!.runtime!.memberJoinRequests = async () =>
        ({
          items: pending ? [{ source: 'link', state: 'pending' }] : [],
        }) as never;
      await render();
      expect(container.querySelector('[role=status]')).not.toBeNull();
      pending = false;
      await act(async () => vi.advanceTimersByTimeAsync(15_000));
      expect(container.querySelector('[role=status]')).toBeNull();
      expect(signed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not let a late invitation queue result mark a different workspace', async () => {
    state = { ...state, rotationRequired: false };
    const late =
      Promise.withResolvers<
        Awaited<
          ReturnType<
            NonNullable<import('@lody/platform').E2eeWorkspaceRuntime['memberJoinRequests']>
          >
        >
      >();
    platform.e2eeWorkspaces!.runtime!.memberJoinRequests = async (workspaceId) =>
      workspaceId === 'workspace' ? late.promise : ({ items: [] } as never);
    await render();
    const mode = store.get(workspaceContentModeAtom)!;
    await act(async () =>
      store.set(workspaceContentModeAtom, {
        ...mode,
        workspaceId: 'other',
        workspaceSlug: 'other',
        descriptor: { ...mode.descriptor!, workspaceId: 'other' },
      } as typeof mode)
    );
    await act(async () => late.resolve({ items: [{ source: 'link', state: 'pending' }] } as never));
    expect(container.querySelector('[role=status]')).toBeNull();
  });
  it('drops late native facts from the previous workspace', async () => {
    const late = Promise.withResolvers<E2eeManagementState>();
    const original = state;
    platform.e2eeWorkspaces!.runtime!.managementState = async (workspaceId) =>
      workspaceId === 'workspace' ? late.promise : { ...state, rotationRequired: false };
    await render();
    const mode = store.get(workspaceContentModeAtom)!;
    await act(async () =>
      store.set(workspaceContentModeAtom, {
        ...mode,
        workspaceId: 'other',
        workspaceSlug: 'other',
        descriptor: { ...mode.descriptor!, workspaceId: 'other' },
      } as typeof mode)
    );
    expect(container.textContent).toContain('e2ee.security.current');
    await act(async () => late.resolve(original));
    expect(container.textContent).toContain('e2ee.security.current');
    expect(container.querySelector('[role=status]')).toBeNull();
  });
  it('refreshes the ledger before showing a rotation requested on another device', async () => {
    state = { ...state, rotationRequired: false };
    platform.e2eeWorkspaces!.runtime!.refresh = async () => {
      state = { ...state, rotationRequired: true };
      return {} as never;
    };
    await render();
    expect(container.querySelector('[role=status]')).not.toBeNull();
    expect(container.textContent).toContain('e2ee.security.complete');
    expect(signed).toBe(false);
  });
  it.each([
    ['custody_unavailable', 'identityMissing'],
    ['rotation_candidate_unavailable', 'candidateUnavailable'],
    ['management_operator_required', 'operatorRequired'],
    ['restart-required', 'restartRequired'],
    ['local-history-recovery-required', 'localRecovery'],
    ['trusted-pin-unavailable', 'localRecovery'],
  ])(
    'shows the next step for a native %s receipt without discarding local state',
    async (code, message) => {
      platform.e2eeWorkspaces!.runtime!.updateKeys = async () => {
        throw new Error(`Error invoking remote method: e2ee_${code}`);
      };
      await render();
      await click('e2ee.security.complete');
      expect(container.textContent).toContain(`e2ee.security.${message}`);
      expect(container.textContent).toContain('synthetic-machine');
      expect(signed).toBe(false);
      await click('e2ee.security.authorizePersonal');
      expect(navigation.target).toEqual({
        to: '/workspace/e2ee/$workspaceId',
        params: { workspaceId: 'workspace' },
      });
    }
  );
  it('ordinary workspaces show ordinary settings and never access a management port', async () => {
    platform.e2eeWorkspaces!.runtime!.managementState = async () => {
      throw new Error('ordinary must never query crypto');
    };
    platform.e2eeWorkspaces!.runtime!.memberJoinRequests = async () => {
      throw new Error('ordinary must never query member requests');
    };
    store.set(workspaceContentModeAtom, null);
    await render();
    expect(container.textContent).toBe('ordinary settings');
    expect(container.querySelector('[role=status]')).toBeNull();
  });
});
