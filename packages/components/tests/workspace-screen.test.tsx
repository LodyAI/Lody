// @vitest-environment jsdom

import {
  createRouter,
  createRootRoute,
  createRoute,
  createHashHistory,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import {
  createStaticStore,
  LOCAL_PLATFORM_CAPABILITIES,
  type PlatformE2eeWorkspaces,
  type PlatformProvider,
} from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WorkspaceScreen,
  WorkspaceScreenView,
} from '../src/components/onboarding/screens/workspace-screen';
import { initI18n } from '../src/i18n';
import { toast } from '../src/lib/toast';
import { TEST_CLOUD_PLATFORM } from './test-platform';

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((item) =>
    item.textContent?.includes(label)
  );
  if (!button) throw new Error(`Expected button containing "${label}"`);
  return button;
}

describe('WorkspaceScreen write recovery', () => {
  let root: Root | undefined;
  let container: HTMLDivElement;

  beforeEach(async () => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('bounds a pending switch and ignores late success after the user goes back', async () => {
    let resolveSwitch: (() => void) | undefined;
    const setActive = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSwitch = resolve;
        })
    );
    const platform: PlatformProvider = {
      ...TEST_CLOUD_PLATFORM,
      kind: 'local',
      capabilities: LOCAL_PLATFORM_CAPABILITIES,
      cloudApi: undefined,
      workspaces: {
        state: createStaticStore({
          status: 'ready' as const,
          workspaces: [
            { id: 'workspace-a', name: 'Alpha', slug: 'alpha', role: 'owner' },
            { id: 'workspace-b', name: 'Beta', slug: 'beta', role: 'owner' },
          ],
          activeWorkspaceId: 'workspace-a',
        }),
        setActive,
      },
    };
    const onBack = vi.fn();
    const onNext = vi.fn();

    await act(async () => {
      root?.render(
        <PlatformContext.Provider value={platform}>
          <Provider store={createStore()}>
            <WorkspaceScreen onBack={onBack} onNext={onNext} />
          </Provider>
        </PlatformContext.Provider>
      );
    });
    await act(async () => {
      findButton(container, 'Beta').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      findButton(container, 'Next').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(setActive).toHaveBeenCalledWith('workspace-b');
    expect(findButton(container, 'Back').disabled).toBe(true);
    expect(findButton(container, 'Next').disabled).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    expect(findButton(container, 'Back').disabled).toBe(false);
    expect(findButton(container, 'Next').disabled).toBe(false);

    await act(async () => {
      findButton(container, 'Back').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onBack).toHaveBeenCalledOnce();

    await act(async () => {
      resolveSwitch?.();
      await Promise.resolve();
    });
    expect(onNext).not.toHaveBeenCalled();
  });

  it('shows the workspace load error, logs it, and offers a real retry', async () => {
    const retry = vi.fn(() => Promise.resolve());
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const platform: PlatformProvider = {
      ...TEST_CLOUD_PLATFORM,
      kind: 'local',
      capabilities: LOCAL_PLATFORM_CAPABILITIES,
      cloudApi: undefined,
      workspaces: {
        state: createStaticStore({
          status: 'error' as const,
          message: 'organization list request failed with status 503',
        }),
        retry,
        setActive: vi.fn(() => Promise.resolve()),
      },
    };

    await act(async () => {
      root?.render(
        <PlatformContext.Provider value={platform}>
          <Provider store={createStore()}>
            <WorkspaceScreen onBack={vi.fn()} onNext={vi.fn()} />
          </Provider>
        </PlatformContext.Provider>
      );
    });

    expect(container.textContent).toContain('organization list request failed with status 503');
    expect(consoleError).toHaveBeenCalledWith(
      '[onboarding] Failed to load workspaces:',
      'organization list request failed with status 503'
    );

    await act(async () => {
      findButton(container, 'Retry').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(retry).toHaveBeenCalledOnce();
  });

  it('keeps creation blocked when slug verification is slow', async () => {
    const noop = vi.fn();
    const retrySlugCheck = vi.fn();

    await act(async () => {
      root?.render(
        <PlatformContext.Provider value={TEST_CLOUD_PLATFORM}>
          <Provider store={createStore()}>
            <WorkspaceScreenView
              workspaces={[]}
              workspacesStatus="ready"
              workspacesError={null}
              retryingWorkspaces={false}
              onRetryWorkspaces={noop}
              selectedWorkspaceId={null}
              creating
              repairingWorkspaceName={null}
              onStartCreate={noop}
              onStartRepair={noop}
              onCancelCreate={noop}
              newName="Loro Lab"
              newSlug="loro-lab"
              newSlugChecking
              newSlugAvailable={false}
              newSlugCheckSlow
              newSlugCheckError={null}
              newSlugError={null}
              canResetSlug={false}
              onNewNameChange={noop}
              onNewSlugChange={noop}
              onResetNewSlug={noop}
              onRetryNewSlugCheck={retrySlugCheck}
              saving={false}
              writePending={false}
              createError={null}
              onSelectWorkspace={noop}
              onConfirmSelection={noop}
              onSubmitCreate={noop}
              onBack={noop}
            />
          </Provider>
        </PlatformContext.Provider>
      );
    });

    expect(container.textContent).toContain(
      'Network is taking longer than expected. Still checking…'
    );
    expect(findButton(container, 'Create & continue').disabled).toBe(true);
    await act(async () => {
      findButton(container, 'Check again').dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      );
    });
    expect(retrySlugCheck).toHaveBeenCalledOnce();
  });

  it('shows slug query details and keeps a real retry available', async () => {
    const noop = vi.fn();
    const retrySlugCheck = vi.fn();

    await act(async () => {
      root?.render(
        <PlatformContext.Provider value={TEST_CLOUD_PLATFORM}>
          <Provider store={createStore()}>
            <WorkspaceScreenView
              workspaces={[]}
              workspacesStatus="ready"
              workspacesError={null}
              retryingWorkspaces={false}
              onRetryWorkspaces={noop}
              selectedWorkspaceId={null}
              creating
              repairingWorkspaceName={null}
              onStartCreate={noop}
              onStartRepair={noop}
              onCancelCreate={noop}
              newName="Loro Lab"
              newSlug="loro-lab"
              newSlugChecking={false}
              newSlugAvailable={false}
              newSlugCheckSlow={false}
              newSlugCheckError="network connection unavailable"
              newSlugError={null}
              canResetSlug={false}
              onNewNameChange={noop}
              onNewSlugChange={noop}
              onResetNewSlug={noop}
              onRetryNewSlugCheck={retrySlugCheck}
              saving={false}
              writePending={false}
              createError={null}
              onSelectWorkspace={noop}
              onConfirmSelection={noop}
              onSubmitCreate={noop}
              onBack={noop}
            />
          </Provider>
        </PlatformContext.Provider>
      );
    });

    expect(container.textContent).toContain('network connection unavailable');
    expect(findButton(container, 'Create & continue').disabled).toBe(true);
    await act(async () => {
      findButton(container, 'Retry').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(retrySlugCheck).toHaveBeenCalledOnce();
  });

  it('opens an inline repair path for a workspace without a handle', async () => {
    const noop = vi.fn();
    const startRepair = vi.fn();

    await act(async () => {
      root?.render(
        <PlatformContext.Provider value={TEST_CLOUD_PLATFORM}>
          <Provider store={createStore()}>
            <WorkspaceScreenView
              workspaces={[{ id: 'workspace-legacy', name: 'Legacy Workspace', slug: '' }]}
              workspacesStatus="ready"
              workspacesError={null}
              retryingWorkspaces={false}
              onRetryWorkspaces={noop}
              selectedWorkspaceId={null}
              creating={false}
              repairingWorkspaceName={null}
              onStartCreate={noop}
              onStartRepair={startRepair}
              onCancelCreate={noop}
              newName=""
              newSlug=""
              newSlugChecking={false}
              newSlugAvailable={false}
              newSlugCheckSlow={false}
              newSlugCheckError={null}
              newSlugError={null}
              canResetSlug={false}
              onNewNameChange={noop}
              onNewSlugChange={noop}
              onResetNewSlug={noop}
              onRetryNewSlugCheck={noop}
              saving={false}
              writePending={false}
              createError={null}
              onSelectWorkspace={noop}
              onConfirmSelection={noop}
              onSubmitCreate={noop}
              onBack={noop}
            />
          </Provider>
        </PlatformContext.Provider>
      );
    });

    expect(container.textContent).toContain('select this workspace to set one');
    await act(async () => {
      findButton(container, 'Legacy Workspace').dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      );
    });
    expect(startRepair).toHaveBeenCalledWith('workspace-legacy');
  });

  it('saves a missing handle, activates that workspace, and advances', async () => {
    const updateSlug = vi.fn(async (workspaceId: string, slug: string) => ({
      id: workspaceId,
      name: 'Legacy Workspace',
      slug,
      role: 'owner',
    }));
    const setActive = vi.fn(() => Promise.resolve());
    const onNext = vi.fn();
    const availableResult = { available: true };
    const useQuery = vi.fn(() => availableResult) as CloudApi['useQuery'];
    const platform: PlatformProvider = {
      ...TEST_CLOUD_PLATFORM,
      cloudApi: {
        ...TEST_CLOUD_PLATFORM.cloudApi!,
        useQuery,
      },
      workspaces: {
        state: createStaticStore({
          status: 'ready' as const,
          workspaces: [
            {
              id: 'workspace-legacy',
              name: 'Legacy Workspace',
              slug: null,
              role: 'owner',
            },
          ],
          activeWorkspaceId: 'workspace-legacy',
        }),
        updateSlug,
        setActive,
      },
    };

    await act(async () => {
      root?.render(
        <PlatformContext.Provider value={platform}>
          <Provider store={createStore()}>
            <WorkspaceScreen onBack={vi.fn()} onNext={onNext} />
          </Provider>
        </PlatformContext.Provider>
      );
    });
    await act(async () => {
      findButton(container, 'Legacy Workspace').dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Set a workspace handle');
    expect(findButton(container, 'Save & continue').disabled).toBe(false);

    await act(async () => {
      findButton(container, 'Save & continue').dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(updateSlug).toHaveBeenCalledWith('workspace-legacy', 'legacy-workspace');
    expect(setActive).toHaveBeenCalledWith('workspace-legacy');
    expect(onNext).toHaveBeenCalledOnce();
  });

  function encryptionAwarePlatform(
    workspace: { id: string; name: string; slug: string; contentMode?: string },
    describeMode: PlatformE2eeWorkspaces['describe'],
    setActive: () => Promise<void> = async () => {}
  ): PlatformProvider {
    return {
      ...TEST_CLOUD_PLATFORM,
      e2eeWorkspaces: {
        describe: describeMode,
        create: async () => {
          throw new Error('unused');
        },
        history: async () => {
          throw new Error('unused');
        },
      },
      workspaces: {
        state: createStaticStore({
          status: 'ready' as const,
          workspaces: [{ ...workspace, role: 'owner' }],
          activeWorkspaceId: workspace.id,
        }),
        setActive,
      },
    };
  }

  async function confirm(platform: PlatformProvider, name: string, onNext: () => void) {
    await act(async () => {
      root?.render(
        <PlatformContext.Provider value={platform}>
          <Provider store={createStore()}>
            <WorkspaceScreen onBack={vi.fn()} onNext={onNext} />
          </Provider>
        </PlatformContext.Provider>
      );
    });
    await act(async () => {
      findButton(container, name).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      findButton(container, 'Next').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('continues with the current ordinary workspace without waiting for a mode check', async () => {
    const onNext = vi.fn();
    const errorToast = vi.spyOn(toast, 'error');
    await confirm(
      encryptionAwarePlatform(
        { id: 'workspace-a', name: 'Alpha', slug: 'alpha' },
        () => Promise.reject(new Error('e2ee_workspace_mode_unavailable')),
        // An unanswered activation proves the already-active short-circuit.
        () => new Promise(() => {})
      ),
      'Alpha',
      onNext
    );
    expect(onNext).toHaveBeenCalledOnce();
    expect(errorToast).not.toHaveBeenCalled();
  });

  it('opens encrypted workspace control with hash routing without leaving the desktop document', async () => {
    vi.restoreAllMocks();
    const platform = encryptionAwarePlatform(
      { id: 'workspace-e', name: 'Vault', slug: 'vault', contentMode: 'e2ee' },
      async () => ({
        workspaceId: 'workspace-e',
        contentMode: 'e2ee',
        activation: 'control-only',
        contentModeVersion: 1,
        cryptoOrgId: 'ab'.repeat(32),
        genesisHash: 'ab'.repeat(32),
      })
    );
    platform.identity = {
      ...platform.identity,
      session: createStaticStore({ status: 'authenticated', user: { id: 'account', name: 'Ada' } }),
    };
    const onNext = vi.fn();
    const pathname = window.location.pathname;
    window.location.hash = '#/onboarding';
    const rootRoute = createRootRoute({ component: Outlet });
    const router = createRouter({
      history: createHashHistory(),
      routeTree: rootRoute.addChildren([
        createRoute({
          getParentRoute: () => rootRoute,
          path: '/onboarding',
          component: () => <WorkspaceScreen onBack={vi.fn()} onNext={onNext} />,
        }),
        createRoute({
          getParentRoute: () => rootRoute,
          path: '/workspace/e2ee/$workspaceId',
          component: () => <div>Encrypted workspace control</div>,
        }),
      ]),
    });
    await act(async () => {
      await router.load();
      root?.render(
        <PlatformContext.Provider value={platform}>
          <Provider store={createStore()}>
            <RouterProvider router={router} />
          </Provider>
        </PlatformContext.Provider>
      );
    });
    await act(async () => findButton(container, 'Vault').click());
    await act(async () => {
      findButton(container, 'Next').click();
      await Promise.resolve();
      await router.load();
    });
    expect(window.location.pathname).toBe(pathname);
    expect(window.location.hash).toBe('#/workspace/e2ee/workspace-e');
    expect(container.textContent).toContain('Encrypted workspace control');
    expect(onNext).not.toHaveBeenCalled();
    router.history.destroy();
    window.location.hash = '';
  });

  it('reports a failed mode check of an encrypted-listed workspace with the generic switch copy', async () => {
    const onNext = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const errorToast = vi.spyOn(toast, 'error');
    await confirm(
      encryptionAwarePlatform(
        { id: 'workspace-e', name: 'Vault', slug: 'vault', contentMode: 'e2ee' },
        () => Promise.reject(new Error('e2ee_workspace_mode_unavailable'))
      ),
      'Vault',
      onNext
    );
    expect(onNext).not.toHaveBeenCalled();
    expect(errorToast).toHaveBeenCalledWith('Could not switch workspace. Try again.', undefined);
    expect(findButton(container, 'Next').disabled).toBe(false);
  });
});
