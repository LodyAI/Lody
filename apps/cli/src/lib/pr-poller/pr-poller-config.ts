/**
 * Env-driven configuration for the PR reconciler (spec
 * `specs/pr-status-reconciler.md` — 附录:默认配置).
 *
 * Kill switch: `LODY_PR_POLL_DISABLED=1`. Numeric overrides use the
 * `LODY_PR_POLL_*` variables below; anything unset or unparseable falls back
 * to the spec defaults. Only the invariants are normative — the numbers are
 * tunables.
 */
export type PrPollerConfig = {
  /** Master switch — false when LODY_PR_POLL_DISABLED=1. */
  enabled: boolean;
  /** High-lane desired interval (viewed / recent activity). Default 20 s. */
  highIntervalMs: number;
  /** Low-lane status desired interval. Default 5 min. */
  lowStatusIntervalMs: number;
  /** Low-lane discovery desired interval for sessions with no open/draft PR. Default 20 min. */
  lowDiscoveryIntervalMs: number;
  /** Hard floor between low-lane attempts. Default 60 s. */
  lowMinIntervalMs: number;
  /** High-candidacy window after conversation activity. Default 10 min. */
  activityWindowMs: number;
  /** Max owners in the high lane; overflow spills to low. Default 100. */
  highOwnerCap: number;
  /** Anti-starvation: under contention, ≥1 of every N dispatches is low-lane. Default 5. */
  lowLaneEveryNBatches: number;
  /** Token-bucket capacity per credential scope, in GraphQL points. Default 20. */
  bucketCapacityPoints: number;
  /** Token-bucket refill per credential scope, in points/minute. Default 4 (~5% of 5000 pts/h). */
  bucketRefillPointsPerMinute: number;
  /** Max field aliases in one batched GraphQL query. Default 20. */
  maxAliasesPerQuery: number;
  /** Per-request fetch timeout. Default 30 s. */
  fetchTimeoutMs: number;
  /** Max concurrent GraphQL requests. Default 2. */
  fetchConcurrency: number;
  /** First cooldown after a repo-level error (404/forbidden/token). Default 15 min. */
  repoCooldownBaseMs: number;
  /** Cooldown cap for exponential backoff. Default 2 h. */
  repoCooldownMaxMs: number;
  /** Freeze a scope when rateLimit.remaining drops below this ratio of its limit. Default 0.1. */
  rateLimitFreezeRemainingRatio: number;
};

export const PR_POLLER_DEFAULTS: PrPollerConfig = {
  enabled: true,
  highIntervalMs: 20_000,
  lowStatusIntervalMs: 5 * 60_000,
  lowDiscoveryIntervalMs: 20 * 60_000,
  lowMinIntervalMs: 60_000,
  activityWindowMs: 10 * 60_000,
  highOwnerCap: 100,
  lowLaneEveryNBatches: 5,
  bucketCapacityPoints: 20,
  bucketRefillPointsPerMinute: 4,
  maxAliasesPerQuery: 20,
  fetchTimeoutMs: 30_000,
  fetchConcurrency: 2,
  repoCooldownBaseMs: 15 * 60_000,
  repoCooldownMaxMs: 2 * 60 * 60_000,
  rateLimitFreezeRemainingRatio: 0.1,
};

function readEnvNumber(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readEnvDisabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.LODY_PR_POLL_DISABLED?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

export function loadPrPollerConfig(env: NodeJS.ProcessEnv = process.env): PrPollerConfig {
  return {
    enabled: !readEnvDisabled(env),
    highIntervalMs: readEnvNumber(
      env,
      'LODY_PR_POLL_HIGH_INTERVAL_MS',
      PR_POLLER_DEFAULTS.highIntervalMs
    ),
    lowStatusIntervalMs: readEnvNumber(
      env,
      'LODY_PR_POLL_LOW_STATUS_INTERVAL_MS',
      PR_POLLER_DEFAULTS.lowStatusIntervalMs
    ),
    lowDiscoveryIntervalMs: readEnvNumber(
      env,
      'LODY_PR_POLL_LOW_DISCOVERY_INTERVAL_MS',
      PR_POLLER_DEFAULTS.lowDiscoveryIntervalMs
    ),
    lowMinIntervalMs: readEnvNumber(
      env,
      'LODY_PR_POLL_LOW_MIN_INTERVAL_MS',
      PR_POLLER_DEFAULTS.lowMinIntervalMs
    ),
    activityWindowMs: readEnvNumber(
      env,
      'LODY_PR_POLL_ACTIVITY_WINDOW_MS',
      PR_POLLER_DEFAULTS.activityWindowMs
    ),
    highOwnerCap: readEnvNumber(
      env,
      'LODY_PR_POLL_HIGH_OWNER_CAP',
      PR_POLLER_DEFAULTS.highOwnerCap
    ),
    lowLaneEveryNBatches: readEnvNumber(
      env,
      'LODY_PR_POLL_LOW_LANE_EVERY_N',
      PR_POLLER_DEFAULTS.lowLaneEveryNBatches
    ),
    bucketCapacityPoints: readEnvNumber(
      env,
      'LODY_PR_POLL_BUCKET_CAPACITY',
      PR_POLLER_DEFAULTS.bucketCapacityPoints
    ),
    bucketRefillPointsPerMinute: readEnvNumber(
      env,
      'LODY_PR_POLL_BUCKET_REFILL_PER_MINUTE',
      PR_POLLER_DEFAULTS.bucketRefillPointsPerMinute
    ),
    maxAliasesPerQuery: readEnvNumber(
      env,
      'LODY_PR_POLL_MAX_ALIASES',
      PR_POLLER_DEFAULTS.maxAliasesPerQuery
    ),
    fetchTimeoutMs: readEnvNumber(
      env,
      'LODY_PR_POLL_FETCH_TIMEOUT_MS',
      PR_POLLER_DEFAULTS.fetchTimeoutMs
    ),
    fetchConcurrency: readEnvNumber(
      env,
      'LODY_PR_POLL_FETCH_CONCURRENCY',
      PR_POLLER_DEFAULTS.fetchConcurrency
    ),
    repoCooldownBaseMs: readEnvNumber(
      env,
      'LODY_PR_POLL_REPO_COOLDOWN_BASE_MS',
      PR_POLLER_DEFAULTS.repoCooldownBaseMs
    ),
    repoCooldownMaxMs: readEnvNumber(
      env,
      'LODY_PR_POLL_REPO_COOLDOWN_MAX_MS',
      PR_POLLER_DEFAULTS.repoCooldownMaxMs
    ),
    rateLimitFreezeRemainingRatio: PR_POLLER_DEFAULTS.rateLimitFreezeRemainingRatio,
  };
}
