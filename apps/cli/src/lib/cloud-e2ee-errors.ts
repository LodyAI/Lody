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
