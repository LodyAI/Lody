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
  consumeObservedPlanModeExitApprovals,
  planModeExitApprovalCountAtomFamily,
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
  const bumpApprovalCount = useSetAtom(planModeExitApprovalCountAtomFamily(sessionId));

  return useCallback(
    (
      toolCall: Pick<ToolCallContent, 'kind'>,
      options: readonly PermissionOption[],
      selectedOptionId: string
    ) => {
      if (!isPlanExitApproval(toolCall, options, selectedOptionId)) {
        return;
      }
      bumpApprovalCount((count) => count + 1);
    },
    [bumpApprovalCount]
  );
}

type PlanModeExitApprovalConsumerOptions = {
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

/**
 * Consume successful plan-exit approvals in the composer that owns the local
 * run-config selection. Codex carries Plan in `collaboration_mode`; Claude
 * carries it in the ACP permission mode. Both are local per-turn preferences,
 * so the adapter changing the running turn does not update the next send.
 */
export function useConsumePlanModeExitApproval({
  enabled,
  selectionReady,
  sessionId,
  selectedModeId,
  modeOptions,
  defaultModeId,
  configOptionValues,
  onModeChange,
  onConfigOptionChange,
}: PlanModeExitApprovalConsumerOptions): void {
  const [pendingApprovalCount, setPendingApprovalCount] = useAtom(
    planModeExitApprovalCountAtomFamily(sessionId)
  );

  useEffect(() => {
    if (!enabled || !selectionReady || pendingApprovalCount === 0) {
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

    if (codexPlanActive || nextModeId) {
      // Observe the reconciled non-Plan selection on the next render before
      // consuming. If either callback is a no-op, the approval stays pending.
      return;
    }

    // Consume exactly the revision this effect observed. If another approval
    // arrives while the handlers above run, its increment remains pending.
    setPendingApprovalCount((current) =>
      consumeObservedPlanModeExitApprovals(current, pendingApprovalCount)
    );
  }, [
    configOptionValues,
    defaultModeId,
    enabled,
    modeOptions,
    onConfigOptionChange,
    onModeChange,
    pendingApprovalCount,
    selectionReady,
    selectedModeId,
    setPendingApprovalCount,
  ]);
}
