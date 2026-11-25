/**
 * CLI command analytics events (spec §8b).
 *
 * Centralizes PostHog event names and property shaping for the CLI command
 * surface so call sites stay terse and the privacy contract is enforced in one
 * place. Every helper is side-effect-only and never throws: it delegates to
 * `captureCli`, which is a no-op until `initCliAnalytics` runs and swallows its
 * own errors.
 *
 * The upload boundary retains registered names and a process-scoped identifier.
 */

import { captureCli } from '@/lib/analytics/posthog';

type Props = Record<string, unknown> | undefined;

/** Emit a daemon-lifecycle event (tier A core funnel). */
export function captureDaemonEvent(event: string, properties?: Props): void {
  captureCli(`cli/${event}`, properties, { tier: 'A' });
}

/** Emit an agent-service lifecycle event (tier A). */
export function captureAgentServiceEvent(event: string, properties?: Props): void {
  captureCli(`cli/${event}`, properties, { tier: 'A' });
}

/** Emit a supervisor/crash-recovery event (tier A: crash/circuit_breaker). */
export function captureSupervisorEvent(
  event: string,
  properties?: Props,
  opts?: { distinctId?: string }
): void {
  captureCli(`cli/${event}`, properties, { tier: 'A', distinctId: opts?.distinctId });
}

/** Emit an auth (login/logout) event (tier A core funnel). */
export function captureAuthEvent(event: string, properties?: Props): void {
  captureCli(`cli/${event}`, properties, { tier: 'A' });
}

/** Emit a session-command event (tier A: create funnel). */
export function captureSessionCommandEvent(
  event: string,
  properties?: Props,
  opts?: { distinctId?: string }
): void {
  captureCli(`cli/${event}`, properties, { tier: 'A', distinctId: opts?.distinctId });
}

export function captureCliActiveUser(properties?: Props, opts?: { distinctId?: string }): void {
  captureCli(
    'app/active',
    { active_context: 'cli_agent_service', ...properties },
    { tier: 'A', distinctId: opts?.distinctId }
  );
}

/**
 * Minimum interval between `app/active_ping` emissions (spec §3.3: >= 60s).
 * Exported so the per-session heartbeat and the service-level loop share the
 * same floor.
 */
export const ACTIVE_PING_MIN_INTERVAL_MS = 60_000;

/**
 * Emit `app/active_ping` (tier C: high-frequency telemetry, sampled). Callers
 * MUST gate this to >= ACTIVE_PING_MIN_INTERVAL_MS and stop while idle; this
 * helper only applies tier-C sampling.
 */
export function captureCliActivePing(properties?: Props, opts?: { distinctId?: string }): void {
  captureCli('app/active_ping', properties, { tier: 'C', distinctId: opts?.distinctId });
}
