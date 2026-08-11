import { ACP_PLAN_PERMISSION_MODE_ID, type MessageContent } from '@lody/shared';

import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';

type ToolCallContent = Extract<MessageContent, { type: 'tool_call' }>;
type PermissionOption = NonNullable<ToolCallContent['permissionRequest']>['options'][number];

/**
 * Leaving plan mode is a permission request carrying ACP tool kind
 * `switch_mode` (Claude's `ExitPlanMode`, Codex's plan review). Approving it
 * switches the mode of the RUNNING turn only, so the composer selector would
 * still say Plan and the next message the user sends would quietly plan again.
 *
 * Matched on kind, not title: the adapters word the same event differently.
 */
const PLAN_EXIT_TOOL_KIND = 'switch_mode';

/**
 * Did this permission click approve leaving plan mode?
 *
 * Evaluated at the CLICK, deliberately not derived from the resolved outcome in
 * history: the selector is per-device local state, so reading history would let
 * a teammate's approval — or an old approval replaying as the doc syncs — drop
 * plan mode out from under someone who just armed it.
 */
export function isPlanExitApproval(
  toolCall: Pick<ToolCallContent, 'kind'>,
  options: readonly PermissionOption[],
  selectedOptionId: string
): boolean {
  if (toolCall.kind !== PLAN_EXIT_TOOL_KIND) {
    return false;
  }
  const selected = options.find((option) => option.optionId === selectedOptionId);
  return selected?.kind?.startsWith('allow') === true;
}

/**
 * Mode to fall back to when plan mode ends. The agent's own default wins;
 * otherwise the first non-plan mode it advertises.
 *
 * Deliberately NOT derived from which "Yes" the user picked: mapping
 * `allow_always` to `acceptEdits` would hand every LATER turn auto-accept off a
 * decision that was made about this plan only. Exiting to the default mode can
 * only ask for more approvals, never fewer.
 */
export function resolveModeIdAfterPlanExit(
  modeOptions: readonly AcpSessionSelectOption[],
  defaultModeId: string | null
): string | null {
  if (defaultModeId && defaultModeId !== ACP_PLAN_PERMISSION_MODE_ID) {
    return defaultModeId;
  }
  return modeOptions.find((option) => option.value !== ACP_PLAN_PERMISSION_MODE_ID)?.value ?? null;
}
