/** Fixed diagnostics vocabulary. Never infer a safe code from an error message. */
const TELEMETRY_ERROR_CODES = new Set([
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

/** The exception envelope contains no original message, stack, cause or extra fields. */
export function redactedTelemetryException(properties: Record<string, unknown> = {}) {
  const code = safeTelemetryErrorCode(properties.error_code);
  return {
    $exception_list: [{ type: 'Error', value: code }],
    error_code: code,
  };
}
