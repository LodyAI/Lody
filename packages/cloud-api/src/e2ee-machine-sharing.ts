import type { E2eeDeviceAccess } from './e2ee-device';

/** Exact resource scope. Hex is lowercase/unpadded: genesis 32 bytes, membership instance 16 bytes. */
export type E2eeMachineSharingScope = {
  workspaceId: string;
  genesisHash: string;
  machineId: string;
  ownerMembershipId: string;
};
/** Digest is lowercase SHA-256 of the complete original encrypted frame, never its plaintext. */
export type E2eeMachineSharingHead = { revision: number; digest: string };
/** A storage-removal barrier, not a signed policy or a verified client pin. Preserve the last committed
 * position even after ciphertext cleanup. Only a never-written resource uses revision 0/digest null. */
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
/** An original version, a barrier for a purged original, or absence. A purged request/version must not
 * become a fresh request or resurrect its ciphertext, including after a later reactivation. */
export type E2eeMachineSharingReadResult =
  | E2eeMachineSharingVersion
  | E2eeMachineSharingRemovedHead
  | null;
/** Account-authenticated display data only. It cannot renew device execution freshness or establish permission. */
export type E2eeMachineSharingLatestForMember =
  | (E2eeMachineSharingVersion & { status: 'active' })
  | E2eeMachineSharingRemovedHead
  | null;
/** Device-authenticated control operations; account login alone is insufficient. Version 1 starts at revision 1/null parent.
 * commit atomically inserts original bytes and CASes head; exact retries return the original receipt even after
 * later commits, or a removal barrier after cleanup. Retain lightweight request intent digests for this check.
 * Reusing requestId with different intent/bytes fails. A confirmed conflict never auto-rebases. Only explicit
 * fresh owner intent may reactivate removed state at n+1 with previousDigest=digest (0/null resumes at 1/null).
 * The separate account read returns only ciphertext/routing metadata, never execution authority. */
export type E2eeMachineSharingRequests = {
  readHead: E2eeDeviceAccess & E2eeMachineSharingScope;
  readVersion: E2eeDeviceAccess & E2eeMachineSharingScope & { revision: number };
  readRequest: E2eeDeviceAccess & E2eeMachineSharingScope & { requestId: string };
  /** Current account workspace membership is checked by the server; no credential or cliToken is accepted. */
  latestForMember: E2eeMachineSharingScope;
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
  readHead: E2eeMachineSharingHeadState | null;
  readVersion: E2eeMachineSharingReadResult;
  readRequest: E2eeMachineSharingReadResult;
  latestForMember: E2eeMachineSharingLatestForMember;
  commit:
    | { status: 'committed'; version: E2eeMachineSharingVersion }
    | { status: 'conflict'; head: E2eeMachineSharingHeadState | null }
    | { status: 'removed'; head: E2eeMachineSharingRemovedHead };
};
