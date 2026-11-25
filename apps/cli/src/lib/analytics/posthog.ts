import { usageSharingRevision } from '@lody/shared/node/usage-sharing';
import {
  getServerNow,
  isPostHogProductEvent,
  shouldSampleEvent,
  type AnalyticsSamplingTier,
} from '@lody/shared';
import { resolvePlatformKind } from '@lody/shared/platform-kind';
import { randomUUID } from 'node:crypto';
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
  revision: string | null;
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
 * Initialize the CLI analytics poster. Safe to call multiple times: the first
 * successful init wins and later calls are no-ops. No-op (disabled) when no
 * PostHog key is present in the environment.
 */
export function initCliAnalytics(): void {
  try {
    if (state) return;
    const apiKey = resolveApiKey();
    if (!apiKey) return;

    const timer = setInterval(() => {
      void flushCliAnalytics();
    }, FLUSH_INTERVAL_MS);
    // Do not keep the event loop alive solely for the analytics flush timer.
    if (typeof timer.unref === 'function') timer.unref();

    state = {
      apiKey,
      host: resolveHost(),
      defaultDistinctId: randomUUID(),
      revision: usageSharingRevision(),
      buffer: [],
      timer,
    };
  } catch {
    // Never let analytics init break the CLI.
    state = null;
  }
}

export function isCliAnalyticsEnabled(): boolean {
  return state !== null && usageSharingRevision() !== null;
}

/**
 * Sample before buffering. Only registered event names and SDK attribution leave the process.
 */
export function captureCli(
  eventName: string,
  _properties?: Record<string, unknown>,
  opts?: { tier?: AnalyticsSamplingTier; sampleRate?: number; distinctId?: string }
): void {
  try {
    if (!state || !isPostHogProductEvent(eventName)) return;
    const revision = usageSharingRevision();
    if (state.revision !== revision) {
      state.buffer = [];
      state.revision = revision;
      state.defaultDistinctId = randomUUID();
    }
    if (!revision) return;
    const tier = opts?.tier ?? 'B';
    if (!shouldSampleEvent(tier, opts?.sampleRate)) return;

    const serverNow = getServerNow();
    const props = { $lib: 'lody-cli', $lib_version: pkg.version };

    state.buffer.push({
      event: eventName,
      distinctId: state.defaultDistinctId,
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
  if (!current.revision || current.revision !== usageSharingRevision()) return;

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
