export { isPostHogProductEvent } from './posthog-events';

/**
 * Shared analytics foundation (PostHog) used by Web, CLI, and Convex.
 *
 * Dependency-free and browser+node safe on purpose: this module is imported by
 * every client and the server, so it must not pull in an SDK or node-only APIs.
 * Sampling uses a uniform random draw (Math.random) rather than a deterministic
 * hash-of-id bucket: rejected because per-id bucketing would over/under-count
 * specific cohorts when sampled, whereas a per-event draw keeps `1/sample_rate`
 * weighting unbiased across the whole event stream.
 */

export type AnalyticsOutcome = 'success' | 'failed' | 'blocked';

export type AnalyticsSamplingTier = 'A' | 'B' | 'C';

/**
 * Default sampling rate per tier (spec §2.5):
 * - A: core funnel / milestone / `*_failed` — full, never sampled.
 * - B: one user action = one event — full, but callers should debounce bursts.
 * - C: high-frequency / telemetry — must be sampled and carry `sample_rate`.
 */
export const DEFAULT_SAMPLE_RATES: Record<AnalyticsSamplingTier, number> = {
  A: 1,
  B: 1,
  C: 0.15,
};

/**
 * Resolve the effective sample rate for a tier, honoring an explicit override.
 * The result is always clamped to [0, 1] so a bad override can never inflate
 * `1/sample_rate` weighting beyond 1x or go negative.
 */
export function pickSampleRate(tier: AnalyticsSamplingTier, override?: number): number {
  const rate =
    typeof override === 'number' && Number.isFinite(override)
      ? override
      : DEFAULT_SAMPLE_RATES[tier];
  if (rate <= 0) return 0;
  if (rate >= 1) return 1;
  return rate;
}

/**
 * Decide whether a single event should be emitted, with probability equal to
 * the resolved sample rate (uniform random draw). rate>=1 always emits, rate<=0
 * never emits.
 */
export function shouldSampleEvent(tier: AnalyticsSamplingTier, override?: number): boolean {
  const rate = pickSampleRate(tier, override);
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return Math.random() < rate;
}

/**
 * Stable FNV-1a (32-bit) hash rendered as hex. Used as a non-PII surrogate for
 * ids we must never send raw (repo_full_name, branch, path, etc.). Returns ""
 * for empty/nullish input so callers can pass through optional values directly.
 */
export function hashAnalyticsId(value: string | null | undefined): string {
  if (value == null || value === '') return '';
  // FNV-1a 32-bit. Use >>> 0 after each multiply to stay in unsigned 32-bit
  // space without BigInt; chosen over a crypto hash because it is dependency-free
  // and runs identically in browser/node/Convex.
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    // hash * 16777619, kept in 32-bit range via the FNV prime decomposition.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export const SESSION_START_FAILURE_REASONS = [
  'machine_offline',
  'missing_project',
  'missing_agent_config',
  'missing_prompt',
  'dispatch_timeout',
  'history_create_failed',
  'session_create_failed',
  'create_rejected',
  'upload_blocking',
  'unknown',
] as const;
export type SessionStartFailureReason = (typeof SESSION_START_FAILURE_REASONS)[number];

export const IMAGE_UPLOAD_REASONS = [
  'missing_auth',
  'validation_error',
  'upload_error',
  'too_many_images',
  'session_not_found',
  'session_archived',
  'active_turn_unavailable',
  'unknown',
] as const;
export type ImageUploadReason = (typeof IMAGE_UPLOAD_REASONS)[number];

export const SYNC_REASONS = [
  'timeout',
  'transport_error',
  'token_fetch_failed',
  'cursor_degraded',
  'rejected_by_server',
  'fatal_auth',
  'unknown',
] as const;
export type SyncReason = (typeof SYNC_REASONS)[number];

export const CLI_REASONS = [
  'enoent',
  'eacces',
  'process_error',
  'auth_failed',
  'timeout',
  'unknown',
] as const;
export type CliReason = (typeof CLI_REASONS)[number];

export const ACP_REASONS = [
  'enoent',
  'eacces',
  'process_error',
  'timeout',
  'transport_error',
  'protocol_error',
  'unknown',
] as const;
export type AcpReason = (typeof ACP_REASONS)[number];
