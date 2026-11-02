import { Data } from 'effect';
import type { ValidationErrorCode } from '../foundation/errors';

/** Why a ledger record or view was rejected. */
export type LedgerErrorCode =
  | ValidationErrorCode
  | 'unknown-version'
  | 'unknown-operation'
  /** A well-formed, authorized capability declaration this client does not support. */
  | 'upgrade-required'
  | 'bad-proof'
  | 'unauthorized'
  | 'replay'
  | 'wrong-parent'
  | 'wrong-anchor'
  | 'genesis-mismatch'
  | 'checkpoint-mismatch'
  /** Restored retained-state bytes do not hash to the `stateDigest` stored with them. */
  | 'state-digest-mismatch'
  | 'native-unavailable';
/** Ledger parsing, verification or permission failure; `position` names the failing record when known. */
export class LedgerError extends Data.TaggedError('LedgerError')<{
  readonly code: LedgerErrorCode;
  readonly position?: number;
}> {}
