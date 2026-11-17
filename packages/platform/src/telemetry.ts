/** Fixed diagnostics vocabulary. Never infer a safe code from an error message. */
const TELEMETRY_ERROR_CODES = new Set([
  'shortcut_exchange_unavailable',
  'shortcut_exchange_rejected',
  'shortcut_exchange_invalid',
  'shortcut_exchange_not_configured',
  'shortcut_token_expired',
  'e2ee_feature_unavailable',
  'workspace_mode_mismatch',
  'workspace_mode_admission_timeout',
  'unauthenticated',
  'forbidden',
]);

export function safeTelemetryErrorCode(value: unknown): string {
  return typeof value === 'string' && TELEMETRY_ERROR_CODES.has(value)
    ? value
    : 'redacted_exception';
}

function fixed(value: unknown, allowed: readonly string[], fallback = 'unknown'): string {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

const ERROR_TYPES = [
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
  'RuntimeError',
];
const SOURCES = [
  'captureException',
  'uncaughtException',
  'unhandledRejection',
  'onerror',
  'onunhandledrejection',
  'generic',
  'errorBoundary',
  'unhandled',
];

// This consumer reports readiness observations, never raw sync/provider errors.
const WORKSPACE_SYNC_STAGES = [
  'runtime_missing',
  'runtime_init_failed',
  'runtime_other_workspace',
  'doc_meta_scan_pending',
  'doc_meta_scan_failed',
  'workspace_not_in_organizations',
  'workspace_id_mismatch',
];

/** Do not accept arbitrary release labels: even a short string may be a secret. */
function version(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length <= 48 &&
    /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-(?:nightly|alpha|beta|rc)(?:\.\d{1,8})?)?$/.test(value)
    ? value
    : undefined;
}

/** Idempotent projection: no message, stack, cause, paths or caller fingerprint survives.
 * Categories and sources are coarse diagnostics, never evidence of a common root cause. */
export function redactedTelemetryException(
  properties: Record<string, unknown> = {},
  error?: unknown
) {
  const code = safeTelemetryErrorCode(properties.error_code);
  const first = record(
    Array.isArray(properties.$exception_list) ? properties.$exception_list[0] : null
  );
  let name: unknown;
  // Foreign errors may have throwing accessors. Diagnostics must not break capture.
  try {
    name = record(error).name;
  } catch {
    /* keep unknown */
  }
  const errorType = fixed(properties.error_type ?? name ?? first.type, ERROR_TYPES);
  const source = fixed(
    properties.source ??
      (properties.errorBoundary !== undefined ? 'errorBoundary' : undefined) ??
      (record(first.mechanism).handled === false
        ? 'unhandled'
        : record(first.mechanism).handled === true
          ? 'captureException'
          : record(first.mechanism).type),
    SOURCES
  );
  const platform = fixed(properties.platform, ['web', 'mobile', 'electron', 'cli']);
  const electronProcess = fixed(properties.electron_process, ['main', 'renderer']);
  const nativePlatform =
    platform === 'mobile' ? fixed(properties.native_platform, ['ios', 'android']) : 'unknown';
  const process =
    platform === 'electron' ? electronProcess : platform === 'mobile' ? 'webview' : platform;
  const appVersion = version(properties.app_version);
  const libVersion = version(properties.$lib_version);
  const lib = fixed(properties.$lib, [
    'web',
    'web+esm',
    'js',
    'desktop',
    'iOS',
    'Android',
    'lody-cli',
    'lody-electron-main',
  ]);
  const syncDiagnostics =
    properties.operation === 'workspace_sync'
      ? {
          operation: 'workspace_sync',
          stage: fixed(properties.stage, WORKSPACE_SYNC_STAGES),
          failure_kind: fixed(properties.failure_kind, [
            'rejected',
            'scope_mismatch',
            'target_not_listed',
          ]),
          handling_state: fixed(properties.handling_state, ['observed']),
          retry_state: fixed(properties.retry_state, ['not_scheduled']),
        }
      : {};
  return {
    $exception_list: [{ type: errorType === 'unknown' ? 'Error' : errorType, value: code }],
    error_code: code,
    ...(code.startsWith('shortcut_')
      ? {
          shortcut_phase: fixed(properties.shortcut_phase, [
            'authorize',
            'register',
            'exchange',
            'reauthorize',
            'delivery',
          ]),
          ...(typeof properties.shortcut_status === 'number' &&
          Number.isInteger(properties.shortcut_status) &&
          properties.shortcut_status >= 100 &&
          properties.shortcut_status <= 599
            ? { shortcut_status: properties.shortcut_status }
            : {}),
        }
      : {}),
    error_type: errorType,
    source,
    platform,
    ...(platform === 'electron' ? { electron_process: electronProcess } : {}),
    ...(platform === 'mobile'
      ? { native_platform: nativePlatform, mobile_process: 'webview' }
      : {}),
    $lib: lib,
    ...(appVersion ? { app_version: appVersion } : {}),
    ...(libVersion ? { $lib_version: libVersion } : {}),
    ...syncDiagnostics,
    // Version is queryable metadata, not part of grouping across releases.
    $exception_fingerprint: `lody-redacted-v1:${platform}:${process}:${nativePlatform}:${source}:${errorType}:${code}`,
  };
}
