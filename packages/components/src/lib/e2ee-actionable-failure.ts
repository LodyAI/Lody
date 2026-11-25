import { accountPairingErrorCode } from '@lody/platform';
import { e2eeErrorCode } from './e2ee-admission-refusals';
import {
  classifyE2eeControlFailure,
  custodyFailureMessage,
  personalHostFailureCode,
} from './e2ee-control-failure';

/**
 * Closed actionable failure disposition across E2EE authorization, pairing and revocation.
 * Every failure maps to one of these four dispositions and at least one concrete user action,
 * so no surface collapses deterministic refusals into a generic "reconnect and retry" dead end.
 */
export type E2eeFailureDisposition = 'retryable' | 'reconcilable' | 'env_blocked' | 'hard_conflict';

export type E2eeRecoveryAction =
  | 'retry_saved'
  | 'resume_existing_request'
  | 'cancel_previous_request'
  | 'open_workspace'
  | 'repair_device'
  | 'verify_email'
  | 'unlock_custody'
  | 'upgrade_client'
  | 'refresh_state'
  | 'restart_pairing'
  | 'reset_identity'
  | 'back_home';

export interface E2eeActionableFailure {
  readonly disposition: E2eeFailureDisposition;
  /** Sanitized, content-free error code for diagnostics (never raw server text or secrets). */
  readonly code: string;
  /** Translation key describing what happened and what the user can do. */
  readonly messageKey: string;
  readonly primaryAction: E2eeRecoveryAction;
  readonly secondaryAction?: E2eeRecoveryAction;
}

const KNOWN_PLAIN_CODES = new Set([
  'already_member',
  'email_verification_required',
  'invitation_limit_reached',
  'free_workspace_member_limit_reached',
  'workspace_transfer_active_subscription',
  'workspace_transfer_payment_required',
]);

function readNestedCode(error: unknown, depth = 0): string | null {
  if (!error || typeof error !== 'object' || depth > 4) return null;
  const record = error as {
    _tag?: unknown;
    reason?: unknown;
    code?: unknown;
    data?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (record._tag === 'ClientCustodyError' && typeof record.reason === 'string') {
    return `custody_${record.reason}`;
  }
  if (typeof record.code === 'string') {
    if (record.code.startsWith('e2ee_') || KNOWN_PLAIN_CODES.has(record.code)) return record.code;
  }
  if (record.data && typeof record.data === 'object') {
    const dataCode = (record.data as { code?: unknown }).code;
    if (
      typeof dataCode === 'string' &&
      (dataCode.startsWith('e2ee_') || KNOWN_PLAIN_CODES.has(dataCode))
    ) {
      return dataCode;
    }
  }
  if (typeof record.message === 'string') {
    if (KNOWN_PLAIN_CODES.has(record.message)) return record.message;
    const match = /\b(e2ee_[\w-]+)\b/.exec(record.message);
    if (match?.[1]) return match[1];
    for (const plain of KNOWN_PLAIN_CODES) {
      if (record.message.includes(plain)) return plain;
    }
  }
  return readNestedCode(record.cause, depth + 1);
}

/** Extract a sanitized, content-free E2EE failure code from any host, custody, IPC or Convex error. */
export function extractE2eeFailureCode(error: unknown): string | null {
  const portable = personalHostFailureCode(error);
  if (portable) return portable.startsWith('e2ee_') ? portable : `e2ee_${portable}`;
  const pairing = accountPairingErrorCode(error);
  if (pairing) return `e2ee_${pairing}`;
  const direct = e2eeErrorCode(error);
  if (direct) return direct;
  return readNestedCode(error);
}

const custodyMessageFor = (code: string | null, error: unknown): string | null => {
  const specific = custodyFailureMessage(classifyE2eeControlFailure(error).kind);
  if (specific) return specific;
  if (
    code === 'custody_locked' ||
    code === 'custody_unavailable' ||
    code === 'e2ee_custody_unavailable' ||
    code === 'e2ee_protection-unavailable' ||
    code === 'e2ee_permissions' ||
    code === 'e2ee_basic-text'
  ) {
    return 'e2ee.actionable.custodyBlocked';
  }
  return null;
};

export function classifyMemberJoinFailure(error: unknown): E2eeActionableFailure {
  const code = extractE2eeFailureCode(error);
  if (code === 'already_member') {
    return {
      disposition: 'reconcilable',
      code,
      messageKey: 'e2ee.actionable.alreadyMember',
      primaryAction: 'open_workspace',
    };
  }
  if (code === 'e2ee_original_join_pending' || code === 'e2ee_member_request_exists') {
    return {
      disposition: 'reconcilable',
      code,
      messageKey: 'e2ee.actionable.previousJoinPending',
      primaryAction: 'cancel_previous_request',
      secondaryAction: 'resume_existing_request',
    };
  }
  if (code === 'email_verification_required') {
    return {
      disposition: 'env_blocked',
      code,
      messageKey: 'e2ee.team.verifyHelp',
      primaryAction: 'verify_email',
    };
  }
  if (code === 'e2ee_member_invitation_unavailable') {
    return {
      disposition: 'reconcilable',
      code,
      messageKey: 'e2ee.team.unavailable',
      primaryAction: 'back_home',
    };
  }
  if (code === 'e2ee_member_removed' || code === 'e2ee_device_revoked') {
    return {
      disposition: 'reconcilable',
      code,
      messageKey: 'e2ee.actionable.accessLost',
      primaryAction: 'retry_saved',
    };
  }
  const custodyKey = custodyMessageFor(code, error);
  if (custodyKey) {
    return {
      disposition: 'env_blocked',
      code: code ?? 'custody_unavailable',
      messageKey: custodyKey,
      primaryAction: 'unlock_custody',
      secondaryAction: 'back_home',
    };
  }
  if (code === 'e2ee_unsupported' || code === 'e2ee_client_upgrade_required') {
    return {
      disposition: 'env_blocked',
      code,
      messageKey: 'e2ee.team.joinUpgrade',
      primaryAction: 'upgrade_client',
      secondaryAction: 'back_home',
    };
  }
  if (
    code === 'e2ee_account_mismatch' ||
    code === 'e2ee_scope-mismatch' ||
    code === 'e2ee_unauthorized' ||
    code === 'e2ee_member_unauthorized'
  ) {
    return {
      disposition: 'reconcilable',
      code,
      messageKey: 'e2ee.actionable.accountChanged',
      primaryAction: 'refresh_state',
      secondaryAction: 'back_home',
    };
  }
  if (
    code === 'e2ee_conflict' ||
    code === 'e2ee_member_conflict' ||
    code === 'e2ee_member_binding_conflict' ||
    code === 'e2ee_corrupt' ||
    code === 'e2ee_invalid-ledger' ||
    code === 'e2ee_history-conflict'
  ) {
    return {
      disposition: 'hard_conflict',
      code,
      messageKey: 'e2ee.actionable.joinConflict',
      primaryAction: 'back_home',
    };
  }
  return {
    disposition: 'retryable',
    code: code ?? 'e2ee_network_unconfirmed',
    messageKey: 'e2ee.team.retryOriginal',
    primaryAction: 'retry_saved',
  };
}

export function classifyTeamAdminFailure(error: unknown): E2eeActionableFailure {
  const code = extractE2eeFailureCode(error);
  if (code === 'e2ee_member_invitation_request_pending') {
    return {
      disposition: 'reconcilable',
      code,
      messageKey: 'e2ee.team.invitationRequestPending',
      primaryAction: 'refresh_state',
    };
  }
  if (
    code === 'e2ee_member_already_submitting' ||
    code === 'e2ee_member_conflict' ||
    code === 'e2ee_conflict'
  ) {
    return {
      disposition: 'reconcilable',
      code,
      messageKey: 'e2ee.actionable.adminStateChanged',
      primaryAction: 'refresh_state',
    };
  }
  if (code === 'e2ee_member_invitation_unavailable') {
    return {
      disposition: 'reconcilable',
      code,
      messageKey: 'e2ee.actionable.invitationUnavailable',
      primaryAction: 'refresh_state',
    };
  }
  if (code === 'e2ee_device_revoked' || code === 'e2ee_member_removed') {
    return {
      disposition: 'reconcilable',
      code,
      messageKey: 'e2ee.actionable.accessLost',
      primaryAction: 'repair_device',
    };
  }
  if (code === 'e2ee_client_upgrade_required' || code === 'e2ee_unsupported') {
    return {
      disposition: 'env_blocked',
      code,
      messageKey: 'e2ee.team.upgrade',
      primaryAction: 'upgrade_client',
    };
  }
  const custodyKey = custodyMessageFor(code, error);
  if (custodyKey) {
    return {
      disposition: 'env_blocked',
      code: code ?? 'custody_unavailable',
      messageKey: custodyKey,
      primaryAction: 'unlock_custody',
    };
  }
  return {
    disposition: 'retryable',
    code: code ?? 'e2ee_network_unconfirmed',
    messageKey: 'e2ee.team.retryOriginal',
    primaryAction: 'retry_saved',
  };
}

export function classifyPairingFailure(error: unknown): E2eeActionableFailure {
  const code = extractE2eeFailureCode(error);
  if (code === 'e2ee_pairing_key_revoked') {
    return {
      disposition: 'reconcilable',
      code,
      messageKey: 'e2ee.remoteMachine.keyRevoked',
      primaryAction: 'restart_pairing',
    };
  }
  if (
    code === 'e2ee_pairing-expired' ||
    code === 'e2ee_pairing-cancelled' ||
    code === 'e2ee_join_cancelled'
  ) {
    return {
      disposition: 'reconcilable',
      code,
      messageKey: 'e2ee.actionable.pairingExpired',
      primaryAction: 'restart_pairing',
    };
  }
  if (code === 'e2ee_pairing-unavailable' || code === 'e2ee_account_pairing_disabled') {
    return {
      disposition: 'env_blocked',
      code,
      messageKey: 'e2ee.accountPair.error.pairing-unavailable',
      primaryAction: 'back_home',
    };
  }
  if (code === 'e2ee_pairing-rate-limited' || code === 'e2ee_account_pairing_rate_limited') {
    return {
      disposition: 'retryable',
      code,
      messageKey: 'e2ee.accountPair.error.pairing-rate-limited',
      primaryAction: 'retry_saved',
    };
  }
  const custodyKey = custodyMessageFor(code, error);
  if (custodyKey) {
    return {
      disposition: 'env_blocked',
      code: code ?? 'custody_unavailable',
      messageKey: custodyKey,
      primaryAction: 'unlock_custody',
    };
  }
  if (
    code === 'e2ee_identity-lost' ||
    code === 'e2ee_corrupt' ||
    code === 'e2ee_rewrap-failed' ||
    code === 'e2ee_local-history-recovery-required'
  ) {
    return {
      disposition: 'reconcilable',
      code,
      messageKey: 'e2ee.identity.lostHelp',
      primaryAction: 'reset_identity',
    };
  }
  if (
    code === 'e2ee_join_conflict' ||
    code === 'e2ee_conflict' ||
    code === 'e2ee_pairing-tampered'
  ) {
    return {
      disposition: 'reconcilable',
      code,
      messageKey: 'e2ee.actionable.pairingConflict',
      primaryAction: 'restart_pairing',
    };
  }
  return {
    disposition: 'retryable',
    code: code ?? 'e2ee_network_unconfirmed',
    messageKey: 'e2ee.auto.connectionRetry',
    primaryAction: 'retry_saved',
  };
}

export function classifyRevocationFailure(error: unknown): E2eeActionableFailure {
  const code = extractE2eeFailureCode(error);
  if (code === 'e2ee_device_revoked' || code === 'e2ee_member_removed') {
    return {
      disposition: 'reconcilable',
      code,
      messageKey: 'e2ee.actionable.accessLost',
      primaryAction: 'repair_device',
    };
  }
  if (
    code === 'e2ee_unauthorized' ||
    code === 'e2ee_management_unauthorized' ||
    code === 'e2ee_member_unauthorized'
  ) {
    return {
      disposition: 'reconcilable',
      code,
      messageKey: 'e2ee.actionable.permissionChanged',
      primaryAction: 'refresh_state',
    };
  }
  if (code === 'e2ee_conflict' || code === 'e2ee_ledger_stale' || code === 'e2ee_member_conflict') {
    return {
      disposition: 'reconcilable',
      code,
      messageKey: 'e2ee.actionable.adminStateChanged',
      primaryAction: 'refresh_state',
    };
  }
  const custodyKey = custodyMessageFor(code, error);
  if (custodyKey) {
    return {
      disposition: 'env_blocked',
      code: code ?? 'custody_unavailable',
      messageKey: custodyKey,
      primaryAction: 'unlock_custody',
    };
  }
  return {
    disposition: 'retryable',
    code: code ?? 'e2ee_network_unconfirmed',
    messageKey: 'e2ee.actionable.revocationRetry',
    primaryAction: 'retry_saved',
  };
}
