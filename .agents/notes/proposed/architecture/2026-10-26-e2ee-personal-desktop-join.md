# Personal desktop pairing and signed ledger snapshot joining

Status: proposed
Translation: current

[中文](2026-10-26-e2ee-personal-desktop-join.zh.md)

## Abstract

An additional desktop could not open a workspace because the host only reopened its own creation journal. This change adds an independently pinned invitation origin, reuses core admission and signed snapshots, and keeps keys in the native host. A small authenticated join mailbox relays immutable public evidence; it grants neither membership nor keys. Current scope is another desktop for the same Owner/Admin member, with explicit approval, exact retries and an optional full-ledger audit. Packaged two-device and real keystore/cloud acceptance remain outstanding.

The [account-wide pairing proposal](2026-11-01-e2ee-account-personal-pairing.md) would replace the direct pin transfer with a scanned or pasted one-time pairing string that authenticates the request, and one approval for all of the account's workspaces; it was approved on 2026-11-01, and until it is implemented this explicit exchange remains the implemented path.

## Responsibility and trust

The existing desktop transfers workspace/genesis, endorser public key, membership and pairing session directly. The recipient validates the genesis and stores those pins independently of the relay, creates a protected personal identity and credential, and signs the existing core possession and credential binding formats. Changing sessions after terminal settlement preserves identity, credential and independent pins.

The approving host verifies possession/binding, fixes the entire request before presenting its public key, and only signs on explicit approval. Its durable journal fixes the admission and requestId before HTTP. A relay substitution after preview is rejected. The backend atomically orders cancellation against writer reservation; admitting means uncertain until original-byte recovery proves committed or conflicted. Cancellation and proven lost-CAS retirement preserve originals. An unresolved signed request cannot be silently reset.

After verified admission the approving host fixes a signed snapshot invitation and publishes it. The relay authenticates a current Owner/Admin personal publisher using device credentials and projections, bounds/immutably chunks opaque bytes, and lets the same account claim before having a usable device credential. It performs no signature verification. The recipient uses its own saved endorser pin, checks its personal admission and key/credential binding, then installs the snapshot origin. A malformed snapshot or suffix never advances pins or cursors.

```mermaid
sequenceDiagram
    participant A as Existing desktop host
    participant B as Joining desktop host
    participant C as Cloud relay
    A->>B: Direct transfer of genesis and endorser pins
    B->>C: Immutable signed request
    C->>A: Original request bytes
    A->>A: Verify, persist preview, explicit approval, journal
    A->>C: Exact admission and requestId
    C->>C: Cancel/reserve atomically; original-byte CAS/recovery
    A->>C: Signed snapshot after verified admission
    C->>B: Immutable invitation; login and session
    B->>B: Verify pins, self admission and suffix
    A->>B: Current epoch envelope via existing mailbox
    B->>B: Verify epoch history chain and install old keys
```

## Storage, lifecycle and recovery

After a failed begin, the recipient can discover the saved session, including a pin whose request preparation has not finished, and explicitly retry only that original offer. The approving desktop can cancel a pending offer through the existing relay reservation fence. Both sides reconcile an explicit terminal cancelled/conflict response before archival. A recipient whose saved request differs from the complete immutable relay request can also archive its own losing attempt: compare the original request bytes, signing key and credential hash after checking account, workspace, genesis and session. This preserves the device, credential, originals and independent pins while allowing a new offer. If only the local pin was saved, a complete relay request for that account/workspace/genesis/session necessarily belongs to another attempt: this host saves its request before begin can publish it. Archive the pin-only attempt without changing custody; if no relay session exists, retain the pin and retry the same offer. A generic conflict error, timeout or admitting state for the same request never retires an original. Approver cleanup touches a recipient journal only when that exact local session is still pending; an installed snapshot origin remains intact. Genuine cleanup failures retain the primary cause alongside their own causes. Confirmed cancellation remains successful if local archival fails: journals retain the original and the host retains the diagnostic, and the next claim, preparation or offer query can retry the affected cleanup. Reopening the window discovers the same local intent.

Storage failures retain their original native cause in one main-only diagnostic slot before public error conversion. Raw causes are never attached to IPC errors or generic telemetry.

The account bootstrap journal retains public requests/invitations and protected identity/credential bindings. Runtime creation data now selects a local genesis origin or a qualified invitation; it does not manufacture an epoch-zero key for a joining device. Snapshot-origin cache rebuilding starts from the saved invitation and genuine suffix; conflicting independent evidence remains blocking. Key distribution and HTTP stay outside account custody locks. Workspace operations hold their existing owner/reader fences; logout and close keep native settlement ownership.

Current keys come through KeyMailbox and old keys through InstalledEpochHistory. Historical keys are never fetched from staging. The invitation wire wrapper is bounded JSON encoded as UTF-8 hex with canonical base64 snapshot bytes; it does not change core snapshot/signature formats. The cloud limit is 6 MiB ASCII hex; chunk rows stay below document limits, and erase drains bounded chunk batches before retiring identities.

The UI displays sparse original records at absolute positions; it does not invent missing events or claim prefix comparison without originals. Explicit full replay verifies a caller-selected endpoint and matches its state digest, displaying progress. It writes no pin, runtime or sync cursor; cancellation ignores late results and the next explicit attempt remains usable.

## Alternatives and limits

Replaying the complete ledger on every join would discard the established endorsed-snapshot contract and add unnecessary work. Copying Lab storage or the old vault branch would reintroduce server verification and obsolete APIs. This implementation uses existing core workflows and keeps the private mailbox independent of content CRDT snapshots.

Same-account Owner/Admin joining is the implemented slice. Member management endorsement, remote CLI pairing, revocation/staging and the epoch restart barrier are separate work. Ordinary workspaces keep their existing paths. No deployment, pointer adoption, production enablement or Spec approval is implied. Real keystores, installed-app restart, two physical desktops, cloud gateways and all-platform acceptance remain unverified.

## Verification

Behavior suites use synthetic authenticated custody and real crypto/SQLite, including separate host reopen, exact retries, snapshot and suffix rejection, current-key delivery, old-epoch history, consent substitution and terminal-session recovery. Relay tests exercise real handlers and a Streams peer, including cancellation/CAS conflict and bounded erasure. Additional UI/client tests cover explicit approval, lost acknowledgements, immutable bytes, size limits, audit cancellation and recovery. Final exact-tree check results are recorded in the PR.
