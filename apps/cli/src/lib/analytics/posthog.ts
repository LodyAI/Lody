/**
 * Lightweight CLI PostHog poster (spec §8b, Foundation C).
 *
 * No PostHog SDK dependency on purpose: the CLI ships as a small bundle and the
 * official `posthog-node` pulls in a heavier transitive tree. We POST directly
 * to the `/batch/` ingestion endpoint with the global `fetch` (Node 18+).
 * Rejected alternatives:
 *   - posthog-node: adds an npm dependency the bundle does not need.
 *   - per-event POST to /capture/: one network round-trip per event would
 *     dominate short one-shot commands; we buffer and batch instead.
 *
 * distinct_id defaults to the resolved `machine_id` (non-PII surrogate for the
 * machine, never the user's email) and falls back to a stable anonymous id.
 * The module never throws into product code: every public function swallows
 * its own errors.
 */

import {
  getServerNow,
  pickSampleRate,
  shouldSampleEvent,
  type AnalyticsSamplingTier,
} from '@lody/shared';
import { resolvePlatformKind } from '@lody/shared/platform-kind';
import { readExistingMachineId } from '@/lib/machine-identity';
import { getRuntimeEnv } from '@/utils/runtime-env';
import pkg from '@/pkg';

const DEFAULT_HOST = 'https://us.i.posthog.com';
const FLUSH_INTERVAL_MS = 30_000;
const MAX_BUFFER = 100;
const DEFAULT_FLUSH_TIMEOUT_MS = 2000;

interface CliAnalyticsEvent {
  event: string;
  distinctId: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

interface CliAnalyticsState {
  apiKey: string;
  host: string;
  defaultDistinctId: string;
  release: string;
  env: string;
  buffer: CliAnalyticsEvent[];
  timer: ReturnType<typeof setInterval> | null;
}

let state: CliAnalyticsState | null = null;

function resolveApiKey(): string | undefined {
  if (resolvePlatformKind(process.env.LODY_PLATFORM) === 'local') return undefined;
  const key =
    process.env.LODY_POSTHOG_KEY ||
    process.env.POSTHOG_API_KEY ||
    process.env.VITE_PUBLIC_POSTHOG_KEY;
  return key && key.trim() ? key.trim() : undefined;
}

function resolveHost(): string {
  const host = process.env.POSTHOG_HOST;
  return host && host.trim() ? host.trim().replace(/\/+$/, '') : DEFAULT_HOST;
}

/**
 * Resolve a stable distinct_id for the machine. Prefers the existing machine id
 * (same value used elsewhere as `machine_id`); falls back to a per-process
 * anonymous id so events are never dropped just because the machine id could
 * not be read. The anon id is intentionally not persisted: an unresolved
 * machine id is rare and a transient anon bucket is preferable to writing new
 * state from the analytics layer.
 */
function resolveDistinctId(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  try {
    const machineId = readExistingMachineId();
    if (machineId) return machineId;
  } catch {
    // fall through to anon id
  }
  return `anon-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Initialize the CLI analytics poster. Safe to call multiple times: the first
 * successful init wins and later calls are no-ops. No-op (disabled) when no
 * PostHog key is present in the environment.
 */
export function initCliAnalytics(opts?: { distinctId?: string; release?: string }): void {
  try {
    if (state) return;
    const apiKey = resolveApiKey();
    if (!apiKey) return;

    const distinctId = resolveDistinctId(opts?.distinctId);
    const release = opts?.release || `${pkg.name}@${pkg.version}`;

    const timer = setInterval(() => {
      void flushCliAnalytics();
    }, FLUSH_INTERVAL_MS);
    // Do not keep the event loop alive solely for the analytics flush timer.
    if (typeof timer.unref === 'function') timer.unref();

    state = {
      apiKey,
      host: resolveHost(),
      defaultDistinctId: distinctId,
      release,
      env: getRuntimeEnv(),
      buffer: [],
      timer,
    };
  } catch {
    // Never let analytics init break the CLI.
    state = null;
  }
}

export function isCliAnalyticsEnabled(): boolean {
  return state !== null;
}

/**
 * Capture a CLI analytics event. Applies tier sampling: tier-C (and any tier
 * with rate < 1) events are dropped probabilistically and carry `sample_rate`
 * so consumers can reweight. Buffers the event and flushes when the buffer is
 * full; otherwise the interval timer / explicit flush drains it. Never throws.
 */
export function captureCli(
  eventName: string,
  properties?: Record<string, unknown>,
  opts?: { tier?: AnalyticsSamplingTier; sampleRate?: number; distinctId?: string }
): void {
  try {
    if (!state) return;
    const tier = opts?.tier ?? 'B';
    if (!shouldSampleEvent(tier, opts?.sampleRate)) return;

    const sampleRate = pickSampleRate(tier, opts?.sampleRate);
    const distinctId =
      opts?.distinctId && opts.distinctId.trim() ? opts.distinctId.trim() : state.defaultDistinctId;

    // server-calibrated timestamp for cross-client comparability (spec §0)
    const serverNow = getServerNow();
    const props: Record<string, unknown> = {
      ...properties,
      sample_rate: sampleRate,
      platform: 'cli',
      machine_id: state.defaultDistinctId,
      app_version: pkg.version,
      env: state.env,
      server_ts_ms: serverNow,
      $lib: 'lody-cli',
      $lib_version: pkg.version,
    };

    state.buffer.push({
      event: eventName,
      distinctId,
      properties: props,
      timestamp: new Date(serverNow).toISOString(),
    });

    if (state.buffer.length >= MAX_BUFFER) {
      void flushCliAnalytics();
    }
  } catch {
    // Never let analytics capture break the CLI.
  }
}

/**
 * Flush buffered events to PostHog's `/batch/` endpoint. Resolves once the POST
 * settles or the timeout elapses; never rejects. Events are dropped (not
 * re-buffered) on failure to keep one-shot exits bounded.
 */
export async function flushCliAnalytics(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
  if (!state || state.buffer.length === 0) return;
  const current = state;
  const batch = current.buffer;
  current.buffer = [];

  const payload = {
    api_key: current.apiKey,
    historical_migration: false,
    batch: batch.map((e) => ({
      event: e.event,
      distinct_id: e.distinctId,
      properties: e.properties,
      timestamp: e.timestamp,
    })),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(`${current.host}/batch/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
      keepalive: true,
    });
  } catch {
    // Drop the batch on failure: re-buffering risks unbounded growth and would
    // delay one-shot command exit. Analytics is best-effort.
  } finally {
    clearTimeout(timer);
  }
}
