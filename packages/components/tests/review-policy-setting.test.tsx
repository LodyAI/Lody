// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACP_CAPABILITY_CACHE_VERSION,
  CURSOR_PARAMETERIZED_MODEL_PICKER_SOURCE_VERSION_SUFFIX,
  DEFAULT_REVIEW_POLICY,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineId,
  type MachineReviewerConfig,
  type MachineViewMeta,
  type WorkspaceId,
} from '@lody/shared';
import type { WorkspaceRuntime } from '../src/atoms/runtime';
import { runtimeAtom } from '../src/atoms/runtime';
import {
  experimentalFeaturesEnabledAtom,
  reviewAgentExperimentEnabledAtom,
} from '../src/atoms/settings';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '../src/atoms/workspace-context';
import {
  ReviewerMachineConfigTable,
  ReviewPolicySection,
} from '../src/components/settings/review-policy-setting';
import { initI18n } from '../src/i18n';

Element.prototype.scrollIntoView = () => undefined;

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

describe('ReviewerMachineConfigTable model change', () => {
  let container: HTMLDivElement;
  let root: Root;

  const machineId = 'machine-reviewer' as MachineId;
  const agentConfigId = 'config-cursor' as AgentConfigId;

  const cursorThinkingOption = {
    id: 'thinking',
    name: 'Thinking',
    category: 'thought_level',
    type: 'select' as const,
    currentValue: 'false',
    options: [
      { value: 'false', name: 'False' },
      { value: 'true', name: 'True' },
    ],
  };
  const cursorReasoningOption = {
    id: 'reasoning',
    name: 'Reasoning',
    category: 'thought_level',
    type: 'select' as const,
    currentValue: 'low',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  };
  const cursorModelOption = {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select' as const,
    currentValue: 'a',
    options: [
      { value: 'a', name: 'A' },
      { value: 'b', name: 'B' },
    ],
  };

  const machine = {
    id: machineId,
    name: 'Dev machine',
    cliVersion: '1.0.0',
    os: 'darwin',
    sessions: [],
    raceLimits: {},
    acpCapabilities: {
      [agentConfigId]: {
        cliType: 'registry',
        agentType: 'cursor',
        cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
        provenance: 'runtime',
        sourceVersion: `cursor@2026.08.31${CURSOR_PARAMETERIZED_MODEL_PICKER_SOURCE_VERSION_SUFFIX}`,
        modes: [],
        models: [],
        configOptions: [cursorModelOption, cursorThinkingOption],
        configOptionsByModel: {
          a: [cursorThinkingOption],
          b: [cursorReasoningOption],
        },
        fetchedAt: 1,
      },
    },
  } as MachineViewMeta;

  const agentConfig: AgentConfigMeta = {
    id: agentConfigId,
    machineId,
    name: 'Cursor',
    description: undefined,
    cliType: 'registry',
    agentType: 'cursor',
    env: {},
  };

  const reviewerConfig: MachineReviewerConfig = {
    machineId,
    reviewer: {
      agentConfigId,
      agentType: 'cursor',
      configOptionValues: { model: 'a', thinking: 'true' },
    },
    updatedAt: 1,
  };

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('drops a previous model key when the reviewer model option changes', async () => {
    const onChange = vi.fn();
    const store = createStore();

    await act(async () => {
      root.render(
        <Provider store={store}>
          <ReviewerMachineConfigTable
            machines={[machine]}
            agentConfigs={[agentConfig]}
            reviewerConfigs={new Map([[machineId, reviewerConfig]])}
            onlineMachineIds={new Set()}
            onChange={onChange}
            onDelete={() => undefined}
            onOpenAgentSettings={() => undefined}
          />
        </Provider>
      );
    });

    await act(async () => {
      container
        .querySelector('button[aria-label="Run configuration"]')
        ?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    const modelRow = [...document.querySelectorAll('[role="menuitem"]')].find((node) =>
      node.textContent?.trim().startsWith('Model')
    );
    expect(modelRow).toBeTruthy();
    await act(async () => {
      (modelRow as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const modelB = [...document.querySelectorAll('[role="menuitemradio"]')].find(
      (node) => node.textContent?.trim() === 'B'
    );
    expect(modelB).toBeTruthy();
    await act(async () => {
      (modelB as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        machineId,
        reviewer: expect.objectContaining({
          agentConfigId,
          agentType: 'cursor',
          configOptionValues: { model: 'b' },
        }),
      })
    );
  });
});
