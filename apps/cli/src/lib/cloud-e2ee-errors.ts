/** Created only after the fixed credential endpoint authenticates whole-member removal.
 * Kept local to the CLI; it is not a wire code or a renderer deletion API. */
export class CloudE2eeMemberRemoved extends Error {
  constructor() {
    super('e2ee_member_removed');
    this.name = 'CloudE2eeMemberRemoved';
  }
}

/** SDK token I/O retains the original error as its cause. Never infer deletion
 * from an arbitrary message, HTTP status or ordinary authorization rejection. */
export function isCloudE2eeMemberRemoved(value: unknown): boolean {
  const seen = new Set<unknown>();
  while (value instanceof Error && !seen.has(value)) {
    if (value instanceof CloudE2eeMemberRemoved) return true;
    seen.add(value);
    value = value.cause;
  }
  return false;
}

/** Confirmed revocation of this machine's credential; not whole-member removal. */
export class CloudE2eeDeviceRevoked extends Error {
  constructor() {
    super('e2ee_device_revoked');
    this.name = 'CloudE2eeDeviceRevoked';
  }
}
export function isCloudE2eeDeviceRevoked(value: unknown): boolean {
  const seen = new Set<unknown>();
  while (value instanceof Error && !seen.has(value)) {
    if (value instanceof CloudE2eeDeviceRevoked) return true;
    seen.add(value);
    value = value.cause;
  }
  return false;
}

/** Not sent by the service yet: an expired sign-in currently arrives as an ordinary refusal. */
const SIGN_IN_EXPIRED_CODE = 'e2ee_sign_in_expired';

/** Maps a failed latest ledger read to the outage rule of
 * specs/e2ee/execution-freshness-outage.md. Anything else stays a refusal. */
export function ledgerReadFailure(cause: unknown, httpStatus?: number): unknown {
  if (!(cause instanceof Error)) return cause;
  if (isCloudE2eeMemberRemoved(cause) || isCloudE2eeDeviceRevoked(cause)) return cause;
  if ('data' in cause) {
    const data = cause.data as { code?: unknown } | null | undefined;
    return data?.code === SIGN_IN_EXPIRED_CODE
      ? new CloudE2eeLedgerOutage({ signInExpired: true, cause })
      : cause;
  }
  // A reply the client cannot read: invalid JSON, an unknown envelope or a failed schema.
  if (cause.name === 'ZodError' || cause.name === 'SyntaxError') return cause;
  if (cause.message.startsWith('Invalid response:')) return cause;
  if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429)
    return cause;
  return new CloudE2eeLedgerOutage({ cause });
}

/** The latest ledger read got no answer. It carries no access decision, unlike a refusal.
 * `signInExpired` also asks the user to sign in again. */
export class CloudE2eeLedgerOutage extends Error {
  readonly signInExpired: boolean;
  constructor(options: { signInExpired?: boolean; cause?: unknown } = {}) {
    super('e2ee_ledger_outage', { cause: options.cause });
    this.name = 'CloudE2eeLedgerOutage';
    this.signInExpired = options.signInExpired ?? false;
  }
}
