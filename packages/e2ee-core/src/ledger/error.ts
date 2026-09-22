import type { LedgerErrorCode } from '../pure/errors';
export type { LedgerErrorCode } from '../pure/errors';

export class LedgerError extends Error {
  override readonly name = 'LedgerError';
  constructor(
    readonly code: LedgerErrorCode,
    readonly position?: number
  ) {
    super(position === undefined ? code : `${code}@${position}`);
  }
}

export function fail(code: LedgerErrorCode, position?: number): never {
  throw new LedgerError(code, position);
}
