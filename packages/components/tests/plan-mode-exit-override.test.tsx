// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider, type Store } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACP_COLLABORATION_MODE_CONFIG_ID,
  ACP_COLLABORATION_MODE_DEFAULT_VALUE,
  ACP_COLLABORATION_MODE_PLAN_VALUE,
  ACP_PLAN_PERMISSION_MODE_ID,
  type AcpConfigOptionValue,
  type SessionId,
} from '@lody/shared';

import {
  createPlanModeExitApprovalState,
  hasPendingPlanModeExitApproval,
  planModeExitApprovalStateAtomFamily,
  raisePlanModeExitApproval,
} from '../src/atoms/plan-mode-exit';
import type { AcpSessionSelectOption } from '../src/components/shared/acp-session-select';
import {
  usePlanModeExitOverride,
  type PlanModeExitOverrideController,
} from '../src/hooks/use-plan-mode-exit-approval';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION_ID = 'session-plan-exit' as SessionId;
const approvalAtom = planModeExitApprovalStateAtomFamily(SESSION_ID);
const EMPTY_CONFIG: Record<string, AcpConfigOptionValue> = {};
const MODE_OPTIONS: AcpSessionSelectOption[] = [
  { value: 'default', label: 'Default' },
  { value: ACP_PLAN_PERMISSION_MODE_ID, label: 'Plan' },
];

type ProbeProps = {
  enabled?: boolean;
  selectionReady?: boolean;
  selectedModeId?: string | null;
  modeOptions?: AcpSessionSelectOption[];
  defaultModeId?: string | null;
  configOptionValues?: Record<string, AcpConfigOptionValue>;
};

let container: HTMLDivElement;
let root: Root;
let store: Store;
let controller: PlanModeExitOverrideController | null;
let onModeChange: ReturnType<typeof vi.fn<(modeId: string) => void>>;
let onConfigOptionChange: ReturnType<
  typeof vi.fn<(configId: string, value: AcpConfigOptionValue) => void>
>;

function Probe({
  enabled = true,
  selectionReady = true,
  selectedModeId = null,
  modeOptions = MODE_OPTIONS,
  defaultModeId = 'default',
  configOptionValues = EMPTY_CONFIG,
}: ProbeProps) {
  controller = usePlanModeExitOverride({
    enabled,
    selectionReady,
    sessionId: SESSION_ID,
    selectedModeId,
    modeOptions,
    defaultModeId,
    configOptionValues,
    onModeChange,
    onConfigOptionChange,
  });
  return null;
}

function renderProbe(props: ProbeProps): void {
  act(() => {
    root.render(
      <Provider store={store}>
        <Probe {...props} />
      </Provider>
    );
  });
}

function unmountProbe(): void {
  act(() => {
    root.render(<Provider store={store}>{null}</Provider>);
  });
  controller = null;
}

function getController(): PlanModeExitOverrideController {
  if (!controller) throw new Error('Plan mode exit controller is not mounted');
  return controller;
}

function setPendingApproval(): void {
  store.set(approvalAtom, raisePlanModeExitApproval(createPlanModeExitApprovalState()));
}

function expectPendingApproval(expected: boolean): void {
  expect(hasPendingPlanModeExitApproval(store.get(approvalAtom))).toBe(expected);
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  store = createStore();
  controller = null;
  onModeChange = vi.fn();
  onConfigOptionChange = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('usePlanModeExitOverride', () => {
  it('reapplies the Codex Default override after the composer remounts', () => {
    setPendingApproval();
    const durablePlan = {
      [ACP_COLLABORATION_MODE_CONFIG_ID]: ACP_COLLABORATION_MODE_PLAN_VALUE,
    };

    renderProbe({ configOptionValues: durablePlan });
    expect(onConfigOptionChange).toHaveBeenLastCalledWith(
      ACP_COLLABORATION_MODE_CONFIG_ID,
      ACP_COLLABORATION_MODE_DEFAULT_VALUE
    );
    expectPendingApproval(true);

    unmountProbe();
    renderProbe({ configOptionValues: durablePlan });
    expect(onConfigOptionChange).toHaveBeenCalledTimes(2);
    expectPendingApproval(true);
  });

  it('reapplies the mode-based Default override after the composer remounts', () => {
    setPendingApproval();

    renderProbe({ selectedModeId: ACP_PLAN_PERMISSION_MODE_ID });
    expect(onModeChange).toHaveBeenLastCalledWith('default');
    expectPendingApproval(true);

    unmountProbe();
    renderProbe({ selectedModeId: ACP_PLAN_PERMISSION_MODE_ID });
    expect(onModeChange).toHaveBeenCalledTimes(2);
    expectPendingApproval(true);
  });

  it('consumes the override only after a non-Plan turn is accepted', () => {
    setPendingApproval();
    renderProbe({ configOptionValues: { [ACP_COLLABORATION_MODE_CONFIG_ID]: 'default' } });

    act(() => {
      getController().acknowledgeAcceptedTurn({
        modeId: null,
        configOptionValues: {
          [ACP_COLLABORATION_MODE_CONFIG_ID]: ACP_COLLABORATION_MODE_DEFAULT_VALUE,
        },
      });
    });
    expectPendingApproval(false);

    unmountProbe();
    renderProbe({
      configOptionValues: {
        [ACP_COLLABORATION_MODE_CONFIG_ID]: ACP_COLLABORATION_MODE_PLAN_VALUE,
      },
    });
    expect(onConfigOptionChange).not.toHaveBeenCalled();
  });

  it('retains the override when the accepted turn still uses Plan', () => {
    setPendingApproval();
    renderProbe({});

    act(() => {
      getController().acknowledgeAcceptedTurn({
        modeId: ACP_PLAN_PERMISSION_MODE_ID,
        configOptionValues: EMPTY_CONFIG,
      });
      getController().acknowledgeAcceptedTurn({
        modeId: null,
        configOptionValues: {
          [ACP_COLLABORATION_MODE_CONFIG_ID]: ACP_COLLABORATION_MODE_PLAN_VALUE,
        },
      });
    });

    expectPendingApproval(true);
  });

  it('does not let a header-only instance consume the override', () => {
    setPendingApproval();
    renderProbe({ enabled: false });

    act(() => {
      getController().onUserModeChange(ACP_PLAN_PERMISSION_MODE_ID);
      getController().onUserConfigOptionChange(
        ACP_COLLABORATION_MODE_CONFIG_ID,
        ACP_COLLABORATION_MODE_PLAN_VALUE
      );
      getController().acknowledgeAcceptedTurn({
        modeId: null,
        configOptionValues: EMPTY_CONFIG,
      });
    });

    expectPendingApproval(true);
  });

  it('preserves approvals raised after an accepted turn started', () => {
    setPendingApproval();
    renderProbe({});
    const acknowledgeFirstApproval = getController().acknowledgeAcceptedTurn;

    act(() => {
      store.set(approvalAtom, raisePlanModeExitApproval);
    });
    act(() => {
      acknowledgeFirstApproval({ modeId: null, configOptionValues: EMPTY_CONFIG });
    });

    const state = store.get(approvalAtom);
    expect(state).toEqual({ latestRevision: 2, consumedRevision: 1 });
    expectPendingApproval(true);
  });

  it('does not let an in-flight turn consume an approval raised after a re-arm', () => {
    setPendingApproval();
    renderProbe({});
    const acknowledgeOldTurn = getController().acknowledgeAcceptedTurn;

    act(() => getController().onUserModeChange(ACP_PLAN_PERMISSION_MODE_ID));
    act(() => {
      store.set(approvalAtom, raisePlanModeExitApproval);
    });
    act(() => acknowledgeOldTurn({ modeId: null, configOptionValues: EMPTY_CONFIG }));

    expect(store.get(approvalAtom)).toEqual({ latestRevision: 2, consumedRevision: 1 });
    expectPendingApproval(true);
  });

  it('lets an explicit Codex Plan re-arm win over the retained override', () => {
    setPendingApproval();
    renderProbe({});

    act(() => {
      getController().onUserConfigOptionChange(
        ACP_COLLABORATION_MODE_CONFIG_ID,
        ACP_COLLABORATION_MODE_PLAN_VALUE
      );
    });
    expectPendingApproval(false);
    expect(onConfigOptionChange).toHaveBeenLastCalledWith(
      ACP_COLLABORATION_MODE_CONFIG_ID,
      ACP_COLLABORATION_MODE_PLAN_VALUE
    );

    unmountProbe();
    renderProbe({
      configOptionValues: {
        [ACP_COLLABORATION_MODE_CONFIG_ID]: ACP_COLLABORATION_MODE_PLAN_VALUE,
      },
    });
    expect(onConfigOptionChange).toHaveBeenCalledTimes(1);
  });

  it('lets an explicit mode-based Plan re-arm win over the retained override', () => {
    setPendingApproval();
    renderProbe({});

    act(() => getController().onUserModeChange(ACP_PLAN_PERMISSION_MODE_ID));
    expectPendingApproval(false);
    expect(onModeChange).toHaveBeenLastCalledWith(ACP_PLAN_PERMISSION_MODE_ID);

    unmountProbe();
    renderProbe({ selectedModeId: ACP_PLAN_PERMISSION_MODE_ID });
    expect(onModeChange).toHaveBeenCalledTimes(1);
  });

  it('waits for a non-Plan fallback and for the owning composer to be ready', () => {
    setPendingApproval();
    renderProbe({
      selectionReady: false,
      selectedModeId: ACP_PLAN_PERMISSION_MODE_ID,
    });
    expect(onModeChange).not.toHaveBeenCalled();

    renderProbe({
      selectedModeId: ACP_PLAN_PERMISSION_MODE_ID,
      modeOptions: [{ value: ACP_PLAN_PERMISSION_MODE_ID, label: 'Plan' }],
      defaultModeId: ACP_PLAN_PERMISSION_MODE_ID,
    });
    expect(onModeChange).not.toHaveBeenCalled();
    expectPendingApproval(true);
  });
});
