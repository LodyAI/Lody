import type * as acp from '@agentclientprotocol/sdk';
import type { LodyGoalCapability } from 'acp-extension-core';
import type { SessionGoalAction } from '@lody/shared';

/**
 * How a goal action can reach the agent.
 *
 * - `request`: `_lody/session/goal`, deliverable while a prompt is in flight.
 * - `promptMeta`: a prompt carrying `_meta.lody.goalControl`, so the action runs
 *   inside a turn Lody owns without putting command text in the conversation.
 * - `slashCommand`: the `/goal …` bridge, for runtimes that predate the split.
 */
export type GoalActionTransport = 'request' | 'promptMeta' | 'slashCommand';

export type GoalPromptControl = {
  action: SessionGoalAction;
  objective?: string;
};

/**
 * Pick the transport for one action.
 *
 * The out-of-band request wins whenever the agent advertises it, because it is
 * the only transport that does not need a turn — and a goal's own prompt can
 * hold the session's single prompt slot for hours. Everything else runs inside
 * a prompt so the turns it starts belong to a conversation entry. Inside an
 * already-owned prompt (including cold restore), select only a prompt transport.
 */
export function resolveGoalActionTransport(
  capability: LodyGoalCapability | undefined,
  action: SessionGoalAction,
  context: 'control' | 'prompt' = 'control'
): GoalActionTransport | null {
  if (!capability?.actions.includes(action)) {
    return null;
  }
  if (
    context === 'control' &&
    capability.controlActions?.includes(action) &&
    (action === 'pause' || action === 'clear')
  ) {
    return 'request';
  }
  if (capability.promptActions?.includes(action)) {
    return 'promptMeta';
  }
  // A runtime that advertises neither list predates the split and only
  // understands the slash bridge.
  return capability.controlActions || capability.promptActions ? null : 'slashCommand';
}

export function buildGoalPromptMeta(control: GoalPromptControl): acp.PromptRequest['_meta'] {
  return {
    lody: {
      goalControl: {
        version: 1,
        action: control.action,
        ...(control.action === 'set' ? { objective: control.objective ?? '' } : {}),
      },
    },
  };
}

/** The `/goal …` text a legacy runtime needs in place of prompt metadata. */
export function buildGoalSlashCommandText(control: GoalPromptControl): string {
  return control.action === 'set'
    ? `/goal ${(control.objective ?? '').trim()}`
    : `/goal ${control.action}`;
}
