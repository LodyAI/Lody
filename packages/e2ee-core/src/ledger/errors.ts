import { Data } from 'effect';
import type { ValidationErrorCode } from '../errors';

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
  | 'checkpoint-mismatch';
export class LedgerError extends Data.TaggedError('LedgerError')<{
  readonly code: LedgerErrorCode;
  readonly position?: number;
}> {}
