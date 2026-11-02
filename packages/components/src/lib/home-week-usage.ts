import type { AgentConfigId } from '@lody/shared';
import {
  getAgentRateLimitWindows,
  resolveAgentRateLimitForModel,
  type AgentRateLimitWindow,
  type MachineRateLimits,
} from './session-usage';

/** The new-chat page shows one window: the shortest, the one that resets next (5 hours when there is one). */
const HOME_WEEK_USAGE_WINDOWS = 1;

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
  /** The shortest window, alone. */
  windows: AgentRateLimitWindow[];
};

/**
 * The subscription windows of the provider the composer has selected: the same entry, found
 * the same way, that the composer's usage popover reads from the machine's rate limits. Local
 * data only. Null when the provider reported no window, so the page shows nothing rather than
 * an empty meter.
 */
export function buildHomeWeekUsage(args: {
  rateLimits: MachineRateLimits | null | undefined;
  agentType: string;
  agentConfigId?: AgentConfigId | null;
  modelId?: string | null;
}): HomeWeekUsage | null {
  const entry = resolveAgentRateLimitForModel({ ...args, modelId: args.modelId ?? null });
  if (!entry) return null;
  const windows = getAgentRateLimitWindows(entry.limits)
    .sort(
      (left, right) =>
        (left.windowDurationSeconds ?? Number.POSITIVE_INFINITY) -
        (right.windowDurationSeconds ?? Number.POSITIVE_INFINITY)
    )
    .slice(0, HOME_WEEK_USAGE_WINDOWS);
  if (windows.length === 0) return null;
  return { name: entry.limits.limitName?.trim() || null, windows };
}
