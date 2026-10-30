import { E2eeHistoryError, type VerifiedLedgerHistory } from './e2ee-ledger-history';
import {
  E2eeLocalEvidenceConflictError,
  E2eeLocalEvidenceCorruptError,
} from './e2ee-workspace-storage';
import { collectClientBuildInfo } from './client-build-info';
import {
  E2eeAccountUnavailableError,
  E2eeClientUpgradeRequiredError,
} from '../providers/cloud-e2ee-workspaces';

/** What stopped the encrypted workspace control page, and so which recovery is safe.
 * - `identity-conflict`: this device's creation pin or known mode disagrees with the
 *   server. Never resettable from the client; support must investigate.
 * - `progress-conflict`: the server history no longer contains what this device last
 *   verified (rollback or fork). Resettable only after support confirms the server.
 * - `local-corrupt`: an unreadable optional cache; deleting it is safe. */
export type E2eeControlFailureKind =
  | 'approval-required'
  | 'local-identity'
  | 'custody-locked'
  | 'custody-indeterminate'
  | 'custody-unavailable'
  | 'network'
  | 'auth'
  | 'server'
  | 'mode'
  | 'upgrade'
  | 'identity-conflict'
  | 'progress-conflict'
  | 'local-corrupt';

/** Content-free custody guidance shared by opening and pairing surfaces. */
export const custodyFailureMessages = {
  'custody-locked': 'e2ee.custody.locked.help',
  'custody-indeterminate': 'e2ee.custody.indeterminate.help',
  'custody-unavailable': 'e2ee.custody.unavailable.help',
} as const;
export function custodyFailureMessage(kind: E2eeControlFailureKind): string | undefined {
  return kind in custodyFailureMessages
    ? custodyFailureMessages[kind as keyof typeof custodyFailureMessages]
    : undefined;
}

/** Project only the portable host's single typed failure, never a mixed cleanup cause. */
export function personalHostFailureCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if (!('_tag' in error) || error._tag !== 'PersonalHostError') return undefined;
  return 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

export interface E2eeControlFailure {
  kind: E2eeControlFailureKind;
  code: string;
  position?: number;
}

const identityConflicts = new Set([
  'Genesis pin changed',
  'Workspace identity must be checked again',
  'Workspace mode conflicts with encrypted evidence',
  'Immutable workspace mode changed',
  'Legacy workspace cannot become encrypted',
]);

const stickyCorruption = new Set(['Invalid genesis pin', 'Invalid encrypted evidence']);

function serverCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('data' in error)) return null;
  const data = (error as { data?: unknown }).data;
  return typeof data === 'object' &&
    data !== null &&
    'code' in data &&
    typeof data.code === 'string'
    ? data.code
    : null;
}

/** Classify a control-page failure. Unknown errors are treated as transport failures. */
export function classifyE2eeControlFailure(error: unknown): E2eeControlFailure {
  // Inspect only a direct typed custody failure. A mixed close/operation Cause
  // retains its owner and cannot be flattened into a recoverable display hint.
  if (
    typeof error === 'object' &&
    error !== null &&
    '_tag' in error &&
    error._tag === 'ClientCustodyError' &&
    'reason' in error
  ) {
    const reason = error.reason;
    if (reason === 'identity-lost') return { kind: 'approval-required', code: reason };
    if (reason === 'corrupt') return { kind: 'custody-indeterminate', code: reason };
    if (reason === 'locked' || reason === 'indeterminate' || reason === 'unavailable')
      return { kind: `custody-${reason}`, code: reason };
  }
  const portable = personalHostFailureCode(error);
  if (portable === 'identity-lost' || portable === 'approval-required')
    return { kind: 'approval-required', code: portable };
  const message = error instanceof Error ? error.message : '';
  if (message.includes('e2ee_local-evidence-conflict'))
    return { kind: 'progress-conflict', code: 'local-evidence-conflict' };
  if (message.includes('e2ee_genesis_conflict') || message.includes('e2ee_conflict'))
    return { kind: 'identity-conflict', code: 'pin-mismatch' };
  const local =
    /\be2ee_(permissions|identity-lost|corrupt|missing-binding|rewrap-failed|custody_unavailable|identity-busy|local-history-recovery-required|trusted-pin-unavailable|restart-required)\b/.exec(
      message
    );
  if (local) return { kind: 'local-identity', code: `e2ee_${local[1]}` };

  if (error instanceof E2eeHistoryError) {
    if (error.kind === 'local-conflict')
      return {
        kind: error.code === 'pin-mismatch' ? 'identity-conflict' : 'progress-conflict',
        code: error.code,
      };
    return { kind: 'server', code: error.code, position: error.position };
  }
  if (error instanceof E2eeLocalEvidenceConflictError)
    return {
      kind: identityConflicts.has(error.message) ? 'identity-conflict' : 'progress-conflict',
      code: error.message,
    };
  if (error instanceof E2eeLocalEvidenceCorruptError)
    // Unreadable sticky identity evidence is not a cache; deleting it would allow a downgrade.
    return {
      kind: stickyCorruption.has(error.message) ? 'identity-conflict' : 'local-corrupt',
      code: error.message,
    };
  if (error instanceof E2eeClientUpgradeRequiredError)
    return { kind: 'upgrade', code: error.message };
  if (
    error instanceof E2eeAccountUnavailableError ||
    (error instanceof Error && error.message === 'e2ee_account_changed')
  )
    return { kind: 'auth', code: error.message };
  if (error instanceof Error && error.message === 'Not an encrypted workspace')
    return { kind: 'mode', code: 'not-encrypted' };
  if (error instanceof Error && error.message === 'e2ee_workspace_mode_unavailable')
    return { kind: 'mode', code: error.message };
  if (error instanceof Error && error.message.startsWith('e2ee_'))
    return { kind: 'server', code: error.message };
  const code = serverCode(error);
  if (code) return { kind: 'server', code };
  return { kind: 'network', code: error instanceof Error ? error.name : typeof error };
}

/** Support bundle: public identifiers, hashes, counts and error codes only. It never
 * contains account IDs, keys, signatures or record bodies. */
export function e2eeControlDiagnostics(input: {
  workspaceId: string;
  genesisHash?: string;
  localPin: string | null;
  observed: { length: number; headHash: string } | null;
  history: VerifiedLedgerHistory | null;
  failure: E2eeControlFailure | null;
  now?: Date;
}): string {
  return JSON.stringify(
    {
      kind: 'lody-e2ee-workspace-diagnostics',
      version: 1,
      capturedAt: (input.now ?? new Date()).toISOString(),
      client: collectClientBuildInfo(),
      workspaceId: input.workspaceId,
      genesisHash: input.genesisHash ?? null,
      localPin: input.localPin,
      observed: input.observed && {
        length: input.observed.length,
        headHash: input.observed.headHash,
      },
      server: input.history && {
        checkpoint: input.history.page.checkpoint,
        verifiedLength: input.history.view.length,
        upgradeRequiredAt: input.history.upgradeRequiredAt ?? null,
        complete: input.history.page.nextCursor === null,
      },
      failure: input.failure,
    },
    null,
    2
  );
}
