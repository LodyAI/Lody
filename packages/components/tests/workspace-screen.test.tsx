// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import {
  createStaticStore,
  LOCAL_PLATFORM_CAPABILITIES,
  type CloudApi,
  type PlatformProvider,
} from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WorkspaceScreen,
  WorkspaceScreenView,
} from '../src/components/onboarding/screens/workspace-screen';
import { initI18n } from '../src/i18n';
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
});
