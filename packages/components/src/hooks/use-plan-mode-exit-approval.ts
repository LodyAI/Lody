import { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import type { MessageContent, SessionId } from '@lody/shared';

import { planModeExitApprovalCountAtomFamily } from '@/atoms/plan-mode-exit';
import { isPlanExitApproval } from '@/lib/plan-mode-exit';

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
