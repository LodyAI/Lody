import type {
  AcceptedWiderPermission,
  AcpConfigOptionValue,
  IssuePRMention,
  McpServerId,
} from '@lody/shared';
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
  /** Differences disclosed and accepted for this turn only. */
  acceptWiderPermissions?: AcceptedWiderPermission[];
  mcpServerIdsOverride?: readonly McpServerId[];
  taskToolsEnabledOverride?: boolean;
  issuePRMentionsOverride?: IssuePRMention[];
};

export const EMPTY_TURN_SCOPED_OVERRIDES: TurnScopedOverrides = {};

const dedupeAcceptedWiderPermissions = (
  entries: readonly AcceptedWiderPermission[]
): AcceptedWiderPermission[] => {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.controlId}\u0000${entry.requestedModeId}\u0000${entry.effectiveModeId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** Narrows a wider options object to exactly the turn-scoped set. */
export const pickTurnScopedOverrides = (
  options: TurnScopedOverrides | undefined
): TurnScopedOverrides => ({
  ...(options?.acceptWiderPermissions?.length
    ? { acceptWiderPermissions: options.acceptWiderPermissions }
    : {}),
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
    'disclosed' | 'previouslyAccepted' | 'mcpServerIds' | 'taskToolsEnabled' | 'issuePRMentions'
  >
): TurnScopedOverrides => ({
  // What this notice showed, ON TOP of what the stopped turn had already been
  // accepted for. Each entry is still matched exactly by the daemon, so the set
  // grants nothing beyond the differences shown one stop at a time.
  acceptWiderPermissions: dedupeAcceptedWiderPermissions([
    ...target.previouslyAccepted,
    target.disclosed,
  ]),
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
): T & { acceptWiderPermissions?: AcceptedWiderPermission[] } => ({
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
  ...(overrides.acceptWiderPermissions?.length
    ? { acceptWiderPermissions: overrides.acceptWiderPermissions }
    : {}),
});
