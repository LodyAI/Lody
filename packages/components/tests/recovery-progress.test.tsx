// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { expect, it } from 'vitest';
import {
  RecoveryVaultSection,
  preferredRecoveryUnlock,
} from '../src/components/settings/e2ee/recovery-vault-section';
import {
  E2eeRecoveryHostContext,
  type RecoveryPort,
  type RecoveryRestoreResult,
} from '../src/components/settings/e2ee/recovery-port';
import { e2eeRecoveryVaultEnabledAtom } from '../src/atoms/settings';
import { TestCloudPlatformProvider } from './test-platform';
import { createTestI18n, withTestI18n } from './test-i18n';

it('shows each installed workspace while its peer is waiting and ignores results after account change', async () => {
  const store = createStore();
  store.set(e2eeRecoveryVaultEnabledAtom, true);
  let observedSignal: AbortSignal | undefined;
  let observe: ((row: RecoveryRestoreResult) => void) | undefined;
  const done = Promise.withResolvers<Awaited<ReturnType<RecoveryPort['restore']>>>();
  const never = () => new Promise<never>(() => {});
  const port: RecoveryPort = {
    plan: async () => ({
      hasVault: true,
      replacing: false,
      methods: { hasFile: true, hasPassword: false, hasPasskey: false },
      covered: [],
      uncovered: [
        { id: 'first', name: 'Same name' },
        { id: 'second', name: 'Same name' },
      ],
    }),
    securityEvents: async () => [],
    passkeyAvailable: async () => false,
    create: null,
    checkFile: null,
    replacement: null,
    setupWorkspace: never,
    setupWorkspaces: never,
    passkeyDefaultLabel: never,
    addPasskey: never,
    listPasskeys: never,
    removePasskey: never,
    restore: (_method, _options, onResult, signal) => {
      observedSignal = signal;
      observe = onResult;
      return done.promise;
    },
  };
  const host = { port };
  const i18n = createTestI18n({ keyLabels: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = (accountId: string) =>
    root.render(
      withTestI18n(
        <TestCloudPlatformProvider>
          <Provider store={store}>
            <E2eeRecoveryHostContext.Provider value={host}>
              <RecoveryVaultSection accountId={accountId} />
            </E2eeRecoveryHostContext.Provider>
          </Provider>
        </TestCloudPlatformProvider>,
        i18n
      )
    );
  try {
    await act(async () => render('account-a'));
    const button = [...container.querySelectorAll('button')].find(
      (el) => el.textContent === 'e2ee.recovery.restore'
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(
      container
        .querySelector('[data-recovery-result="second"]')
        ?.getAttribute('data-recovery-outcome')
    ).toBe('Restoring');
    await act(async () =>
      observe!({ workspaceId: 'first', name: 'Same name', outcome: 'Committed' })
    );
    expect(container.querySelector('[data-recovery-result="first"]')?.textContent).toBe(
      'e2ee.recovery.restoreDone'
    );
    expect(container.querySelector('[data-recovery-result="second"]')?.textContent).toBe(
      'e2ee.recovery.restoreWorking'
    );
    await act(async () => render('account-b'));
    expect(observedSignal?.aborted).toBe(true);
    await act(async () => {
      observe!({
        workspaceId: 'second',
        name: 'Same name',
        outcome: 'Committed',
        partialEpochKey: true,
      });
      done.resolve({
        outcome: 'restored',
        results: [{ workspaceId: 'second', name: 'Same name', outcome: 'Committed' }],
      });
    });
    expect(container.querySelector('[data-recovery-result]')).toBeNull();
  } finally {
    done.resolve({ outcome: 'cancelled' });
    await act(async () => root.unmount());
    container.remove();
  }
});

it('desktop progress detaches without cancelling recovery and keeps partial-key results', async () => {
  const { desktopRecoveryPort } =
    await import('../src/components/settings/e2ee/recovery-desktop-port');
  const previous = window.ipc;
  const listeners = new Set<(payload: unknown) => void>();
  const done = Promise.withResolvers<{ outcome: 'restored'; results: RecoveryRestoreResult[] }>();
  let operationId: string | undefined;
  const e2ee = {
    restoreFromRecoveryFile: (_method: string, _options: unknown, id: string) => {
      operationId = id;
      return done.promise;
    },
  } as unknown as Parameters<typeof desktopRecoveryPort>[0];
  window.ipc = {
    invoke: async () => undefined,
    on: (_channel, listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    send: () => {},
  };
  const received: RecoveryRestoreResult[] = [];
  const observation = new AbortController();
  try {
    const restoring = desktopRecoveryPort(e2ee).restore(
      'file',
      undefined,
      (row) => received.push(row),
      observation.signal
    );
    const row = {
      workspaceId: 'first',
      name: 'First',
      outcome: 'Committed',
      partialEpochKey: true,
    };
    for (const listener of listeners) listener({ operationId: 'other-window', result: row });
    expect(received).toEqual([]);
    for (const listener of listeners) listener({ operationId, result: row });
    expect(received).toEqual([row]);
    observation.abort();
    expect(listeners.size).toBe(0);
    done.resolve({ outcome: 'restored', results: [row] });
    expect(await restoring).toEqual({ outcome: 'restored', results: [row] });
  } finally {
    done.resolve({ outcome: 'restored', results: [] });
    window.ipc = previous;
  }
});

it('prefers known vault unlock methods before an unknown passkey', () => {
  expect(preferredRecoveryUnlock(undefined, true)).toBeUndefined();
  const passwordOnly = { hasFile: false, hasPassword: true, hasPasskey: null };
  expect(preferredRecoveryUnlock(passwordOnly, true)).toBe('password');
  expect(preferredRecoveryUnlock({ ...passwordOnly, hasFile: true }, true)).toBe('file');
  expect(preferredRecoveryUnlock({ ...passwordOnly, hasPasskey: true }, true)).toBe('passkey');
  expect(preferredRecoveryUnlock({ ...passwordOnly, hasPasskey: true }, false)).toBe('password');
});
