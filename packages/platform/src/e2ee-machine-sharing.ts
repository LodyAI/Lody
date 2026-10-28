import type { E2eeMachineSharingRequests, E2eeMachineSharingReplies } from '@lody/cloud-api';

/** Host transport contract only; no provider, IPC, storage or network is constructed here.
 * Hosts retain original intent/frame across unknown results and verify returned evidence with e2ee-core.
 * Credentials stay inside trusted host composition; this is not a renderer management capability. */
export interface E2eeMachineSharingTransport {
  /** Authenticated latest-head read; freshness starts before I/O, never from server timestamps. */
  readHead(
    input: E2eeMachineSharingRequests['readHead']
  ): Promise<E2eeMachineSharingReplies['readHead']>;
  /** Read an immutable original; purged ciphertext may return null while readHead retains the removal high water. */
  readVersion(
    input: E2eeMachineSharingRequests['readVersion']
  ): Promise<E2eeMachineSharingReplies['readVersion']>;
  /** Reconcile an unknown commit by its original requestId before any retry; removed originals stay removed. */
  readRequest(
    input: E2eeMachineSharingRequests['readRequest']
  ): Promise<E2eeMachineSharingReplies['readRequest']>;
  /** Publish exact bytes under head CAS; conflicts require explicit new owner intent. */
  commit(input: E2eeMachineSharingRequests['commit']): Promise<E2eeMachineSharingReplies['commit']>;
}

/** Separate account-authenticated display port. No device credential is accepted; only opaque ciphertext and
 * untrusted routing/head metadata are returned. This port cannot renew a machine's execution freshness. */
export interface E2eeMachineSharingDisplayReader {
  /** The server checks current account workspace membership. Clients still verify signatures/ledger before display. */
  latestForMember(
    input: E2eeMachineSharingRequests['latestForMember']
  ): Promise<E2eeMachineSharingReplies['latestForMember']>;
}

export type {
  E2eeMachineSharingScope,
  E2eeMachineSharingHead,
  E2eeMachineSharingHeadState,
  E2eeMachineSharingRemovedHead,
  E2eeMachineSharingReadResult,
  E2eeMachineSharingLatestForMember,
  E2eeMachineSharingVersion,
  E2eeMachineSharingRequests,
  E2eeMachineSharingReplies,
} from '@lody/cloud-api';

/** Verified host view for switch UI. No credential, keys or generic signing capability. */
export interface E2eeMachineSharingView {
  machineId: string;
  ownerMembershipId: string;
  /** Ledger-qualified initial admission key; changes on removal/readmission. */
  generation: string;
  head: { readonly revision: number; readonly digest: string } | null;
  sharedWithTeam: boolean;
  projects: readonly string[];
  removed?: boolean;
  /** Discover an interrupted local intent so a new window can reconcile the same request. */
  pendingRequest?: { requestId: string; change: E2eeMachineSharingChange };
  /** Pending intent is retained, but no latest policy was verified by this read. */
  unavailable?: true;
}
export type E2eeMachineSharingWriteResult = {
  status: 'saved' | 'pending' | 'conflict' | 'removed';
  requestId: string;
};
export type E2eeMachineSharingChange =
  | { readonly kind: 'machine'; readonly sharedWithTeam: boolean }
  | { readonly kind: 'project'; readonly localProjectId: string; readonly sharedWithTeam: boolean };
