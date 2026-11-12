// @vitest-environment jsdom
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider, createStore } from 'jotai';
import { PlatformContext } from '@lody/platform/react';
import { createStaticStore, type E2eeManagementState, type PlatformProvider } from '@lody/platform';
import { TEST_CLOUD_PLATFORM } from './test-platform';
import { workspaceContentModeAtom } from '../src/atoms/workspace-content-mode';
import { E2eeMachineSharingSettings } from '../src/components/settings/e2ee/machine-sharing-settings';
import { WorkspaceSettings } from '../src/components/settings/e2ee/workspace-security';
import { RecoveryVaultSection } from '../src/components/settings/e2ee/recovery-vault-section';
import { E2eeRecoveryHostContext } from '../src/components/settings/e2ee/recovery-host';
import type { RecoveryPlan, RecoveryPort } from '../src/components/settings/e2ee/recovery-port';
import { developerModeEnabledAtom, e2eeRecoveryVaultEnabledAtom } from '../src/atoms/settings';
import { MachineDetailPane } from '../src/components/settings/machine-detail-pane';
import { E2eeSettingsIcon } from '../src/components/settings/e2ee/security-state';
import {
  E2eeSecurityPanel,
  E2eeDevicesPanel,
} from '../src/components/settings/e2ee/security-panel';
const navigation = vi.hoisted(() => ({ target: null as unknown }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => async (target: unknown) => {
    navigation.target = target;
  },
}));
vi.mock('../src/hooks/use-authenticated-convex', () => ({
  useAuthenticatedConvex: () => ({ requestAuthRecovery: vi.fn() }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../src/components/settings/account-setting', () => ({
  AccountSettingsComponent: (props: {
    encryptedTeamManagement?: boolean;
    onOpenEncryptionConsole?: () => void;
  }) => (
    <p>
      ordinary settings
      {props.encryptedTeamManagement === false ? ' without team management' : ''}
      {props.onOpenEncryptionConsole && (
        <button type="button" onClick={props.onOpenEncryptionConsole}>
          danger zone transfer
        </button>
      )}
    </p>
  ),
}));
describe('recovery vault settings', () => {
  it('asks the desktop for its recovery state once, not on every render', async () => {
    const calls = new Map<string, number>();
    const answers: Record<string, unknown> = {
      'e2ee.recoveryReplacementPlan': {
        hasVault: true,
        replaceable: true,
        replacing: false,
        covered: [],
        uncovered: [],
      },
      'e2ee.recentAccountSecurityEvents': [],
      'e2ee.recoveryPasskeyAvailable': true,
    };
    const ipc = {
      invoke: async (channel: string) => {
        calls.set(channel, (calls.get(channel) ?? 0) + 1);
        return answers[channel];
      },
      on: () => () => {},
    };
    vi.stubGlobal('ipc', ipc);
    const store = createStore();
    store.set(developerModeEnabledAtom, true);
    store.set(e2eeRecoveryVaultEnabledAtom, true);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <Provider store={store}>
            <RecoveryVaultSection />
          </Provider>
        );
      });
      for (let tick = 0; tick < 20; tick++) await act(async () => {});
      expect(container.textContent).toContain('e2ee.recovery.replace');
      expect(calls.get('e2ee.recoveryReplacementPlan')).toBe(1);
    } finally {
      act(() => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});

/** A browser-shaped host's port that answers `plan` and nothing else unless overridden. */
const fakeRecoveryPort = (
  plan: RecoveryPlan,
  overrides: Partial<RecoveryPort> = {}
): RecoveryPort => {
  const refuse = async (): Promise<never> => {
    throw new Error('e2ee_recovery_failed');
  };
  return {
    plan: async () => plan,
    securityEvents: async () => [],
    passkeyAvailable: async () => false,
    create: refuse,
    restore: refuse,
    setupWorkspace: refuse,
    setupWorkspaces: refuse,
    passkeyDefaultLabel: refuse,
    addPasskey: refuse,
    listPasskeys: refuse,
    removePasskey: refuse,
    checkFile: null,
    replacement: null,
    ...overrides,
  };
};

describe('recovery vault settings actions', () => {
  // A plan given as a function is asked again on every load, so it can fail and then recover.
  // Without a host port the section runs over the desktop IPC adapter.
  const mount = async (
    plan: unknown,
    handlers: Record<string, (...args: unknown[]) => unknown> = {},
    port?: RecoveryPort
  ) => {
    const answers: Record<string, unknown> = {
      'e2ee.recentAccountSecurityEvents': [],
      'e2ee.recoveryPasskeyAvailable': true,
    };
    if (!port)
      vi.stubGlobal('ipc', {
        invoke: async (channel: string, ...args: unknown[]) =>
          channel === 'e2ee.recoveryReplacementPlan'
            ? typeof plan === 'function'
              ? plan()
              : plan
            : handlers[channel]
              ? handlers[channel](...args)
              : answers[channel],
        on: () => () => {},
      });
    const store = createStore();
    store.set(developerModeEnabledAtom, true);
    store.set(e2eeRecoveryVaultEnabledAtom, true);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <Provider store={store}>
          <E2eeRecoveryHostContext.Provider value={port ? { port } : null}>
            <RecoveryVaultSection />
          </E2eeRecoveryHostContext.Provider>
        </Provider>
      );
    });
    const settle = async () => {
      for (let tick = 0; tick < 20; tick++) await act(async () => {});
    };
    await settle();
    const buttons = () => [...container.querySelectorAll('button')];
    return {
      get labels() {
        return buttons().map((button) => button.textContent);
      },
      get primary() {
        return buttons()
          .filter((button) => button.dataset.variant === 'primary')
          .map((b) => b.textContent);
      },
      get text() {
        return container.textContent ?? '';
      },
      click: async (label: string) => {
        const button = buttons().find((b) => b.textContent === label);
        if (!button) throw new Error(`no ${label} button`);
        await act(async () => button.click());
        await settle();
      },
      done: () => {
        act(() => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
      },
    };
  };
  const workspace = (id: string, status: unknown) => ({ id, name: `Workspace ${id}`, status });

  it('offers only creation when the account has no vault', async () => {
    const view = await mount({
      hasVault: false,
      replaceable: false,
      replacing: false,
      covered: [workspace('a', { kind: 'notSet' })],
      uncovered: [],
    });
    try {
      expect(view.labels).toEqual(['e2ee.recovery.create']);
      expect(view.primary).toEqual(['e2ee.recovery.create']);
    } finally {
      view.done();
    }
  });

  it('shows each workspace status and one primary action when a vault exists', async () => {
    const view = await mount({
      hasVault: true,
      replaceable: true,
      replacing: false,
      covered: [
        workspace('a', { kind: 'notSet' }),
        workspace('b', { kind: 'saved' }),
        workspace('c', { kind: 'verified', update: 3 }),
      ],
      uncovered: [workspace('d', { kind: 'notSet' })],
    });
    try {
      expect(view.labels).not.toContain('e2ee.recovery.create');
      for (const label of [
        'e2ee.recovery.check',
        'e2ee.recovery.replace',
        'e2ee.recovery.restore',
        'e2ee.recovery.passkeyAdd',
      ])
        expect(view.labels).toContain(label);
      expect(view.primary).toHaveLength(1);
      for (const status of [
        'e2ee.recovery.workspace.notSet',
        'e2ee.recovery.workspace.saved',
        'e2ee.recovery.workspace.verified',
      ])
        expect(view.text).toContain(status);
    } finally {
      view.done();
    }
  });

  it('offers only continue and abandon while a replacement runs', async () => {
    const view = await mount({
      hasVault: true,
      replaceable: true,
      replacing: true,
      covered: [workspace('a', { kind: 'verified', update: 1 })],
      uncovered: [],
    });
    try {
      expect(view.labels).toEqual([
        'e2ee.recovery.replaceContinue',
        'e2ee.recovery.replaceAbandon',
      ]);
      expect(view.primary).toEqual(['e2ee.recovery.replaceContinue']);
    } finally {
      view.done();
    }
  });

  it('still offers restore during a replacement when a workspace is not covered', async () => {
    const view = await mount({
      hasVault: true,
      replaceable: true,
      replacing: true,
      covered: [workspace('a', { kind: 'verified', update: 1 })],
      uncovered: [workspace('b', { kind: 'notSet' })],
    });
    try {
      for (const label of [
        'e2ee.recovery.restore',
        'e2ee.recovery.restorePasskey',
        'e2ee.recovery.replaceContinue',
        'e2ee.recovery.replaceAbandon',
      ])
        expect(view.labels).toContain(label);
      expect(view.labels).not.toContain('e2ee.recovery.replace');
      expect(view.primary).toEqual(['e2ee.recovery.replaceContinue']);
    } finally {
      view.done();
    }
  });

  it('shows the workspace status this device cannot read as unknown', async () => {
    const view = await mount({
      hasVault: true,
      replaceable: true,
      replacing: false,
      covered: [workspace('a', { kind: 'unknown' })],
      uncovered: [],
    });
    try {
      expect(view.text).toContain('e2ee.recovery.workspace.unknown');
    } finally {
      view.done();
    }
  });

  it('sets up every unfinished workspace with one unlock and counts only verified setups as done', async () => {
    const requests: unknown[][] = [];
    const view = await mount(
      {
        hasVault: true,
        replaceable: true,
        replacing: false,
        covered: [
          workspace('a', { kind: 'notSet' }),
          workspace('b', { kind: 'notSet' }),
          // Saved but unverified: its setup still has to finish.
          workspace('c', { kind: 'saved' }),
          workspace('d', { kind: 'verified', update: 2 }),
        ],
        uncovered: [],
      },
      {
        'e2ee.setupRecoveryForWorkspaces': (...args) => {
          requests.push(args);
          // b is still waiting for its envelope and c returned no result at all.
          return {
            outcome: 'settled',
            results: [
              { workspaceId: 'a', outcome: 'Committed', recoverable: true },
              { workspaceId: 'b', outcome: 'Pending', recoverable: false },
            ],
          };
        },
      }
    );
    try {
      expect(view.text).toContain('e2ee.recovery.uncoveredTitle');
      expect(view.primary).toEqual(['e2ee.recovery.setupAll']);
      // The saved workspace keeps its own way to continue.
      expect(view.labels).toContain('e2ee.recovery.setupContinue');
      await view.click('e2ee.recovery.setupAll');
      expect(requests).toEqual([[['a', 'b', 'c'], 'file']]);
      expect(view.text).toContain('e2ee.recovery.setupAllPartial');
      expect(view.text).not.toContain('e2ee.recovery.setupAllDone');
    } finally {
      view.done();
    }
  });

  it('shows when this device last checked the recovery file', async () => {
    const view = await mount(
      {
        hasVault: true,
        replaceable: true,
        replacing: false,
        covered: [workspace('a', { kind: 'verified', update: 1 })],
        uncovered: [],
      },
      {
        'e2ee.inspectRecoveryFile': () => ({
          outcome: 'opened',
          vaultId: 'v'.repeat(32),
          workspaces: 1,
        }),
      }
    );
    try {
      expect(view.text).toContain('e2ee.recovery.fileSaved');
      expect(view.text).not.toContain('e2ee.recovery.fileSavedChecked');
      await view.click('e2ee.recovery.check');
      expect(view.text).toContain('e2ee.recovery.fileSavedChecked');
    } finally {
      view.done();
    }
  });

  it('keeps read-only actions and offers retry when the recovery state cannot be read', async () => {
    let fail = true;
    const view = await mount(async () => {
      if (fail) throw new Error('e2ee_recovery_storage');
      return {
        hasVault: true,
        replaceable: true,
        replacing: false,
        covered: [workspace('a', { kind: 'saved' })],
        uncovered: [],
      };
    });
    try {
      expect(view.text).toContain('e2ee.recovery.planFailed');
      for (const label of [
        'common.retry',
        'e2ee.recovery.check',
        'e2ee.recovery.restore',
        'e2ee.recovery.restorePasskey',
        'e2ee.recovery.create',
      ])
        expect(view.labels).toContain(label);
      expect(view.primary).toEqual(['common.retry']);
      fail = false;
      await view.click('common.retry');
      expect(view.text).not.toContain('e2ee.recovery.planFailed');
      expect(view.labels).not.toContain('common.retry');
      // The saved workspace is not verified yet, so finishing its setup leads.
      expect(view.primary).toEqual(['e2ee.recovery.setupAll']);
      expect(view.text).toContain('e2ee.recovery.workspace.saved');
    } finally {
      view.done();
    }
  });

  it('says it is loading until the first recovery state arrives', async () => {
    let answer: (plan: RecoveryPlan) => void = () => {};
    const port = fakeRecoveryPort(
      { hasVault: false, replacing: false, covered: [], uncovered: [] },
      { plan: () => new Promise<RecoveryPlan>((resolve) => (answer = resolve)) }
    );
    const view = await mount(undefined, {}, port);
    try {
      expect(view.text).toContain('e2ee.recovery.loading');
      expect(view.text).not.toContain('e2ee.recovery.offlineHint');
      expect(view.labels).toEqual([]);
      await act(async () => answer({ hasVault: false, replacing: false, covered: [], uncovered: [] }));
      for (let tick = 0; tick < 5; tick++) await act(async () => {});
      expect(view.text).not.toContain('e2ee.recovery.loading');
      expect(view.primary).toEqual(['e2ee.recovery.create']);
    } finally {
      view.done();
    }
  });

  it('says recovery is off when desktop main refuses it, without retry or file actions', async () => {
    const view = await mount(async () => {
      throw new Error("Error invoking remote method: Error: e2ee_recovery_disabled");
    });
    try {
      expect(view.text).toContain('e2ee.recovery.disabled');
      expect(view.text).not.toContain('e2ee.recovery.planFailed');
      expect(view.text).not.toContain('e2ee.recovery.offlineHint');
      expect(view.labels).toEqual([]);
    } finally {
      view.done();
    }
  });

  it('never offers a file check, replacement or creation the host cannot perform', async () => {
    const requests: unknown[][] = [];
    const port = fakeRecoveryPort(
      {
        hasVault: true,
        replacing: false,
        covered: [
          workspace('a', { kind: 'notSet' }),
          workspace('b', { kind: 'verified', update: 1 }),
        ],
        uncovered: [],
      } as RecoveryPlan,
      {
        create: null,
        securityEvents: async () => [
          { id: 'event', kind: 'personal_device_recovered', occurredAt: 1 },
        ],
        setupWorkspaces: async (...args) => {
          requests.push(args);
          return {
            outcome: 'settled',
            results: [{ workspaceId: 'a', outcome: 'Committed', recoverable: true }],
          };
        },
      }
    );
    const view = await mount(undefined, {}, port);
    try {
      expect(view.text).toContain('e2ee.recovery.eventRecovered');
      for (const label of [
        'e2ee.recovery.check',
        'e2ee.recovery.replace',
        'e2ee.recovery.eventNotMe',
      ])
        expect(view.labels).not.toContain(label);
      expect(view.primary).toEqual(['e2ee.recovery.setupAll']);
      await view.click('e2ee.recovery.setupAll');
      expect(requests).toEqual([[['a'], 'file']]);
      expect(view.text).toContain('e2ee.recovery.setupAllDone');
    } finally {
      view.done();
    }
  });

  it('says where to create the file when the host cannot save one', async () => {
    const port = fakeRecoveryPort(
      { hasVault: false, replacing: false, covered: [], uncovered: [] },
      { create: null }
    );
    const view = await mount(undefined, {}, port);
    try {
      expect(view.text).toContain('e2ee.recovery.noneTitle');
      expect(view.text).toContain('e2ee.recovery.createElsewhere');
      expect(view.labels).toEqual([]);
    } finally {
      view.done();
    }
  });

  it('sends a replacement it cannot continue back to the device that started it and still restores', async () => {
    const port = fakeRecoveryPort(
      {
        hasVault: true,
        replacing: true,
        covered: [workspace('a', { kind: 'verified', update: 1 })],
        uncovered: [workspace('b', { kind: 'notSet' }), workspace('c', { kind: 'notSet' })],
      } as RecoveryPlan,
      {
        passkeyAvailable: async () => true,
        restore: async () => ({
          outcome: 'restored',
          results: [
            { name: 'Workspace b', outcome: 'Unconfirmed' },
            { name: 'Workspace partial', outcome: 'Committed', partialEpochKey: true },
            { name: 'Workspace c', outcome: 'not-backed-up' },
          ],
        }),
      }
    );
    const view = await mount(undefined, {}, port);
    try {
      expect(view.text).toContain('e2ee.recovery.replacingOtherDevice');
      // Read-only until the starting device finishes: no setup, passkey changes or
      // replacement actions, only restoring.
      expect(view.labels).toEqual(['e2ee.recovery.restore', 'e2ee.recovery.restorePasskey']);
      // Restoring is this host's only next step, so the file restore leads.
      expect(view.primary).toEqual(['e2ee.recovery.restore']);
      await view.click('e2ee.recovery.restore');
      // A wait that timed out is still waiting, and an uncovered workspace is not a failure.
      expect(view.text).toContain('e2ee.recovery.restoreWaiting');
      expect(view.text).toContain('e2ee.recovery.restorePartial');
      expect(view.text).toContain('e2ee.recovery.restoreNotBackedUp');
      expect(view.text).not.toContain('e2ee.recovery.restoreFailed');
    } finally {
      view.done();
    }
  });

  it('lets restore lead when a host without a file check has nothing to set up', async () => {
    const port = fakeRecoveryPort({
      hasVault: true,
      replacing: false,
      covered: [workspace('a', { kind: 'verified', update: 1 })],
      uncovered: [workspace('b', { kind: 'notSet' })],
    } as RecoveryPlan);
    const view = await mount(undefined, {}, port);
    try {
      expect(view.labels).not.toContain('e2ee.recovery.check');
      expect(view.primary).toEqual(['e2ee.recovery.restore']);
    } finally {
      view.done();
    }
  });

  it('keeps a settled passkey removal when the list cannot be read again', async () => {
    const port = fakeRecoveryPort(
      {
        hasVault: true,
        replacing: false,
        covered: [workspace('a', { kind: 'verified', update: 1 })],
        uncovered: [],
      } as RecoveryPlan,
      {
        passkeyAvailable: async () => true,
        listPasskeys: async () => ({
          outcome: 'listed',
          passkeys: [{ entryId: 'kept', label: 'Kept passkey' }],
          pending: [{ entryId: 'stale', label: 'Stale passkey' }],
        }),
        // The removal committed, then reading the list again failed.
        removePasskey: async () => ({ outcome: 'removed' }),
      }
    );
    const view = await mount(undefined, {}, port);
    try {
      await view.click('e2ee.recovery.passkeyManage');
      expect(view.text).toContain('Kept passkey');
      await view.click('e2ee.recovery.passkeyRemoveRetry');
      expect(view.text).toContain('e2ee.recovery.passkeyRemoved');
      expect(view.text).not.toContain('e2ee.recovery.failed');
      // The old lists may no longer be true; they are dropped until read anew.
      expect(view.text).not.toContain('Kept passkey');
      expect(view.labels).not.toContain('e2ee.recovery.passkeyRemoveRetry');
      expect(view.labels).toContain('e2ee.recovery.passkeyManage');
    } finally {
      view.done();
    }
  });
});

describe('encrypted workspace settings entry failures', () => {
  it('states what happened and offers the one step that helps', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const opened: unknown[] = [];
    const retried: unknown[] = [];
    const render = (error: string) =>
      act(async () =>
        root.render(
          <E2eeSecurityPanel
            error={error}
            onUpdate={() => {}}
            onRetry={() => retried.push(error)}
            onOpenConsole={(tab) => opened.push(tab)}
          />
        )
      );
    const button = (label: string) =>
      [...container.querySelectorAll('button')].find((b) => b.textContent === label);
    try {
      // A lost identity is repaired from the console, with another authorized device.
      await render('e2ee_missing-binding');
      expect(container.textContent).toContain('e2ee.security.error.identity.title');
      const consoleButtons = [...container.querySelectorAll('button')].filter(
        (b) => b.textContent === 'e2ee.security.openConsole'
      );
      // One way into the console, in the card; the status row does not repeat it.
      expect(consoleButtons).toHaveLength(1);
      expect(container.textContent).not.toContain('e2ee.security.identityMissing');
      await act(async () => consoleButtons[0]!.click());
      expect(opened).toEqual([undefined]);
      // A conflict only needs another look.
      await render('e2ee_management_conflict');
      await act(async () => button('e2ee.failure.action.refresh')!.click());
      expect(retried).toEqual(['e2ee_management_conflict']);
      // Restarting is the person's step; the card offers no button that cannot do it.
      await render('e2ee_restart-required');
      expect(container.textContent).toContain('e2ee.security.error.restart.title');
      expect(button('e2ee.failure.action.refresh')).toBeUndefined();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

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
    const button = [...document.body.querySelectorAll('button')].find(
      (node) => node.textContent === key
    );
    if (!button) throw new Error(`missing ${key}`);
    await act(async () => button.click());
  };
  // Devices and recovery live in the encryption console the General card opens.
  const openConsole = async (tab: 'devices' | 'recovery' | 'members') => {
    await click('e2ee.security.openConsole');
    for (let tick = 0; tick < 5; tick++) await act(async () => {});
    const target = document.body.querySelector(`[data-console-tab="${tab}"]`);
    if (!(target instanceof HTMLButtonElement)) throw new Error(`missing console tab ${tab}`);
    await act(async () => target.click());
  };
  const page = () => document.body.textContent ?? '';
  it.each(['plan', 'failure'] as const)(
    'drops the previous account recovery %s as soon as the account changes',
    async (shown) => {
      // Account B's answer has not arrived yet: nothing from account A may stay.
      const answers: Record<string, (account: string) => Promise<unknown>> = {
        'e2ee.recoveryReplacementPlan': async (account) => {
          if (account !== 'account') return new Promise(() => {});
          if (shown === 'failure') throw new Error('e2ee_recovery_unavailable');
          return {
            hasVault: true,
            replaceable: true,
            replacing: false,
            covered: [{ id: 'workspace', name: 'Account A workspace', status: { kind: 'notSet' } }],
            uncovered: [],
          };
        },
        'e2ee.recentAccountSecurityEvents': async () => [],
        'e2ee.recoveryPasskeyAvailable': async () => false,
      };
      let account = 'account';
      vi.stubGlobal('ipc', {
        invoke: (channel: string) => answers[channel]?.(account) ?? Promise.resolve(undefined),
        on: () => () => {},
      });
      store.set(developerModeEnabledAtom, true);
      store.set(e2eeRecoveryVaultEnabledAtom, true);
      try {
        await render();
        await openConsole('recovery');
        for (let tick = 0; tick < 5; tick++) await act(async () => {});
        const previous = shown === 'plan' ? 'Account A workspace' : 'e2ee.recovery.planFailed';
        expect(page()).toContain(previous);

        account = 'account-b';
        platform = {
          ...platform,
          identity: {
            ...platform.identity,
            session: createStaticStore({
              status: 'authenticated' as const,
              user: { id: 'account-b', name: 'Other', email: 'other@example.test' },
            }),
          },
        } as PlatformProvider;
        const mode = store.get(workspaceContentModeAtom)!;
        store.set(workspaceContentModeAtom, { ...mode, accountId: 'account-b' });
        await render();
        for (let tick = 0; tick < 5; tick++) await act(async () => {});
        expect(page()).not.toContain(previous);
      } finally {
        vi.unstubAllGlobals();
      }
    }
  );

  it('tells a host without recovery controls where to set recovery up instead of an empty tab', async () => {
    store.set(developerModeEnabledAtom, true);
    store.set(e2eeRecoveryVaultEnabledAtom, true);
    await render();
    await openConsole('recovery');
    expect(page()).toContain('e2ee.console.recoveryUnavailable');
  });

  it('explains instead of showing an empty tab when desktop recovery is switched off', async () => {
    // Desktop IPC exists, but the renderer switch is off: no vault call may happen and the
    // tab still explains itself, with no shortcut that promises a setup.
    store.set(developerModeEnabledAtom, true);
    store.set(e2eeRecoveryVaultEnabledAtom, false);
    const channels: string[] = [];
    vi.stubGlobal('ipc', {
      invoke: async (channel: string) => {
        channels.push(channel);
        return undefined;
      },
      on: () => () => {},
    });
    try {
      await render();
      await openConsole('recovery');
      for (let tick = 0; tick < 5; tick++) await act(async () => {});
      expect(page()).toContain('e2ee.console.recoveryUnavailable');
      expect(channels.filter((channel) => channel.startsWith('e2ee.recovery'))).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows a browser-shaped host's own recovery section for the current account", async () => {
    const host = {
      Section: ({ accountId }: { accountId?: string | null }) => (
        <p>host recovery for {accountId}</p>
      ),
    };
    await act(async () =>
      root.render(
        <Provider store={store}>
          <PlatformContext.Provider value={platform}>
            <E2eeRecoveryHostContext.Provider value={host}>
              <WorkspaceSettings />
            </E2eeRecoveryHostContext.Provider>
          </PlatformContext.Provider>
        </Provider>
      )
    );
    await openConsole('recovery');
    expect(page()).toContain('host recovery for account');
    expect(page()).not.toContain('e2ee.console.recoveryUnavailable');
  });

  it("renders the shared recovery section over a browser-shaped host's port", async () => {
    store.set(developerModeEnabledAtom, true);
    store.set(e2eeRecoveryVaultEnabledAtom, true);
    const port = fakeRecoveryPort({
      hasVault: true,
      replacing: false,
      covered: [{ id: 'workspace', name: 'Host workspace', status: { kind: 'notSet' } }],
      uncovered: [],
    });
    await act(async () =>
      root.render(
        <Provider store={store}>
          <PlatformContext.Provider value={platform}>
            <E2eeRecoveryHostContext.Provider value={{ port }}>
              <WorkspaceSettings />
            </E2eeRecoveryHostContext.Provider>
          </PlatformContext.Provider>
        </Provider>
      )
    );
    await openConsole('recovery');
    for (let tick = 0; tick < 5; tick++) await act(async () => {});
    expect(page()).toContain('Host workspace');
    expect(page()).toContain('e2ee.recovery.setupAll');
    expect(page()).not.toContain('e2ee.console.recoveryUnavailable');
  });

  const renderSharing = () =>
    act(async () =>
      root.render(
        <Provider store={store}>
          <PlatformContext.Provider value={platform}>
            <E2eeMachineSharingSettings
              machineId="synthetic-machine"
              projects={[{ id: 'project-a', name: 'Project A' }]}
            />
          </PlatformContext.Provider>
        </Provider>
      )
    );
  it('uses host ownership for the sharing surface and drops it immediately on account mismatch', async () => {
    platform.e2eeWorkspaces!.runtime!.readMachineSharing = async () => ({
      machineId: 'synthetic-machine',
      generation: '55'.repeat(32),
      ownerMembershipId: '11'.repeat(16),
      head: { revision: 3, digest: '33'.repeat(32) },
      sharedWithTeam: false,
      projects: [],
      canManage: false,
      signer: '44'.repeat(32),
      needsResign: false,
      deniedReason: 'e2ee_machine_not_shared',
    });
    await renderSharing();
    expect(container.textContent).toContain('e2ee.machineSharing.notOwned');
    expect(container.textContent).toContain('v3');
    expect(container.querySelectorAll('[role=switch]')).toHaveLength(0);
    const current = store.get(workspaceContentModeAtom)!;
    await act(async () =>
      store.set(workspaceContentModeAtom, { ...current, accountId: 'other-account' })
    );
    expect(container.textContent).toBe('');
  });
  it.each([false, true])(
    'keeps only owner-signed sharing in the device pane (local: %s)',
    async (isLocal) => {
      let shared = false;
      const writes: unknown[] = [];
      const generation = '55'.repeat(32);
      platform.e2eeWorkspaces!.runtime!.readMachineSharing = async () => ({
        machineId: 'synthetic-machine',
        generation,
        ownerMembershipId: '11'.repeat(16),
        head: { revision: shared ? 4 : 3, digest: '33'.repeat(32) },
        sharedWithTeam: shared,
        projects: [],
        canManage: true,
        signer: '44'.repeat(32),
        needsResign: false,
      });
      platform.e2eeWorkspaces!.runtime!.updateMachineSharing = async (
        _workspace,
        machine,
        selectedGeneration,
        requestId,
        change
      ) => {
        expect(machine).toBe('synthetic-machine');
        expect(selectedGeneration).toBe(generation);
        expect(requestId).toMatch(/^[0-9a-f]{32}$/);
        writes.push(change);
        if (change.kind === 'machine') shared = change.sharedWithTeam;
        return { status: 'saved', requestId };
      };
      await act(async () =>
        root.render(
          <Provider store={store}>
            <PlatformContext.Provider value={platform}>
              <MachineDetailPane
                {...({
                  machine: {
                    id: 'synthetic-machine',
                    name: 'Remote',
                    os: 'linux',
                    sessions: [],
                    raceLimits: {},
                  },
                  mode: 'devices',
                  isLocal,
                  isOwn: true,
                  configs: [],
                  ownerName: null,
                  sharedWithTeam: false,
                  canDelete: false,
                  onRename: async () => {},
                  onDelete: async () => {},
                  onAddConfig: () => {},
                  onEditConfig: () => {},
                  onSharedWithTeamChange: async () => {
                    throw new Error('ordinary sharing must stay closed');
                  },
                } as never)}
                footer={<E2eeMachineSharingSettings machineId="synthetic-machine" projects={[]} />}
              />
            </PlatformContext.Provider>
          </Provider>
        )
      );
      const toggle = () => container.querySelector<HTMLButtonElement>('[role="switch"]');
      expect(container.querySelectorAll('[role="switch"]')).toHaveLength(1);
      expect(toggle()).not.toBeNull();
      await act(async () => toggle()!.click());
      expect(writes).toEqual([{ kind: 'machine', sharedWithTeam: true }]);
      expect(toggle()?.getAttribute('aria-checked')).toBe('true');
      expect(container.textContent).toContain('v4');
      await act(async () => toggle()!.click());
      expect(shared).toBe(false);
      expect(writes).toHaveLength(2);
      expect(container.textContent).not.toContain('Restart daemon');
    }
  );
  it('drops an unknown sharing intent when the verified machine generation changes', async () => {
    let generation = '55'.repeat(32);
    let shared = false;
    const writes: { generation: string; requestId: string }[] = [];
    platform.e2eeWorkspaces!.runtime!.readMachineSharing = async () => ({
      machineId: 'synthetic-machine',
      generation,
      ownerMembershipId: '11'.repeat(16),
      head: null,
      sharedWithTeam: shared,
      projects: [],
      canManage: true,
      signer: null,
      needsResign: false,
    });
    platform.e2eeWorkspaces!.runtime!.updateMachineSharing = async (
      _workspace,
      _machine,
      selectedGeneration,
      requestId,
      change
    ) => {
      writes.push({ generation: selectedGeneration, requestId });
      if (writes.length === 1) return { status: 'pending', requestId };
      if (change.kind === 'machine') shared = change.sharedWithTeam;
      return { status: 'saved', requestId };
    };
    await renderSharing();
    await act(async () => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    expect(shared).toBe(false);
    expect(container.textContent).toContain('e2ee.machineSharing.issue.pending');
    generation = '66'.repeat(32);
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(container.textContent).toContain('e2ee.machineSharing.issue.generation');
    expect(container.textContent).not.toContain('e2ee.machineSharing.retry');
    expect(writes).toHaveLength(1);
    await act(async () => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    expect(writes[1]?.generation).toBe(generation);
    expect(writes[1]?.requestId).not.toBe(writes[0]?.requestId);
    expect(shared).toBe(true);
  });
  it('explains missing mobile policy support without pretending that a sharing host exists', async () => {
    await renderSharing();
    expect(container.textContent).toContain('e2ee.machineSharing.issue.unsupported');
    expect(container.querySelector('[role="switch"]')).toBeNull();
    expect(container.textContent).not.toContain('e2ee.machineSharing.issue.unavailable');
  });
  it('does not open sharing ports for an ordinary workspace', async () => {
    platform.e2eeWorkspaces!.runtime!.readMachineSharing = async () => {
      throw new Error('ordinary settings opened a crypto port');
    };
    store.set(workspaceContentModeAtom, null);
    await renderSharing();
    expect(container.textContent).toBe('');
  });
  it('waits for an explicit click, keeps retry and device rows after failure, then completes and clears the badge', async () => {
    await render();
    expect(signed).toBe(false);
    expect(container.querySelector('[role=status]')).not.toBeNull();
    fail = true;
    await click('e2ee.security.complete');
    expect(container.textContent).toContain('e2ee.security.error.retry.title');
    await openConsole('devices');
    expect(page()).toContain('synthetic-machine');
    expect(signed).toBe(false);
    fail = false;
    const complete = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'e2ee.security.complete'
    )!;
    await act(async () => complete.click());
    expect(signed).toBe(true);
    expect(container.textContent).toContain('e2ee.security.current');
    expect(container.querySelector('[role=status]')).toBeNull();
  });
  it('shows delegation when no eligible manager exists and permits the separate revoke action', async () => {
    state = { ...state, mayRotate: false };
    await render();
    expect(container.textContent).toContain('e2ee.security.useManager');
    expect(container.querySelector('[role=status]')).toBeNull();
    await openConsole('devices');
    await click('e2ee.security.revoke');
    expect(page()).not.toContain('synthetic-machine');
    expect(signed).toBe(false);
  });
  it('keeps a continuation action after the epoch committed but installation/ack is pending', async () => {
    state = { ...state, rotationRequired: false, updatePending: true };
    await render();
    expect(container.textContent).toContain('e2ee.security.complete');
    expect(container.querySelector('[role=status]')).not.toBeNull();
  });
  it('shows an update another window is running as busy, not as an action that would refuse', async () => {
    state = { ...state, updatePending: true, updateInProgress: true };
    await render();
    expect(container.textContent).toContain('e2ee.security.updating');
    expect(container.textContent).not.toContain('e2ee.security.complete');
    const update = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'e2ee.security.updating'
    );
    expect(update?.disabled).toBe(true);
    await openConsole('devices');
    const revoke = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent === 'e2ee.security.revoke'
    );
    expect(revoke?.disabled).toBe(true);
  });
  it('adds a device from the General card and keeps one way to add it on the Devices tab', async () => {
    const personalPairing = () =>
      document.body.querySelector('[data-testid="e2ee-personal-pairing-state"]');
    Object.assign(platform.e2eeWorkspaces!.runtime!, {
      preparePersonalJoin: async () => ({}),
      claimPersonalJoin: async () => ({}),
      cancelPersonalJoin: async () => {},
    });
    await render();
    await click('e2ee.security.addDevice');
    for (let tick = 0; tick < 5; tick++) await act(async () => {});
    expect(
      document.body.querySelector('[data-console-tab="devices"]')?.getAttribute('aria-current')
    ).toBe('page');
    // A host without account pairing keeps the per-workspace exchange.
    expect(personalPairing()).not.toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);
    platform.e2eeWorkspaces!.runtime!.inspectAccountPairing = async () => null;
    await render();
    await click('e2ee.security.addDevice');
    for (let tick = 0; tick < 5; tick++) await act(async () => {});
    expect(page()).toContain('synthetic-machine');
    expect(personalPairing()).toBeNull();
  });
  it('keeps the ordinary General page and leaves encrypted team management to the console', async () => {
    state = { ...state, rotationRequired: false };
    await render();
    expect(container.textContent).toContain('ordinary settings without team management');
    expect(container.textContent).toContain('e2ee.security.current');
    expect(container.textContent).not.toContain('e2ee.security.attention');
    await click('e2ee.security.openConsole');
    // The console opens over Settings instead of leaving the workspace.
    expect(navigation.target).toBeNull();
    expect(document.body.querySelector('[data-testid="e2ee-workspace-console"]')).not.toBeNull();
  });
  it('sends encrypted ownership transfer from the danger zone to the console members page', async () => {
    state = { ...state, rotationRequired: false };
    await render();
    await click('danger zone transfer');
    expect(navigation.target).toBeNull();
    expect(
      document.body.querySelector('[data-console-tab="members"]')?.getAttribute('aria-current')
    ).toBe('page');
  });
  it('turns a waiting link request into a review item that opens the console', async () => {
    state = { ...state, rotationRequired: false };
    platform.e2eeWorkspaces!.runtime!.memberJoinRequests = async () =>
      ({ items: [{ source: 'link', state: 'pending' }] }) as never;
    await render();
    for (let tick = 0; tick < 5; tick++) await act(async () => {});
    expect(container.textContent).toContain('e2ee.security.joinRequests');
    await click('e2ee.security.review');
    expect(navigation.target).toBeNull();
    expect(
      document.body.querySelector('[data-console-tab="members"]')?.getAttribute('aria-current')
    ).toBe('page');
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

it.each([true, false])(
  'keeps the last personal device until loss of access is confirmed (recovery available: %s)',
  async (recoveryDeviceAvailable) => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const revoked: { key: string; confirmed: boolean }[] = [];
    try {
      await act(async () =>
        root.render(
          <E2eeDevicesPanel
            state={{
              epoch: 1,
              rotationRequired: false,
              mayRotate: true,
              updatePending: false,
              devices: [
                {
                  key: 'ab'.repeat(32),
                  kind: 'personal',
                  machineId: null,
                  self: true,
                  mayRevoke: true,
                  requiresRecoveryConfirmation: true,
                  recoveryDeviceAvailable,
                },
              ],
            }}
            onUpdate={() => {}}
            onRetry={() => {}}
            onRevoke={(key, confirmation) => {
              revoked.push({ key, confirmed: confirmation?.confirmedRecoveryOnly === true });
            }}
          />
        )
      );
      const remove = container.querySelector(
        '[data-testid="e2ee-device-revoke"]'
      ) as HTMLButtonElement;
      await act(async () => remove.click());
      expect(revoked).toEqual([]);
      expect(
        document.querySelector('[data-testid="e2ee-last-personal-confirm"]')?.textContent
      ).toContain(
        recoveryDeviceAvailable
          ? 'e2ee.security.lastPersonalWarning'
          : 'e2ee.security.lastPersonalNoRecovery'
      );
      const cancel = [...document.body.querySelectorAll('button')].find(
        (button) => button.textContent === 'common.cancel'
      )!;
      await act(async () => cancel.click());
      expect(revoked).toEqual([]);
      await act(async () => remove.click());
      await act(async () =>
        (
          document.querySelector('[data-testid="e2ee-last-personal-revoke"]') as HTMLButtonElement
        ).click()
      );
      expect(revoked).toEqual([{ key: 'ab'.repeat(32), confirmed: true }]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  }
);
