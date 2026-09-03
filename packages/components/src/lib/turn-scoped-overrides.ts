import type { AcpConfigOptionValue, IssuePRMention, McpServerId } from '@lody/shared';
import type { PermissionNotAppliedRetryTarget } from '@/lib/permission-not-applied-retry';

/**
 * The fields a REPLAYED turn carries that the composer must not supply.
 *
 * A send has several routes — direct dispatch, queue, guide — and each one
 * rebuilds the turn's input config from the composer's current state. That is
 * right for an ordinary send and wrong for a replay: the composer holds what
 * the user has since selected, not what the stopped turn ran with. These travel
 * together as one object so a route either forwards the whole set or fails to
 * compile, rather than forwarding three of four and losing the acceptance that
 * made the replay possible at all.
 *
 * `undefined` means "use the composer's value"; a PRESENT value wins, including
 * an empty `mcpServerIds` array, which is an explicit "no servers" selection.
 */
export type TurnScopedOverrides = {
  /** One-time informed acceptance of a wider permission, for this turn only. */
  acceptWiderPermission?: boolean;
  mcpServerIdsOverride?: readonly McpServerId[];
  taskToolsEnabledOverride?: boolean;
  issuePRMentionsOverride?: IssuePRMention[];
};

export const EMPTY_TURN_SCOPED_OVERRIDES: TurnScopedOverrides = {};

/** Narrows a wider options object to exactly the turn-scoped set. */
export const pickTurnScopedOverrides = (
  options: TurnScopedOverrides | undefined
): TurnScopedOverrides => ({
  ...(options?.acceptWiderPermission === true ? { acceptWiderPermission: true } : {}),
  ...(options?.mcpServerIdsOverride !== undefined
    ? { mcpServerIdsOverride: options.mcpServerIdsOverride }
    : {}),
  ...(options?.taskToolsEnabledOverride !== undefined
    ? { taskToolsEnabledOverride: options.taskToolsEnabledOverride }
    : {}),
  ...(options?.issuePRMentionsOverride !== undefined
    ? { issuePRMentionsOverride: options.issuePRMentionsOverride }
    : {}),
});

/** What the stopped turn ran with, as dispatch overrides. */
export const buildPermissionRetryOverrides = (
  target: Pick<
    PermissionNotAppliedRetryTarget,
    'mcpServerIds' | 'taskToolsEnabled' | 'issuePRMentions'
  >
): TurnScopedOverrides => ({
  acceptWiderPermission: true,
  ...(target.mcpServerIds !== undefined
    ? { mcpServerIdsOverride: target.mcpServerIds as McpServerId[] }
    : {}),
  ...(target.taskToolsEnabled !== undefined
    ? { taskToolsEnabledOverride: target.taskToolsEnabled }
    : {}),
  ...(target.issuePRMentions !== undefined
    ? { issuePRMentionsOverride: target.issuePRMentions as IssuePRMention[] }
    : {}),
});

type TurnInputConfigFields = {
  mcpServerIds?: readonly McpServerId[] | null;
  taskToolsEnabled?: boolean;
  issuePRMentions?: IssuePRMention[];
  configOptionValues?: Record<string, AcpConfigOptionValue> | null;
};

/**
 * The last hop: applies the overrides over whatever the composer produced, just
 * before `buildSessionTurnInputConfig`. Every send route goes through here, so
 * a replay reaches the wire with the turn's own values.
 */
export const applyTurnScopedOverrides = <T extends TurnInputConfigFields>(
  args: T,
  overrides: TurnScopedOverrides
): T & { acceptWiderPermission?: boolean } => ({
  ...args,
  ...(overrides.mcpServerIdsOverride !== undefined
    ? { mcpServerIds: overrides.mcpServerIdsOverride }
    : {}),
  ...(overrides.taskToolsEnabledOverride !== undefined
    ? { taskToolsEnabled: overrides.taskToolsEnabledOverride }
    : {}),
  ...(overrides.issuePRMentionsOverride !== undefined
    ? { issuePRMentions: overrides.issuePRMentionsOverride }
    : {}),
  ...(overrides.acceptWiderPermission === true ? { acceptWiderPermission: true } : {}),
});
