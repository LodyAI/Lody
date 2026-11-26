import { isTransientConvexQueryError } from './authed-convex-query';

export function recoveryAvailabilityMessage(code: string): string | undefined {
  if (code.includes('e2ee_recovery_unavailable')) return 'e2ee.recovery.error.unavailable';
  if (code.includes('e2ee_recovery_storage')) return 'e2ee.recovery.error.storage';
  if (/e2ee_recovery_(?:conflict|rollback)/.test(code)) return 'e2ee.recovery.error.conflict';
}

/** Preserve structured codes from cloud and desktop requests for display only. */
export function requestFailureCode(error: unknown, depth = 0): string | undefined {
  if (!error || typeof error !== 'object' || depth > 3) return undefined;
  const record = error as {
    code?: unknown;
    data?: { code?: unknown };
    message?: unknown;
    cause?: unknown;
  };
  const code = record.data?.code ?? record.code;
  if (typeof code === 'string') return code;
  const messageCode =
    typeof record.message === 'string'
      ? /(?:^|: )((?:e2ee_|pairing-)[\w-]+)$/.exec(record.message)?.[1]
      : undefined;
  return messageCode ?? requestFailureCode(record.cause, depth + 1);
}

export function isRequestUnavailable(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 3) return false;
  const record = error as {
    _tag?: string;
    reason?: string;
    status?: number;
    statusCode?: number;
    name?: string;
    message?: string;
    cause?: unknown;
  };
  const status = record.status ?? record.statusCode;
  const code = requestFailureCode(error);
  return (
    (typeof status === 'number' && (status === 0 || status >= 500)) ||
    (error instanceof Error && isTransientConvexQueryError(error)) ||
    (record._tag === 'BackendError' && record.reason === 'unavailable') ||
    /^(?:e2ee_)?(?:network|offline|timeout|unavailable|ledger_unavailable)$/.test(code ?? '') ||
    /^(?:NetworkError|TimeoutError)$/.test(record.name ?? '') ||
    /failed to fetch|fetch failed|load failed|network(?:error| request failed)|timed? ?out/i.test(
      record.message ?? ''
    ) ||
    globalThis.navigator?.onLine === false ||
    isRequestUnavailable(record.cause, depth + 1)
  );
}

export function isLocalStorageFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { _tag, name } = error as { _tag?: string; name?: string };
  return (
    _tag === 'LocalStoreError' ||
    _tag === 'ClientCustodyError' ||
    _tag === 'KeyProtectorError' ||
    /^(?:QuotaExceededError|InvalidStateError|UnknownError|NotReadableError)$/.test(name ?? '') ||
    /^(?:e2ee_)?(?:storage|permissions|corrupt|custody_unavailable|protection-unavailable)$/.test(
      requestFailureCode(error) ?? ''
    )
  );
}

/** Display classification for management actions. This never changes access or retries a write. */
export function managementFailureKind(error: unknown) {
  const code = requestFailureCode(error);
  if (
    /^(?:e2ee_(?:member_)?(?:management_)?|member_)?(?:unauthorized|forbidden|device_revoked|member_removed)$/.test(
      code ?? ''
    ) ||
    code === 'revoked'
  )
    return 'unauthorized';
  if (
    /^(?:e2ee_(?:member_)?(?:management_)?|member_)?(?:conflict|history-conflict)$/.test(code ?? '')
  )
    return 'conflict';
  if (isRequestUnavailable(error)) return 'network';
  return 'generic';
}
