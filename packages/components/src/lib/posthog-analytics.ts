import {
  type AnalyticsOutcome,
  type AnalyticsSamplingTier,
  isTelemetryCliType,
  isTelemetryNativePlatform,
  isTelemetryPlatform,
  normalizeTelemetryAgentType,
  pickSampleRate,
  shouldSampleEvent,
  type TelemetryNativePlatform,
  type TelemetryPlatform,
} from '@lody/shared';
import { readNativeAppInfo } from './native-app-info';
import { isNativeAppShell } from './native-platform';

export { detectAppDeviceClass } from './device-class';
export type { AppDeviceClass } from './device-class';

const PERFORMANCE_UNAVAILABLE_VALUE = null;

export const POSTHOG_PROPERTY_DENYLIST: string[] = [
  '$current_url',
  '$host',
  '$initial_current_url',
  '$initial_host',
  '$initial_pathname',
  '$initial_referrer',
  '$initial_referring_domain',
  '$pathname',
  '$prev_pageview_pathname',
  '$referrer',
  '$referring_domain',
  '$session_entry_pathname',
  '$session_entry_referrer',
  '$session_entry_referring_domain',
  '$session_entry_url',
  'access_token',
  'api_key',
  'auth_token',
  'authorization',
  'authorizationCode',
  'blockers',
  'branch',
  'branch_name',
  'branchName',
  'cookie',
  'email',
  'error',
  'error_message',
  'file_path',
  'full_name',
  'githubRepoFullName',
  'href',
  'message',
  'name',
  'password',
  'path',
  'repoFullName',
  'repo_full_name',
  'refresh_token',
  'secret',
  'sessionRepoFullName',
  'stack',
  'token',
  'url',
  'workspace_slug',
];

// PostHog carries the project API key as the reserved `token` event property
// (`properties.token = config.token`) and applies `property_denylist` *after*
// setting it. Passing these reserved keys to `posthog.init({ property_denylist })`
// deletes the credential from every event, so ingestion rejects them with
// "event submitted without an api_key". App-supplied properties are still
// scrubbed via sanitizePostHogProperties(); only posthog-js's own init denylist
// must exclude the reserved keys.
const POSTHOG_RESERVED_PROPERTY_KEYS = new Set<string>(['token', 'api_key']);

export const POSTHOG_INIT_PROPERTY_DENYLIST: string[] = POSTHOG_PROPERTY_DENYLIST.filter(
  (key) => !POSTHOG_RESERVED_PROPERTY_KEYS.has(key)
);

export type PostHogAnalyticsProperties = Record<string, unknown>;

export type PostHogAnalyticsClient = {
  capture: (
    eventName: string,
    properties?: PostHogAnalyticsProperties,
    options?: { uuid?: string }
  ) => unknown;
  group?: (
    groupType: string,
    groupKey: string,
    groupProperties?: PostHogAnalyticsProperties
  ) => void;
};

export type AppLaunchMode = 'browser_tab' | 'electron';
export type AppLaunchOs = 'macos' | 'windows' | 'linux' | 'ios' | 'android' | 'unknown';

export function detectAppLaunchMode(isElectron: boolean): AppLaunchMode {
  if (isElectron) {
    return 'electron';
  }

  return 'browser_tab';
}

function normalizeAppLaunchOs(value: string | null | undefined): AppLaunchOs {
  const normalized = value?.toLowerCase();
  if (!normalized) {
    return 'unknown';
  }

  if (normalized === 'darwin' || normalized === 'mac' || normalized === 'macos') {
    return 'macos';
  }

  if (normalized === 'win32' || normalized === 'win64' || normalized === 'windows') {
    return 'windows';
  }

  if (normalized === 'linux') {
    return 'linux';
  }

  if (normalized === 'ios' || normalized === 'iphone' || normalized === 'ipad') {
    return 'ios';
  }

  if (normalized === 'android') {
    return 'android';
  }

  return 'unknown';
}

// Detect the launch OS from runtime globals, in source-priority order:
// native shell (mobile) → electron → browser UA fallback. Used post-login to
// attach `launch_os` as an event property.
export function detectLaunchOsFromEnv(): AppLaunchOs {
  const nativeOs = normalizeAppLaunchOs(readNativeAppInfo().native_platform);
  if (nativeOs !== 'unknown') {
    return nativeOs;
  }

  const electronOs = typeof window !== 'undefined' ? (window.__LODY_PLATFORM__?.os ?? null) : null;
  if (electronOs) {
    return normalizeAppLaunchOs(electronOs);
  }

  const navigator = typeof window !== 'undefined' ? window.navigator : null;
  const combined = `${navigator?.platform ?? ''} ${navigator?.userAgent ?? ''}`.toLowerCase();
  if (/iphone|ipad|ipod/.test(combined)) {
    return 'ios';
  }
  if (/android/.test(combined)) {
    return 'android';
  }
  if (/mac/.test(combined)) {
    return 'macos';
  }
  if (/win/.test(combined)) {
    return 'windows';
  }
  if (/linux|x11/.test(combined)) {
    return 'linux';
  }

  return 'unknown';
}

const roundMs = (value: number | null | undefined): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return PERFORMANCE_UNAVAILABLE_VALUE;
  }
  return Math.round(value);
};

const getPerformance = (): Performance | null => {
  if (typeof window === 'undefined' || !window.performance) {
    return null;
  }
  return window.performance;
};

export function getPerformanceNowMs(): number {
  const perf = getPerformance();
  return perf ? perf.now() : Date.now();
}

export function getDurationSinceMs(startMs: number): number | null {
  const duration = getPerformanceNowMs() - startMs;
  return roundMs(duration);
}

export function detectTelemetryPlatform(): {
  platform: TelemetryPlatform;
  native_platform?: TelemetryNativePlatform;
} {
  if (typeof window !== 'undefined' && window.__LODY_ELECTRON__) {
    return { platform: 'electron' };
  }
  const nativePlatform = readNativeAppInfo().native_platform?.toLowerCase();
  if (isTelemetryNativePlatform(nativePlatform)) {
    return { platform: 'mobile', native_platform: nativePlatform };
  }
  if (isNativeAppShell()) {
    return { platform: 'mobile' };
  }
  return { platform: 'web' };
}

export function sanitizePostHogProperties(
  properties: PostHogAnalyticsProperties | null | undefined
): PostHogAnalyticsProperties {
  if (!properties) return {};
  const safe: PostHogAnalyticsProperties = {};
  const userId = properties.user_id;
  if (typeof userId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(userId)) {
    safe.user_id = userId;
  }
  if (isTelemetryPlatform(properties.platform)) {
    safe.platform = properties.platform;
  }
  if (isTelemetryNativePlatform(properties.native_platform)) {
    safe.native_platform = properties.native_platform;
  }
  if (isTelemetryCliType(properties.cli_type)) {
    safe.cli_type = properties.cli_type;
  }
  const agentType = normalizeTelemetryAgentType(properties.agent_type);
  if (agentType !== undefined) {
    safe.agent_type = agentType;
  }
  if (typeof properties.is_new_user === 'boolean') {
    safe.is_new_user = properties.is_new_user;
  }
  if (properties.outcome === 'success' || properties.outcome === 'failed') {
    safe.outcome = properties.outcome;
  }
  return safe;
}

export function capturePostHogEvent(
  postHog: PostHogAnalyticsClient | null | undefined,
  eventName: string,
  properties?: PostHogAnalyticsProperties,
  options?: { uuid?: string }
): unknown {
  if (!postHog) {
    return;
  }

  const safe = sanitizePostHogProperties(properties);
  return options ? postHog.capture(eventName, safe, options) : postHog.capture(eventName, safe);
}

export function capturePostHogSampled(
  postHog: PostHogAnalyticsClient | null | undefined,
  eventName: string,
  properties: PostHogAnalyticsProperties | undefined,
  opts: { tier: AnalyticsSamplingTier; sampleRate?: number }
): void {
  if (!postHog) {
    return;
  }

  if (!shouldSampleEvent(opts.tier, opts.sampleRate)) {
    return;
  }

  const sampleRate = pickSampleRate(opts.tier, opts.sampleRate);
  postHog.capture(eventName, {
    ...sanitizePostHogProperties(properties),
    sample_rate: sampleRate,
  });
}

export function capturePostHogOutcome(
  postHog: PostHogAnalyticsClient | null | undefined,
  eventName: string,
  outcome: AnalyticsOutcome,
  properties?: PostHogAnalyticsProperties
): void {
  if (!postHog) {
    return;
  }

  postHog.capture(eventName, {
    outcome,
    ...sanitizePostHogProperties(properties),
  });
}

// Trailing-edge throttle: coalesces a burst of high-frequency calls (tier C) into
// at most one event per `intervalMs`, always emitting the most recent properties.
// Rejected leading-edge: the first event in a burst rarely carries the final
// aggregated state (e.g. reorder/scroll/search-navigate), so the trailing payload
// is the meaningful one. Sampling (tier C) is applied at emit time so the
// `sample_rate` weighting stays correct even after coalescing.
export function createThrottledCapture(
  postHog: PostHogAnalyticsClient | null | undefined,
  eventName: string,
  opts: { intervalMs: number; tier?: AnalyticsSamplingTier }
): (properties?: PostHogAnalyticsProperties) => void {
  const tier: AnalyticsSamplingTier = opts.tier ?? 'C';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingProperties: PostHogAnalyticsProperties | undefined;

  const emit = () => {
    timer = null;
    const properties = pendingProperties;
    pendingProperties = undefined;
    capturePostHogSampled(postHog, eventName, properties, { tier });
  };

  return (properties?: PostHogAnalyticsProperties) => {
    pendingProperties = properties;
    if (timer !== null) {
      return;
    }
    timer = setTimeout(emit, opts.intervalMs);
  };
}

export function capturePostHogActiveUser(
  postHog: PostHogAnalyticsClient | null | undefined,
  properties: PostHogAnalyticsProperties
): void {
  capturePostHogEvent(postHog, 'app/active', {
    active_context: 'authenticated_app',
    ...properties,
  });
}

export function getAppLaunchPerformanceProperties(): Record<string, unknown> {
  const perf = getPerformance();
  if (!perf) {
    return {
      page_elapsed_ms: PERFORMANCE_UNAVAILABLE_VALUE,
      navigation_type: 'unknown',
      dom_interactive_ms: PERFORMANCE_UNAVAILABLE_VALUE,
      dom_content_loaded_ms: PERFORMANCE_UNAVAILABLE_VALUE,
      load_event_ms: PERFORMANCE_UNAVAILABLE_VALUE,
      first_paint_ms: PERFORMANCE_UNAVAILABLE_VALUE,
      first_contentful_paint_ms: PERFORMANCE_UNAVAILABLE_VALUE,
    };
  }

  const navigationEntry = perf.getEntriesByType?.('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined;
  const paintEntries = perf.getEntriesByType?.('paint') ?? [];
  const firstPaint = paintEntries.find((entry) => entry.name === 'first-paint');
  const firstContentfulPaint = paintEntries.find(
    (entry) => entry.name === 'first-contentful-paint'
  );

  return {
    page_elapsed_ms: roundMs(perf.now()),
    navigation_type: navigationEntry?.type ?? 'unknown',
    dom_interactive_ms: roundMs(navigationEntry?.domInteractive),
    dom_content_loaded_ms: roundMs(navigationEntry?.domContentLoadedEventEnd),
    load_event_ms: roundMs(navigationEntry?.loadEventEnd),
    first_paint_ms: roundMs(firstPaint?.startTime),
    first_contentful_paint_ms: roundMs(firstContentfulPaint?.startTime),
  };
}

export type AnalyticsFileKind = 'html' | 'md' | 'image' | 'pdf' | 'other';

const ANALYTICS_IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
  'avif',
  'heic',
]);

/**
 * Coarse file-type enum for analytics. File names and paths are never sent;
 * only the bucket derived from the extension.
 */
export function getAnalyticsFileKind(fileNameOrPath: string): AnalyticsFileKind {
  const base = fileNameOrPath.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'md';
  if (ext === 'pdf') return 'pdf';
  if (ANALYTICS_IMAGE_EXTENSIONS.has(ext)) return 'image';
  return 'other';
}
