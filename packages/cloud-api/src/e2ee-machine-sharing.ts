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
/** Immutable complete encrypted state. Metadata is untrusted until checked against the decrypted signed body. */
export type E2eeMachineSharingVersion = E2eeMachineSharingScope &
  E2eeMachineSharingHead & {
    previousDigest: string | null;
    requestId: string;
    frameHex: string;
  };
/** Device-authenticated operations; account login alone is insufficient. Version 1 starts at revision 1/null parent.
 * commit atomically inserts original bytes and CASes head; exact retries return the original receipt even after
 * later commits. Reusing requestId with different intent/bytes fails. A confirmed conflict never auto-rebases.
 * Reads return originals; they do not confer freshness or execution authority. */
export type E2eeMachineSharingRequests = {
  readHead: E2eeDeviceAccess & E2eeMachineSharingScope;
  readVersion: E2eeDeviceAccess & E2eeMachineSharingScope & { revision: number };
  readRequest: E2eeDeviceAccess & E2eeMachineSharingScope & { requestId: string };
  commit: E2eeDeviceAccess &
    E2eeMachineSharingScope & {
      expectedHead: E2eeMachineSharingHead | null;
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
  readHead: E2eeMachineSharingHead | null;
  readVersion: E2eeMachineSharingVersion | null;
  readRequest: E2eeMachineSharingVersion | null;
  commit:
    | { status: 'committed'; version: E2eeMachineSharingVersion }
    | { status: 'conflict'; head: E2eeMachineSharingHead | null };
};
