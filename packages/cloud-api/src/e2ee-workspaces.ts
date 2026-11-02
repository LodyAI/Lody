/** Persisted workspace mode. Missing/unknown descriptors must fail closed. */
export type WorkspaceModeDescriptor =
  | { workspaceId: string; contentMode: 'plaintext'; contentModeVersion: 1 }
  | {
      workspaceId: string;
      contentMode: 'e2ee';
      contentModeVersion: 1;
      /** Canonical lowercase genesis hash; the crypto namespace is genesis-bound. */
      cryptoOrgId: string;
      genesisHash: string;
      /** This first integration only supports creation and ledger inspection. */
      activation: 'control-only';
    };

/**
 * Explicit compatibility admission for a live legacy row with no persisted mode
 * or E2EE evidence. This is not verified plaintext classification. A local genesis
 * pin must reject this admission; unknown/partial descriptors never use it.
 */
export type WorkspaceAdmissionDescriptor =
  | WorkspaceModeDescriptor
  | { workspaceId: string; admission: 'legacy-unclassified' };

/** Exact durable request: retries must preserve every field and original signed bytes. */
export type E2eeWorkspaceCreateRequest = {
  /** Expected authenticated account owning the prepared local identity; server checks equality. */
  accountId: string;
  name: string;
  slug: string;
  requestId: string;
  /** Canonical signed CBOR genesis, lowercase hexadecimal. Never secret key material. */
  genesisRecordHex: string;
  /** SHA-256 of the 32 raw credential bytes. */
  deviceCredentialHash: string;
  developerMode: true;
};

export type E2eeWorkspaceCreateResult = Extract<
  WorkspaceModeDescriptor,
  { contentMode: 'e2ee' }
> & { name: string; slug: string };

/** A server-advertised history boundary, not a trusted cryptographic checkpoint. */
export type E2eeLedgerCheckpoint = { headHash: string; length: number };

export type E2eeWorkspaceHistoryRequest = {
  workspaceId: string;
  /** CLI identity supplements account authentication, never ledger authority. */
  cliToken?: string;
  credential?: string;
  /** Opaque nextCursor from the previous page; omit on the first page. */
  cursor?: string;
  /** Endpoint-independent position from an earlier response; mutually exclusive with cursor. */
  after?: string;
  /** Keep the first page's boundary unchanged on every subsequent page. */
  checkpoint?: E2eeLedgerCheckpoint;
};

/** Raw records in ledger order. Verify against a locally pinned genesis before trusting. */
export type E2eeWorkspaceHistoryPage = {
  workspaceId: string;
  genesisHash: string;
  checkpoint: E2eeLedgerCheckpoint;
  startIndex: number;
  recordsHex: string[];
  /** Opaque position after the last returned record, also present at an empty suffix; usable as after at a newer endpoint. */
  position: string;
  /** null means every record through checkpoint.length has been returned. */
  nextCursor: string | null;
};

/** Account directory labels only; these never establish ledger membership or key trust. */
export type E2eeWorkspaceMemberProfilesRequest = { workspaceId: string };
export type E2eeWorkspaceMemberProfiles = {
  workspaceId: string;
  profiles: { cryptoUserId: string; name: string | null; image: string | null }[];
};
