# Personal cloud client composition

`CLAUDE.md` is a symlink to this file. Root rules apply.

- This package owns the shared authenticated network DTO adapters and IndexedDB
  composition for Web and mobile. Public cryptography, verification, custody
  contracts, writer coordination and workflows remain in the core and client packages.
- `personalCloudHostPorts` constructs only lazy Layers. The application owns
  acquisition, executors, retained incomplete-close owners and final retirement.
  Required `drainOld` must settle all overlapping old readers; never supply a
  product no-op or add a global gate that blocks independent bindings.
- Wrappers select a fixed `web` or `mobile` namespace. Web names preserve the
  original `lody-e2ee:web:v1:` format. Never take a namespace from preferences,
  recovery state or server input to bypass an existing identity. Missing keys or
  unknown installation state require the public recovery/desktop approval path.
- The shared factory owns ledger/pins, installation/approval/pairing originals,
  submission partitions, key journals, RPC originals, Web Locks and cloud grants.
  Wrappers inject only `protection` and the public custody Layer contract, keeping
  the account/workspace/genesis checks and exact original retry behavior intact.
- An approved incarnation's submission partition may first be created on a later
  app launch. Its control store uses `create-or-open`; ledger and custody main
  databases retain the caller's mode, and opening never creates a new identity.
- Web owns its deployment rollout; mobile owns native capability/version gating,
  OS custody and its application owner. Neither platform imports the other app.
  Machine sharing is the shared `@lody/e2ee-machine-sharing` host, never a fabricated
  capability: core verifies policy signatures, pins and generations as on desktop. Its
  IndexedDB store is named per installation under the fixed namespace, its transport is
  the device-authenticated relay, and generations come only from local ledger originals.
- Tests use synthetic identities and intercepted I/O.

- `personalEntry` is the sole application registry. Keep its Scope, executor
  dependency and complete incomplete-close owners until actual retirement; factory
  calls stay synchronous and acquire nothing during React render.
- Creation uses a private `creation-<requestId>` routing scope in native custody,
  never the final workspace ID before the server names it. `recordCreated` rewraps
  the same device/epoch material into the real workspace binding, writes the
  initial request and approval originals, and only then marks the entry pin ready.
  Retrying the same intent never signs a second genesis.
- Entry pins route an exact desktop offer; they grant no approval. Never clear a
  ready/pending pin to bypass replacement or missing native protection.
- Access loss (`e2ee_device_revoked`/`e2ee_member_removed`, exact plain messages) comes
  only from an `E2eeAccessRefusal` (credential-bound call, account unchanged), the runtime's
  verified-ledger `revoked` or its exact plain `Error(code)` rejection, or a status without
  this device. It needs a definite same-account
  session and this exact ready/cancelled pin; it then cancels that pin (offer and genesis kept)
  and retires the entry. A credential `e2ee_device_revoked` history read retries once under
  the account login so the signed revocation still verifies. Every cloud call is bounded by
  30 s as retryable `unavailable`; a timeout is never access loss. Only gateway 502/503/504 retry twice within that bound, using Effect sleep and account guards.
- Content calls snapshot the complete caller DTO before lazy account/pin I/O.
  Seal owns cleanup of its plaintext copy even if admission or the executor fails.
  Public runtime copies retain their own native-call lifetime; never wipe borrowed
  buffers early or move capture behind host acquisition.

- Account pairing maps a named `workspace` to its `workspaceId` only after it matches the
  requester list's ID and genesis (`pairing-tampered` otherwise), and cancellation keeps
  its `expectedLookupId`. The relay parses the backend's exact reply DTOs; as on desktop, only
  `e2ee_account_pairing_{disabled,rate_limited}` become typed `pairing-*` codes; all else
  stays retryable. The approver offers every `ready` pin of the account (`listReady`),
  opening unopened ones on demand; display names are best effort. Requester methods
  exist only when the host passes `requester`.
- Every approval session, from the facade or the approver, comes from `approvalSession`:
  acquiring it and each of its operations pass `project`, and the open and each refresh
  apply the status rule, so exact loss retires that pin. That rule also counts the public
  runtime's exact loss refusal of `status` (via `failureLoss`); any other status failure
  proves nothing. The approver skips a workspace whose session fails instead of
  failing the list.
- Hosts build pairing cloud ports with `makePersonalCloudAccountPairingPorts`, which fences
  each call on a signed-in account and bounds it. `personalEntry` bounds append, list and
  history again on its executor's clock, since one unanswered call blocks every later
  serial pairing operation. A timeout is retryable, never access loss.

- Forward `irohReady`, `irohCall` and `irohPath` only when the wrapper passes `iroh`.
  Hosts without the port keep encrypted Streams RPC. `irohPath` must reach the
  existing portable session without opening an endpoint. See [transport composition](README.md#transport-composition).

- `personalEntryRecovery` borrows the same registry/runtime as content. It exposes
  only setup/restore commands, releases only its own setup reader and marks pins
  ready only after a verified committed restore that installed the current epoch key;
  it never creates a second host. A partial restore leaves the pin unready and its
  journal partial, so the plan keeps offering the restore. A restore never routes to a
  cancelled pin's offer. Exact loss of a retained identity during restore cancels its
  pin, and the engine retries once with the account offer so the host replaces it.
- `makeClientRecovery` and `makeRecoveryWorkspaces` bound remote Convex RPCs at 90 s
  (leaving file/passkey ceremonies uncapped) so a dead WebSocket releases `commands`
  and `active`. `makeRecoveryWorkspaces` unlocks the vault once for the selected
  workspaces and reports each separately. Only a
  committed, verified setup is recoverable. A timed-out 30 s wait is unconfirmed: it
  does not cancel the producer, journal, or submission. The pin database is
  `lody-e2ee:<platform>:v1:entry-pins` from the caller's fixed `web` or `mobile`
  platform, never from preferences or server input. Wrappers inject passkey and
  commands. Secrets keep their existing wipe paths; this engine adds no persistence.
- Recovery files carry and require the signed-in site's `recoveryServiceLocator`. Web may
  default to its HTTP(S) page origin; other wrappers pass the site URL, never an account ID
  or backend URL. No locator refuses as `disabled`.
- `recoveryWorkspacesPort` serves the console's recovery port from that engine. It picks
  the file before any await, wipes it after the command, returns outcomes only, and
  answers once each workspace has a result, `Unconfirmed` included. Restore rows carry
  workspace IDs and partial key markers and stream to `onResult` until the call returns
  or its observation signal aborts.

- Account pairing and recovery history use the same bounded public-history DTO
  projection as ordinary history reads. Strip backend advisory fields at the network boundary
  before passing pages to the portable host, whose strict capture, signature,
  scope and checkpoint verification stay unchanged.
  Ledger append skips genesis prefetch; backend verification and parent-tail CAS remain authoritative.
  Only the backend's `e2ee_self_service_rate_limited` refusal with a non-negative integer
  `retryAt` becomes core's `self-service-rate-limited` ledger reason; every other append
  failure, including that code without a valid `retryAt`, stays an unconfirmed outcome.
  Inline history is single-use, scoped to this ledger/account and the next feed position. Bootstrap requires a decoded genesis matching the scope hash.
  Otherwise read history; LedgerFeed verifies and persists originals before advancing.

- Staging reads project committed epoch locators with `ownEpochStagedGroupKey`
  before Convex serialization. The locator's signing-key object stays local;
  only genesis, epoch, commitment and recordHash belong on the wire.
