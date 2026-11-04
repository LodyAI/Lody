import type { AgentConfigId } from '@lody/shared';
import {
  getAgentRateLimitWindows,
  resolveAgentRateLimitForModel,
  type AgentRateLimitWindow,
  type MachineRateLimits,
} from './session-usage';

/**
 * A subscription plan bills two segments: the short one (5 hours on Claude and Codex) and the
 * week. Both resets matter — the short one says when the throttle lifts, the week's says when the
 * plan comes back — so the page keeps both, and a third would only repeat the tile.
 */
const HOME_WEEK_USAGE_WINDOWS = 2;

/** A Codex reset the forecast knows about, already worded and timed for display. */
export type HomeWeekForecast = {
  /** "Reset forecast" or "Reset scheduled". */
  title: string;
  /** Whole percent; null for a scheduled reset, which has no probability. */
  chancePercent: number | null;
  /** When it is expected, in the viewer's time zone. */
  when: string;
};

/** Whose plan: one provider configuration on the selected machine. */
export type HomeWeekUsageSource = {
  /** The agent configuration's id. */
  id: string;
  cliType: string;
  agentType: string;
  /** The configuration's own name, as the composer's agent picker shows it. */
  name: string;
};

/** One provider the page can show the plan usage of. */
export type HomeWeekUsageOption = {
  source: HomeWeekUsageSource;
  usage: HomeWeekUsage;
  /** A first-party Codex provider, so the third-party reset forecast applies to it. */
  codexForecast: boolean;
};

export type HomeWeekUsage = {
  /** The tier the provider named (a model-specific limit), when it named one. */
  name: string | null;
  /** The window the tile meters: the shortest, the one that resets next. */
  window: AgentRateLimitWindow;
  /** The plan's other window (the week behind the 5-hour segment), for when it comes back. */
  otherWindow: AgentRateLimitWindow | null;
};

/**
 * The subscription windows of the provider the composer has selected: the same entry, found
 * the same way, that the composer's usage popover reads from the machine's rate limits. Local
 * data only. Null when the provider reported no window, so the page shows nothing rather than
 * an empty meter.
 *
 * The two segments keep their own reset times: a plan's 5-hour segment and its week come back at
 * different moments, so merging them into the one that resets next hid when the week itself does.
 */
export function buildHomeWeekUsage(args: {
  rateLimits: MachineRateLimits | null | undefined;
  agentType: string;
  agentConfigId?: AgentConfigId | null;
  modelId?: string | null;
}): HomeWeekUsage | null {
  const entry = resolveAgentRateLimitForModel({ ...args, modelId: args.modelId ?? null });
  if (!entry) return null;
  const [window, otherWindow] = getAgentRateLimitWindows(entry.limits)
    .sort(
      (left, right) =>
        (left.windowDurationSeconds ?? Number.POSITIVE_INFINITY) -
        (right.windowDurationSeconds ?? Number.POSITIVE_INFINITY)
    )
    .slice(0, HOME_WEEK_USAGE_WINDOWS);
  if (!window) return null;
  return { name: entry.limits.limitName?.trim() || null, window, otherWindow: otherWindow ?? null };
}
