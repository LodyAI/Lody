// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import {
  createStaticStore,
  LOCAL_PLATFORM_CAPABILITIES,
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
              onStartCreate={noop}
              onCancelCreate={noop}
              newName="Loro Lab"
              newSlug="loro-lab"
              newSlugChecking
              newSlugCheckSlow
              newSlugError={null}
              canResetSlug={false}
              onNewNameChange={noop}
              onNewSlugChange={noop}
              onResetNewSlug={noop}
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
  });
});
