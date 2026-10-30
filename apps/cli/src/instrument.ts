import { PostHog } from 'posthog-node';
import { redactedTelemetryException } from '@lody/platform/telemetry';
import { resolvePlatformKind } from '@lody/shared/platform-kind';
// The published package name stays `lody`, but the version must follow the
// release manifest (`@/pkg`): cloud builds alias it to the composing package so
// the bundle reports the version that was actually published to npm.
import { name as packageName } from '../package.json';
import { version as packageVersion } from '@/pkg';
import { getRuntimeEnv } from './utils/runtime-env';
import { getSystemMachineId } from './utils/const';
import { captureCli, flushCliAnalytics } from './lib/analytics/posthog';

/** CLI and embedded cloud-daemon failures use a fixed error vocabulary. The
 * process can serve multiple workspaces, so it cannot authorize raw exception
 * details using a single workspace's mode. */

const DEFAULT_HOST = 'https://us.i.posthog.com';
const DEFAULT_FLUSH_TIMEOUT_MS = 2000;

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

function resolveDistinctId(): string {
  // Use the machine id (non-PII surrogate, never the user's email) as the
  // distinct id, matching the analytics poster. Error tracking deliberately
  // does not attach the user id.
  try {
    const machineId = getSystemMachineId();
    if (machineId) return machineId;
  } catch {
    // fall through to a stable placeholder
  }
  return 'cli-unknown-machine';
}

const runtimeEnv = getRuntimeEnv();
const apiKey = resolveApiKey();
const release = `${packageName}@${packageVersion}`;
const distinctId = resolveDistinctId();
const errorReportingEnabled = runtimeEnv !== 'dev' && !!apiKey;

let client: PostHog | null = null;
if (errorReportingEnabled && apiKey) {
  client = new PostHog(apiKey, {
    host: resolveHost(),
    // Exceptions are rare; send promptly and flush explicitly before exit.
    flushAt: 1,
  });
}

const baseExceptionProps: Record<string, unknown> = {
  $lib: 'lody-cli',
  $lib_version: packageVersion,
  platform: 'cli',
  app_version: packageVersion,
  env: runtimeEnv,
  release,
  machine_id: distinctId,
};

export const flushErrorReporting = async (timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> => {
  if (!client) return;
  try {
    await Promise.race([
      client.flush().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch {
    // best-effort: telemetry flush must never reject into the exit path
  }
};

export { flushCliAnalytics };

/**
 * Flush all telemetry (error reporting + analytics) before a one-shot command
 * exits. Best-effort, never rejects.
 */
export const flushTelemetry = async (timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> => {
  await Promise.allSettled([flushErrorReporting(timeoutMs), flushCliAnalytics(timeoutMs)]);
};

export const captureException = (
  _error: unknown,
  context?: { component?: string; extra?: Record<string, unknown> }
): Promise<void> => {
  if (!client) {
    return Promise.resolve();
  }
  try {
    // A daemon can own several workspaces. There is no process-wide plaintext
    // admission, including in the cloud desktop's embedded CLI.
    const pending = client.captureImmediate({
      event: '$exception',
      distinctId,
      properties: { ...baseExceptionProps, ...redactedTelemetryException(context?.extra) },
    });
    return Promise.race([
      pending.catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, DEFAULT_FLUSH_TIMEOUT_MS)),
    ]);
  } catch {
    return Promise.resolve();
  }
};

export const captureMessage = (
  _message: string,
  context?: {
    component?: string;
    level?: 'info' | 'warning' | 'error';
    extra?: Record<string, unknown>;
  }
): Promise<void> => {
  // PostHog error tracking is exception-only, so non-exception diagnostics
  // (slow-init reports, dropped notifications) are routed to a regular analytics
  // event via the lightweight poster instead of being forged into $exceptions.
  try {
    captureCli('cli/diagnostic', redactedTelemetryException(context?.extra));
  } catch {
    return Promise.resolve();
  }
  return flushCliAnalytics();
};

export const isErrorReportingEnabled = () => errorReportingEnabled;
