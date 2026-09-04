// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REVIEW_POLICY, type WorkspaceId } from '@lody/shared';
import type { WorkspaceRuntime } from '../src/atoms/runtime';
import { runtimeAtom } from '../src/atoms/runtime';
import {
  experimentalFeaturesEnabledAtom,
  reviewAgentExperimentEnabledAtom,
} from '../src/atoms/settings';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '../src/atoms/workspace-context';
import { ReviewPolicySection } from '../src/components/settings/review-policy-setting';
import { initI18n } from '../src/i18n';

const reviewPolicyMocks = vi.hoisted(() => ({
  read: vi.fn(),
  list: vi.fn(),
  write: vi.fn(),
}));

vi.mock('../src/atoms/review-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/atoms/review-policy')>()),
  readReviewPolicyFromFlock: reviewPolicyMocks.read,
  listMachineReviewerConfigsFromFlock: reviewPolicyMocks.list,
  writeReviewPolicyToFlock: reviewPolicyMocks.write,
}));

vi.mock('../src/hooks/use-mobile', () => ({ useIsMobile: () => true }));
vi.mock('../src/hooks/use-machine-online-status', () => ({
  useOnlineMachineIds: () => new Set(),
}));
vi.mock('../src/hooks/use-machine-flock-agent-configs', () => ({
  useMachineFlockAgentConfigsForMachineIds: () => undefined,
}));
vi.mock('../src/hooks/use-open-settings', () => ({
  useOpenSettings: () => ({ openSettings: vi.fn() }),
}));
vi.mock('../src/hooks/use-visible-machine-metas', () => ({
  useVisibleMachineMetas: () => ({ machines: new Map(), isLoading: false }),
}));

describe('ReviewPolicySection persistence', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    vi.useFakeTimers();
    reviewPolicyMocks.read.mockResolvedValue(DEFAULT_REVIEW_POLICY);
    reviewPolicyMocks.list.mockResolvedValue(new Map());
    reviewPolicyMocks.write.mockResolvedValue(undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('flushes the latest debounced policy when its surface unmounts', async () => {
    const workspaceId = 'workspace-review-policy-test' as WorkspaceId;
    const runtime = {
      workspaceId,
      workspaceSlug: 'review-policy-test',
      repo: {
        openFlockDoc: vi.fn(async () => ({
          flock: { subscribe: () => () => undefined },
          joinRoom: async () => ({
            unsubscribe: () => undefined,
            firstSyncedWithRemote: Promise.resolve(),
          }),
        })),
      },
    } as unknown as WorkspaceRuntime;
    const store = createStore();
    store.set(experimentalFeaturesEnabledAtom, true);
    store.set(reviewAgentExperimentEnabledAtom, true);
    store.set(currentWorkspaceSlugAtom, runtime.workspaceSlug);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(runtimeAtom, runtime);

    await act(async () => {
      root.render(
        <Provider store={store}>
          <ReviewPolicySection />
        </Provider>
      );
    });

    const requirements = container.querySelector('textarea');
    expect(requirements).not.toBeNull();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setValue?.call(requirements, 'Require regression tests.');
      requirements?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(reviewPolicyMocks.write).not.toHaveBeenCalled();
    act(() => root.unmount());

    expect(reviewPolicyMocks.write).toHaveBeenCalledOnce();
    expect(reviewPolicyMocks.write).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({ requirements: 'Require regression tests.' })
    );
  });
});
