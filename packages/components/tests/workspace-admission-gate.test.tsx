// @vitest-environment jsdom

import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { runtimeInitializingAtom } from '../src/atoms/control-connection';

import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import type {
  E2eeWorkspaceRuntime,
  E2eeRuntimeStatus,
  PlatformE2eeWorkspaces,
  PlatformProvider,
} from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { createStaticStore } from '@lody/platform';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceAdmissionGate } from '../src/components/workspace-admission-gate';
import { userAtom } from '../src/atoms';
import { developerModeEnabledAtom, e2eeWorkspaceCreationEnabledAtom } from '../src/atoms/settings';
import { workspaceContentModeAtom } from '../src/atoms/workspace-content-mode';
import {
  runtimeAtom,
  workspaceModeAdmissionRetryAtom,
  workspaceRuntimeInitFailureAtom,
  type WorkspaceRuntimeInitFailure,
} from '../src/atoms/runtime';
import { initI18n } from '../src/i18n';
import {
  readWorkspaceModeEvidence,
  recoverE2eeWorkspaceIdentity,
  retainWorkspaceModeProof,
} from '../src/lib/e2ee-workspace-storage';
import { TEST_CLOUD_PLATFORM } from './test-platform';

const platform: PlatformProvider = {
  ...TEST_CLOUD_PLATFORM,
  e2eeWorkspaces: {} as PlatformE2eeWorkspaces,
};

describe('WorkspaceAdmissionGate', () => {
  let root: Root;
  let container: HTMLDivElement;
  let store: ReturnType<typeof createStore>;

  const render = () =>
    act(async () => {
      root.render(
        <React.StrictMode>
          <PlatformContext.Provider value={platform}>
            <Provider store={store}>
              <WorkspaceAdmissionGate workspaceName="alpha">
                <div>workspace content</div>
              </WorkspaceAdmissionGate>
            </Provider>
          </PlatformContext.Provider>
        </React.StrictMode>
      );
    });
  const fail = (failure: Omit<WorkspaceRuntimeInitFailure, 'workspaceSlug'>) =>
    store.set(workspaceRuntimeInitFailureAtom, { workspaceSlug: 'alpha', ...failure });
  const text = () => container.textContent ?? '';

  beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    await initI18n('en');
    localStorage.clear();
    Object.assign(platform.e2eeWorkspaces!, { runtime: undefined });
    Object.assign(platform, { identity: TEST_CLOUD_PLATFORM.identity });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    store = createStore();
    store.set(userAtom, { id: 'account' } as never);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it.each([false, true])(
    'routes encrypted admission to control only without a paired runtime (paired=%s)',
    async (paired) => {
      Object.assign(platform.e2eeWorkspaces!, { runtime: native() });
      const mode = {
        accountId: 'account',
        workspaceSlug: 'alpha',
        workspaceId: 'encrypted',
        descriptor: {
          workspaceId: 'encrypted',
          contentMode: 'e2ee' as const,
          contentModeVersion: 1 as const,
          activation: 'control-only' as const,
          genesisHash: 'ab'.repeat(32),
          cryptoOrgId: 'ab'.repeat(32),
        },
      };
      store.set(workspaceContentModeAtom, mode);
      store.set(runtimeInitializingAtom, false);
      if (paired)
        store.set(runtimeAtom, {
          accountId: 'account',
          workspaceSlug: 'alpha',
          workspaceId: 'encrypted',
          contentMode: 'e2ee',
        } as never);
      const rootRoute = createRootRoute({ component: Outlet });
      const router = createRouter({
        history: createMemoryHistory({ initialEntries: ['/alpha/chat'] }),
        routeTree: rootRoute.addChildren([
          createRoute({
            getParentRoute: () => rootRoute,
            path: '/alpha/chat',
            component: () => (
              <WorkspaceAdmissionGate workspaceName="alpha">
                <div>encrypted chat</div>
              </WorkspaceAdmissionGate>
            ),
          }),
          createRoute({
            getParentRoute: () => rootRoute,
            path: '/workspace/e2ee/$workspaceId',
            component: () => <div>Pair this desktop</div>,
          }),
        ]),
      });
      await act(async () => {
        await router.load();
        root.render(
          <PlatformContext.Provider value={platform}>
            <Provider store={store}>
              <RouterProvider router={router} />
            </Provider>
          </PlatformContext.Provider>
        );
      });
      expect(router.state.location.pathname).toBe(
        paired ? '/alpha/chat' : '/workspace/e2ee/encrypted'
      );
      expect(text()).toContain(paired ? 'encrypted chat' : 'Pair this desktop');
    }
  );

  it('explains terminal member removal and requires a new invitation', async () => {
    fail({ errorType: 'e2ee_member_removed' });
    await render();
    expect(text()).toContain('Workspace access removed');
    expect(text()).toContain('Rejoining requires a new invitation');
    expect(text()).not.toContain('workspace content');
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders an ordinary workspace under a provisional verdict without mentioning encryption', async () => {
    store.set(workspaceContentModeAtom, {
      accountId: 'account',
      workspaceSlug: 'alpha',
      workspaceId: null,
      descriptor: null,
    });
    await render();
    expect(text()).toBe('workspace content');
  });

  it('waits with the ordinary loading copy while the verdict is unknown', async () => {
    await render();
    expect(text()).toContain('Loading workspace');
    expect(text()).not.toMatch(/encrypt|mode/i);
  });

  it.each([
    ['a mode failure of an ordinary workspace', { modeAdmission: { knownEncrypted: false } }],
    ['a runtime failure unrelated to mode', {}],
  ] as const)('shows the ordinary open failure for %s', async (_case, extra) => {
    fail({ errorType: 'WorkspaceModeAdmissionTimeoutError', ...extra });
    await render();
    expect(text()).toContain('Unable to open workspace');
    expect(text()).not.toMatch(/encrypt|mode/i);
  });

  it('explains a mode failure for a workspace known to be encrypted', async () => {
    fail({
      errorType: 'WorkspaceModeAdmissionTimeoutError',
      modeAdmission: { knownEncrypted: true },
    });
    await render();
    expect(text()).toContain('Workspace mode could not be verified');
  });

  it('explains mode failures only to a developer who enabled encrypted creation', async () => {
    store.set(developerModeEnabledAtom, true);
    store.set(e2eeWorkspaceCreationEnabledAtom, true);
    fail({ errorType: 'Error', modeAdmission: { knownEncrypted: false } });
    await render();
    expect(text()).toContain('Workspace mode could not be verified');

    // A rejected shutdown of the previous runtime is not a mode failure.
    await act(async () => fail({ errorType: 'Error' }));
    expect(text()).toContain('Unable to open workspace');
  });

  it('retries in place from the failure screen', async () => {
    fail({ errorType: 'Error', modeAdmission: { knownEncrypted: false } });
    await render();
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry'
    );
    await act(async () => retry?.click());
    expect(store.get(workspaceModeAdmissionRetryAtom)).toBe(1);
  });
  it('retries an ordinary workspace after deleting its unreadable optional proof without native access', async () => {
    const key = 'lody-workspace-mode-proof:account:ordinary';
    localStorage.setItem(key, '{broken proof');
    Object.assign(platform.e2eeWorkspaces!, {
      runtime: {
        account: async () => {
          throw new Error('ordinary retry must not query native identity');
        },
        status: async () => {
          throw new Error('e2ee_not_open');
        },
      },
    });
    fail({
      errorType: 'E2eeLocalEvidenceCorruptError',
      modeAdmission: { knownEncrypted: false, workspaceId: 'ordinary' },
    });
    await render();
    const retry = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry'
    );
    await act(async () => retry?.click());
    expect(localStorage.getItem(key)).toBeNull();
    expect(store.get(workspaceModeAdmissionRetryAtom)).toBe(1);
    expect(text()).not.toMatch(/encrypt|mode|pair/i);
  });

  const hash = 'ab'.repeat(32);
  const pin = 'lody-e2ee-genesis-pin:account:encrypted';
  const known = 'lody-e2ee-known-mode:account:encrypted';
  const native = (status = { workspaceId: 'encrypted', genesisHash: hash } as E2eeRuntimeStatus) =>
    ({
      account: async () => ({ userId: 'account', source: 'offline' }),
      readIdentity: async () => ({
        workspaceId: status.workspaceId,
        genesisHash: status.genesisHash,
      }),
    }) as E2eeWorkspaceRuntime;
  const retry = () =>
    act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Retry')
        ?.click();
    });

  it('restores unreadable markers from native verified identity and archives their exact bytes before retry', async () => {
    Object.assign(platform.e2eeWorkspaces!, { runtime: native() });
    localStorage.setItem(pin, 'broken pin');
    localStorage.setItem(known, 'broken marker');
    fail({
      errorType: 'E2eeLocalEvidenceCorruptError',
      modeAdmission: { knownEncrypted: true, workspaceId: 'encrypted' },
    });
    await render();
    await retry();
    expect(store.get(workspaceModeAdmissionRetryAtom)).toBe(1);
    expect(readWorkspaceModeEvidence(localStorage, 'account', 'encrypted').encrypted).toBe(true);
    expect(localStorage.getItem(pin)).toBe(hash);
    expect(localStorage.getItem(known)).toBe(hash);
    const originals = Object.keys(localStorage)
      .filter((key) => key.startsWith('lody-e2ee-evidence-archive:'))
      .map((key) => JSON.parse(localStorage.getItem(key)!));
    expect(originals).toEqual(
      expect.arrayContaining([
        { key: pin, raw: 'broken pin' },
        { key: known, raw: 'broken marker' },
      ])
    );
  });

  it('recovers with native offline identity after the renderer account snapshot expires', async () => {
    store.set(userAtom, null);
    Object.assign(platform, {
      identity: { ...platform.identity, session: createStaticStore({ status: 'loading' }) },
    });
    Object.assign(platform.e2eeWorkspaces!, { runtime: native() });
    localStorage.setItem(pin, 'broken pin');
    fail({
      errorType: 'E2eeLocalEvidenceCorruptError',
      modeAdmission: { knownEncrypted: true, workspaceId: 'encrypted' },
    });
    await render();
    await retry();
    expect(localStorage.getItem(pin)).toBe(hash);
    expect(store.get(workspaceModeAdmissionRetryAtom)).toBe(1);
  });

  it.each(['missing-native', 'conflict'])(
    'guides identity recheck instead of replacing evidence for %s',
    async (condition) => {
      localStorage.setItem(pin, 'broken pin');
      if (condition === 'conflict') {
        localStorage.setItem(known, 'cd'.repeat(32));
        Object.assign(platform.e2eeWorkspaces!, { runtime: native() });
      }
      fail({
        errorType: 'E2eeLocalEvidenceCorruptError',
        modeAdmission: { knownEncrypted: true, workspaceId: 'encrypted' },
      });
      await render();
      await retry();
      expect(store.get(workspaceModeAdmissionRetryAtom)).toBe(0);
      expect(text()).toContain('pair');
      expect(localStorage.getItem(pin)).toBe('broken pin');
      expect(
        Object.keys(localStorage).some((key) => key.startsWith('lody-e2ee-evidence-archive:'))
      ).toBe(false);
    }
  );

  it('rejects a different readable mode proof and an account switch during native recovery', async () => {
    retainWorkspaceModeProof(localStorage, 'account', 'alpha', {
      workspaceId: 'encrypted',
      contentMode: 'plaintext',
      contentModeVersion: 1,
    });
    localStorage.setItem(pin, 'broken pin');
    const recover = (runtime = native()) =>
      recoverE2eeWorkspaceIdentity({
        storage: localStorage,
        accountId: 'account',
        workspaceId: 'encrypted',
        runtime,
        isCurrent: () => true,
      });
    await expect(recover()).rejects.toThrow('conflicts');
    expect(localStorage.getItem(pin)).toBe('broken pin');
    localStorage.removeItem('lody-workspace-mode-proof:account:encrypted');
    let accountId = 'account';
    await expect(
      recover({
        ...native(),
        account: async () => ({ userId: accountId, source: 'offline' }),
        readIdentity: async () => {
          accountId = 'other';
          return { workspaceId: 'encrypted', genesisHash: hash } as E2eeRuntimeStatus;
        },
      })
    ).rejects.toThrow('checked again');
    expect(localStorage.getItem(pin)).toBe('broken pin');
  });

  it('reports identity recheck when native verified identity is unavailable', async () => {
    localStorage.setItem(pin, 'broken pin');
    const cause = new Error('e2ee_missing-binding');
    await expect(
      recoverE2eeWorkspaceIdentity({
        storage: localStorage,
        accountId: 'account',
        workspaceId: 'encrypted',
        runtime: {
          ...native(),
          readIdentity: async () => {
            throw cause;
          },
        },
        isCurrent: () => true,
      })
    ).rejects.toMatchObject({
      name: 'E2eeLocalEvidenceConflictError',
      message: 'Workspace identity must be checked again',
      cause,
    });
    expect(localStorage.getItem(pin)).toBe('broken pin');
  });

  it('keeps damaged originals when archive storage is full', async () => {
    const dom = new JSDOM('', { url: 'https://quota.test', storageQuota: 180 });
    const storage = dom.window.localStorage;
    storage.setItem(pin, 'broken pin');
    storage.setItem('filler', 'x'.repeat(100));
    await expect(
      recoverE2eeWorkspaceIdentity({
        storage,
        accountId: 'account',
        workspaceId: 'encrypted',
        runtime: native(),
        isCurrent: () => true,
      })
    ).rejects.toThrow();
    expect(storage.getItem(pin)).toBe('broken pin');
    dom.window.close();
  });
});
