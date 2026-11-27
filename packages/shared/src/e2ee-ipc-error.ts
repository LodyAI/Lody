/**
 * Single IPC error codec shared between Electron main and renderer components.
 * Electron strips custom Error properties across IPC, so structured fields
 * (`attemptsLeft`, `retryAt`) are encoded as a prefix before `: e2ee_<code>`
 * so `requestFailureCode`'s trailing-code contract remains unbroken.
 */

export const E2EE_PAIRING_REFUSAL_CODES = new Set([
  'pairing-elsewhere',
  'pairing-tampered',
  'pairing-expired',
  'pairing-used',
  'pairing-update-required',
  'pairing-code-mismatch',
  'pairing-code-locked',
  'pairing-unavailable',
  'pairing-rate-limited',
  'invalid-input',
] as const);

export const E2EE_PUBLIC_FAILURE_CODES = new Set([
  'identity-busy',
  'permissions',
  'identity-lost',
  'account_unavailable',
  'custody_unavailable',
  'custody_locked',
  'missing-binding',
  ...E2EE_PAIRING_REFUSAL_CODES,
  'member_removed',
  'member_invitation_invalid',
  'member_invitation_endorser_ineligible',
  'member_invitation_expired',
  'member_invitation_mismatch',
  'member_invitation_used',
  'member_approval_failed',
  'device_revoked',
  'conflict',
  'unauthorized',
  'local-evidence-conflict',
  'snapshot-history-required',
  'key-update-required',
  'key-pending',
  'closed',
  'corrupt',
  'pairing_key_revoked',
  'storage',
  'invalid-ledger',
  'machine_not_owned',
  'machine_not_shared',
  'sharing_conflict',
  'sharing_unavailable',
  'sharing_invalid',
  'sharing_storage',
  'rotation_candidate_unavailable',
  'management_unauthorized',
  'management_operator_required',
  'management_pending',
  'management_retry',
  'self_service_rate_limited',
  'workspace_transfer_active_subscription',
  'workspace_transfer_payment_required',
  'restart-required',
  'local-history-recovery-required',
  'trusted-pin-unavailable',
] as const);

export type E2eeIpcErrorPayload =
  | {
      readonly kind: 'pairing-code-mismatch';
      readonly code: 'pairing-code-mismatch';
      readonly attemptsLeft?: number;
    }
  | {
      readonly kind: 'self-service-rate-limited';
      readonly code: 'self_service_rate_limited';
      readonly retryAt?: number;
    }
  | { readonly kind: 'code'; readonly code: string };

const nonNegativeInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function encodeE2eeIpcError(payload: E2eeIpcErrorPayload): string {
  if (payload.kind === 'pairing-code-mismatch') {
    const left = nonNegativeInt(payload.attemptsLeft);
    return left !== undefined
      ? `attemptsLeft=${left}: e2ee_pairing-code-mismatch`
      : 'e2ee_pairing-code-mismatch';
  }
  if (payload.kind === 'self-service-rate-limited') {
    const retryAt = nonNegativeInt(payload.retryAt);
    return retryAt !== undefined
      ? `retryAt=${retryAt}: e2ee_self_service_rate_limited`
      : 'e2ee_self_service_rate_limited';
  }
  return payload.code.startsWith('e2ee_') ? payload.code : `e2ee_${payload.code}`;
}

export function createE2eeIpcError(payload: E2eeIpcErrorPayload): Error {
  const error = new Error(encodeE2eeIpcError(payload));
  if (payload.kind === 'pairing-code-mismatch') {
    const attemptsLeft = nonNegativeInt(payload.attemptsLeft);
    return Object.assign(
      error,
      attemptsLeft !== undefined ? { code: payload.code, attemptsLeft } : { code: payload.code }
    );
  }
  if (payload.kind === 'self-service-rate-limited') {
    const retryAt = nonNegativeInt(payload.retryAt);
    return Object.assign(
      error,
      retryAt !== undefined ? { code: payload.code, retryAt } : { code: payload.code }
    );
  }
  return Object.assign(error, { code: payload.code });
}

const ATTEMPTS_PREFIX = /\battemptsLeft=(\d+):\s*e2ee_pairing-code-mismatch\b/;
const ATTEMPTS_LEGACY = /\be2ee_pairing-code-mismatch:(\d+)\b/;
const RETRY_AT_PREFIX = /\bretryAt=(\d+):\s*e2ee_self_service_rate_limited\b/;
const CODE_PATTERN = /\be2ee_([a-z0-9_-]{1,64})\b/;

export function decodeE2eeIpcError(error: unknown): E2eeIpcErrorPayload | undefined {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
  const record =
    error && typeof error === 'object'
      ? (error as { code?: unknown; attemptsLeft?: unknown; retryAt?: unknown })
      : undefined;

  if (message) {
    const attemptsMatch = ATTEMPTS_PREFIX.exec(message) ?? ATTEMPTS_LEGACY.exec(message);
    if (attemptsMatch) {
      const parsed = Number.parseInt(attemptsMatch[1]!, 10);
      return {
        kind: 'pairing-code-mismatch',
        code: 'pairing-code-mismatch',
        ...(Number.isSafeInteger(parsed) ? { attemptsLeft: parsed } : {}),
      };
    }
    const retryMatch = RETRY_AT_PREFIX.exec(message);
    if (retryMatch) {
      const parsed = Number.parseInt(retryMatch[1]!, 10);
      return {
        kind: 'self-service-rate-limited',
        code: 'self_service_rate_limited',
        ...(Number.isSafeInteger(parsed) ? { retryAt: parsed } : {}),
      };
    }
    const codeMatch = CODE_PATTERN.exec(message);
    if (codeMatch?.[1]) {
      const code = codeMatch[1];
      if (code === 'pairing-code-mismatch') {
        const attemptsLeft = nonNegativeInt(record?.attemptsLeft);
        return {
          kind: 'pairing-code-mismatch',
          code,
          ...(attemptsLeft !== undefined ? { attemptsLeft } : {}),
        };
      }
      if (code === 'self_service_rate_limited') {
        const retryAt = nonNegativeInt(record?.retryAt);
        return {
          kind: 'self-service-rate-limited',
          code,
          ...(retryAt !== undefined ? { retryAt } : {}),
        };
      }
      return { kind: 'code', code };
    }
  }

  if (typeof record?.code === 'string' && record.code.length > 0) {
    const code = record.code.startsWith('e2ee_') ? record.code.slice(5) : record.code;
    if (code === 'pairing-code-mismatch') {
      const attemptsLeft = nonNegativeInt(record.attemptsLeft);
      return {
        kind: 'pairing-code-mismatch',
        code,
        ...(attemptsLeft !== undefined ? { attemptsLeft } : {}),
      };
    }
    if (code === 'self_service_rate_limited') {
      const retryAt = nonNegativeInt(record.retryAt);
      return {
        kind: 'self-service-rate-limited',
        code,
        ...(retryAt !== undefined ? { retryAt } : {}),
      };
    }
    return { kind: 'code', code };
  }

  return undefined;
}
