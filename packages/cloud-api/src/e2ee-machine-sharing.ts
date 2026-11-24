import type { E2eeDeviceAccess } from './e2ee-device';

/** Exact resource scope. Hex is lowercase/unpadded: genesis 32 bytes, membership instance 16 bytes. */
export type E2eeMachineSharingScope = {
  workspaceId: string;
  genesisHash: string;
  machineId: string;
  ownerMembershipId: string;
  /** Hex32 initial machine admission signing key; stable only across uninterrupted atomic replacements. */
  generation: string;
};
/** Digest is lowercase SHA-256 of the complete original encrypted frame, never its plaintext. */
export type E2eeMachineSharingHead = { revision: number; digest: string };
/** A storage-removal barrier, not a signed policy or a verified client pin. Preserve the last committed
 * position even after ciphertext cleanup. This generation is terminal and cannot become active again. Only a never-written resource uses revision 0/digest null. */
export type E2eeMachineSharingRemovedHead = E2eeMachineSharingScope & {
  status: 'removed';
} & (E2eeMachineSharingHead | { revision: 0; digest: null });
/** Complete CAS identity. Compare scope, status, revision and digest, including removed-vs-active.
 * Atomic same-member machine replacement preserves active state; removal retains its high water. */
export type E2eeMachineSharingHeadState =
  | (E2eeMachineSharingScope & E2eeMachineSharingHead & { status: 'active' })
  | E2eeMachineSharingRemovedHead;
/** Immutable complete encrypted state. Metadata is untrusted until checked against the decrypted signed body. */
export type E2eeMachineSharingVersion = E2eeMachineSharingScope &
  E2eeMachineSharingHead & {
    previousDigest: string | null;
    requestId: string;
    frameHex: string;
  };
/** An original version, a removal barrier, or a missing/purged original (null). A purged request/version must not
 * become a fresh request or resurrect its ciphertext, including after a later reactivation. */
export type E2eeMachineSharingReadResult =
  | E2eeMachineSharingVersion
  | E2eeMachineSharingRemovedHead
  | null;
/** Device-authenticated control operations; account login alone is insufficient. Each new generation starts at revision 1/null parent.
 * commit atomically inserts original bytes and CASes head; exact retries return the original receipt even after
 * later commits, or a removal barrier after cleanup. Retain lightweight request intent digests for this check.
 * New commits must match the current verified machine generation inside the atomic mutation, in addition
 * to full-head CAS; a removed or superseded generation always conflicts. Exact old receipts may report removed.
 * Reusing requestId with different intent/bytes fails. A confirmed conflict never auto-rebases. Only explicit
 * Removed generations are terminal. Re-admission creates a different generation/resource and fresh owner
 * intent starts its revision 1/null parent; never resume an old generation at n+1 or migrate its pins/grants. */
export type E2eeMachineSharingRequests = {
  /** `includeVersion` asks a backend that supports it to inline the active head's original,
   * saving the separate `readVersion` round trip. Older backends may reject the field;
   * callers then retry without it. */
  readHead: E2eeDeviceAccess & E2eeMachineSharingScope & { includeVersion?: true };
  readVersion: E2eeDeviceAccess & E2eeMachineSharingScope & { revision: number };
  readRequest: E2eeDeviceAccess & E2eeMachineSharingScope & { requestId: string };
  commit: E2eeDeviceAccess &
    E2eeMachineSharingScope & {
      expectedHead: E2eeMachineSharingHeadState | null;
      revision: number;
      previousDigest: string | null;
      /** Lowercase hex16, persisted with the exact original before the first attempt. */
      requestId: string;
      /** Content-v0 doc-update, fixed machine-sharing AAD domain, at most 262287 decoded bytes. */
      frameHex: string;
    };
};
/** A commit acknowledgement is storage evidence only. Clients independently verify every returned head/frame. */
export type E2eeMachineSharingReplies = {
  /** An active head may inline its original (`includeVersion`). Clients verify it exactly as a
   * `readVersion` reply and never persist it as part of the head. */
  readHead:
    | (Extract<E2eeMachineSharingHeadState, { status: 'active' }> & {
        version?: E2eeMachineSharingVersion;
      })
    | E2eeMachineSharingRemovedHead
    | null;
  /** Missing or purged ciphertext may return null; readHead still preserves the removed high water. */
  readVersion: E2eeMachineSharingReadResult;
  readRequest: E2eeMachineSharingReadResult;
  commit:
    | { status: 'committed'; version: E2eeMachineSharingVersion }
    | { status: 'conflict'; head: E2eeMachineSharingHeadState | null }
    | { status: 'removed'; head: E2eeMachineSharingRemovedHead };
};
