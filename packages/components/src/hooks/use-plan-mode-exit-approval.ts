import { useCallback, useEffect } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import {
  ACP_COLLABORATION_MODE_CONFIG_ID,
  ACP_COLLABORATION_MODE_DEFAULT_VALUE,
  ACP_COLLABORATION_MODE_PLAN_VALUE,
  ACP_PLAN_PERMISSION_MODE_ID,
  type AcpConfigOptionValue,
  type MessageContent,
  type SessionId,
} from '@lody/shared';

import {
  consumePlanModeExitApprovalsThrough,
  hasPendingPlanModeExitApproval,
  planModeExitApprovalStateAtomFamily,
  raisePlanModeExitApproval,
} from '@/atoms/plan-mode-exit';
import { isPlanExitApproval, resolveModeIdAfterPlanExit } from '@/lib/plan-mode-exit';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';

type ToolCallContent = Extract<MessageContent, { type: 'tool_call' }>;
type PermissionOption = NonNullable<ToolCallContent['permissionRequest']>['options'][number];

/**
 * Call after a permission answer is written. When the answer approved leaving
 * plan mode, the session view drops plan mode from its composer selector —
 * otherwise the mode switch would apply to the running turn only and the next
 * message would silently plan again.
 *
 * Every interactive permission surface must call this; there is more than one
 * (the floating card and the inline card inside the transcript).
 */
export function usePlanModeExitApprovalNotifier(sessionId: SessionId) {
  const raiseApproval = useSetAtom(planModeExitApprovalStateAtomFamily(sessionId));

  return useCallback(
    (
      toolCall: Pick<ToolCallContent, 'kind'>,
      options: readonly PermissionOption[],
      selectedOptionId: string
    ) => {
      if (!isPlanExitApproval(toolCall, options, selectedOptionId)) {
        return;
      }
      raiseApproval(raisePlanModeExitApproval);
    },
    [raiseApproval]
  );
}

type PlanModeExitOverrideOptions = {
  enabled: boolean;
  selectionReady: boolean;
  sessionId: SessionId;
  selectedModeId: string | null;
  modeOptions: readonly AcpSessionSelectOption[];
  defaultModeId: string | null;
  configOptionValues: Readonly<Record<string, AcpConfigOptionValue>>;
  onModeChange: (modeId: string) => void;
  onConfigOptionChange: (configId: string, value: AcpConfigOptionValue) => void;
};

type AcceptedTurnSelection = {
  modeId: string | null;
  configOptionValues: Readonly<Record<string, AcpConfigOptionValue>>;
};

export type PlanModeExitOverrideController = {
  onUserModeChange: (modeId: string) => void;
  onUserConfigOptionChange: (configId: string, value: AcpConfigOptionValue) => void;
  acknowledgeAcceptedTurn: (selection: AcceptedTurnSelection) => void;
};

/**
 * Keep successful plan-exit approvals active in the composer that owns the
 * local run-config selection. Codex carries Plan in `collaboration_mode`;
 * Claude carries it in the ACP permission mode. Both are local per-turn
 * preferences, so the adapter changing the running turn does not update the
 * next send and a composer remount can otherwise restore the last durable Plan
 * turn.
 */
export function usePlanModeExitOverride({
  enabled,
  selectionReady,
  sessionId,
  selectedModeId,
  modeOptions,
  defaultModeId,
  configOptionValues,
  onModeChange,
  onConfigOptionChange,
}: PlanModeExitOverrideOptions): PlanModeExitOverrideController {
  const [approvalState, setApprovalState] = useAtom(planModeExitApprovalStateAtomFamily(sessionId));
  const approvalPending = hasPendingPlanModeExitApproval(approvalState);
  const observedApprovalRevision = approvalState.latestRevision;

  const onUserModeChange = useCallback(
    (modeId: string) => {
      if (enabled && modeId === ACP_PLAN_PERMISSION_MODE_ID) {
        // A newer explicit user choice wins over the retained exit approval.
        setApprovalState((current) =>
          consumePlanModeExitApprovalsThrough(current, current.latestRevision)
        );
      }
      onModeChange(modeId);
    },
    [enabled, onModeChange, setApprovalState]
  );

  const onUserConfigOptionChange = useCallback(
    (configId: string, value: AcpConfigOptionValue) => {
      if (
        enabled &&
        configId === ACP_COLLABORATION_MODE_CONFIG_ID &&
        value === ACP_COLLABORATION_MODE_PLAN_VALUE
      ) {
        // Clear before selecting Plan so the override effect cannot undo the
        // user's re-arm on the following render.
        setApprovalState((current) =>
          consumePlanModeExitApprovalsThrough(current, current.latestRevision)
        );
      }
      onConfigOptionChange(configId, value);
    },
    [enabled, onConfigOptionChange, setApprovalState]
  );

  const acknowledgeAcceptedTurn = useCallback(
    ({ modeId, configOptionValues: acceptedConfigOptionValues }: AcceptedTurnSelection) => {
      if (
        !enabled ||
        !approvalPending ||
        modeId === ACP_PLAN_PERMISSION_MODE_ID ||
        acceptedConfigOptionValues[ACP_COLLABORATION_MODE_CONFIG_ID] ===
          ACP_COLLABORATION_MODE_PLAN_VALUE
      ) {
        return;
      }

      // The accepted non-Plan turn now carries the preference durably. Consume
      // only the approvals observed when this dispatch started so a newer
      // approval raised while it was in flight remains pending.
      setApprovalState((current) =>
        consumePlanModeExitApprovalsThrough(current, observedApprovalRevision)
      );
    },
    [approvalPending, enabled, observedApprovalRevision, setApprovalState]
  );

  useEffect(() => {
    if (!enabled || !selectionReady || !approvalPending) {
      return;
    }

    const codexPlanActive =
      configOptionValues[ACP_COLLABORATION_MODE_CONFIG_ID] === ACP_COLLABORATION_MODE_PLAN_VALUE;
    let nextModeId: string | null = null;
    if (selectedModeId === ACP_PLAN_PERMISSION_MODE_ID) {
      nextModeId = resolveModeIdAfterPlanExit(modeOptions, defaultModeId);
      if (!nextModeId) {
        // Capabilities can arrive after the durable turn selection. Keep the
        // approval pending until a non-Plan destination is actually available.
        return;
      }
    }

    if (codexPlanActive) {
      onConfigOptionChange(ACP_COLLABORATION_MODE_CONFIG_ID, ACP_COLLABORATION_MODE_DEFAULT_VALUE);
    }
    if (nextModeId) {
      onModeChange(nextModeId);
    }

    // Deliberately keep the approval pending after the selector becomes
    // non-Plan. The latest durable user turn can still say Plan, so a composer
    // remount must be able to apply the same override again. The accepted-turn
    // callback above owns consumption.
  }, [
    configOptionValues,
    defaultModeId,
    enabled,
    modeOptions,
    onConfigOptionChange,
    onModeChange,
    approvalPending,
    selectionReady,
    selectedModeId,
  ]);

  return { onUserModeChange, onUserConfigOptionChange, acknowledgeAcceptedTurn };
}
