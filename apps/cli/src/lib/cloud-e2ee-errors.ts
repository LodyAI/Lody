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

/** Node's codes for a connection lost while a response body was still arriving. */
const SOCKET_FAILURE_CODES = new Set([
  'UND_ERR_SOCKET',
  'UND_ERR_BODY_TIMEOUT',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
]);

function isTransportInterruption(cause: Error): boolean {
  const seen = new Set<unknown>();
  let value: unknown = cause;
  while (value instanceof Error && !seen.has(value)) {
    if (value.name === 'TimeoutError' || value.name === 'AbortError') return true;
    if ('code' in value && SOCKET_FAILURE_CODES.has(value.code as string)) return true;
    seen.add(value);
    value = value.cause;
  }
  return false;
}

/** A proxy or gateway reply can carry a refusal in its body, which the SDK reduces to a message. */
const REFUSAL_TEXT = /e2ee_[a-z_]+|\bunauthori[sz]ed\b|\bforbidden\b|\brevoked\b|\bremoved\b/i;

/** Maps a failed latest ledger read to the outage rule of
 * specs/e2ee/execution-freshness-outage.md. `httpStatus` is absent when no response arrived.
 * Only a confirmed transport failure is an outage; anything else stays a refusal. */
export function ledgerReadFailure(cause: unknown, httpStatus?: number): unknown {
  if (!(cause instanceof Error)) return cause;
  if (isCloudE2eeMemberRemoved(cause) || isCloudE2eeDeviceRevoked(cause)) return cause;
  if ('data' in cause) return cause;
  if (httpStatus === undefined) return new CloudE2eeLedgerOutage({ cause });
  // A refusal already received stands, even if its body was then cut off.
  if (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429) return cause;
  if (isTransportInterruption(cause)) return new CloudE2eeLedgerOutage({ cause });
  const failedUpstream = httpStatus >= 500 || httpStatus === 429;
  return failedUpstream && cause.name === 'Error' && !REFUSAL_TEXT.test(cause.message)
    ? new CloudE2eeLedgerOutage({ cause })
    : cause;
}

/** The latest ledger read got no answer. It carries no access decision, unlike a refusal. */
export class CloudE2eeLedgerOutage extends Error {
  constructor(options: { cause?: unknown } = {}) {
    super('e2ee_ledger_outage', { cause: options.cause });
    this.name = 'CloudE2eeLedgerOutage';
  }
}
