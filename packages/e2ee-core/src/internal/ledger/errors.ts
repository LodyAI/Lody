import { Data } from 'effect';
import type { ValidationErrorCode } from '../foundation/errors';

/** Why a ledger record or view was rejected. */
export type LedgerErrorCode =
  | ValidationErrorCode
  | 'unknown-version'
  | 'unknown-operation'
  | 'bad-proof'
  | 'unauthorized'
  | 'replay'
  | 'wrong-parent'
  | 'wrong-anchor'
  | 'genesis-mismatch'
  | 'checkpoint-mismatch'
  | 'native-unavailable';
/** Ledger parsing, verification or permission failure; `position` names the failing record when known. */
export class LedgerError extends Data.TaggedError('LedgerError')<{
  readonly code: LedgerErrorCode;
  readonly position?: number;
}> {}
