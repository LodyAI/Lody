export type LedgerErrorCode =
  | 'canonical'
  | 'truncated'
  | 'trailing'
  | 'oversize'
  | 'nesting'
  | 'unknown-version'
  | 'unknown-operation'
  | 'bad-signature'
  | 'bad-proof'
  | 'invalid-key'
  | 'unauthorized'
  | 'replay'
  | 'wrong-parent'
  | 'wrong-anchor'
  | 'genesis-mismatch'
  | 'owner-transfer-unconfirmed'
  | 'invalid-operation';

export class LedgerError extends Error {
  readonly name = 'LedgerError';
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
