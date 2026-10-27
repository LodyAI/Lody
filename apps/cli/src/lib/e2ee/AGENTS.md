# Machine E2EE custody

`CLAUDE.md` is a symlink to this file. Parent CLI rules apply.

- This module is lazy and machine-only. Ordinary CLI startup must not probe the keyring.
- First creation probes a temporary Secret Service / Keychain / Credential Manager entry
  by write/read, then permanently selects os-keystore or file protection. Reopen never probes
  or changes that selection. Missing selector or KEK with existing originals is a failure.
- File protection requires owner-only directories/files, no symlinks; Windows uses actual
  owner/DACL checks through the official process Layer, not Unix mode bits.
- Keep common blob formats in core's node-custody adapter; no personal management operations,
  private exports, plaintext device files, or silent downgrade after keyring errors.
- Display file protection before pairing approval.

- Native keyring calls run in a managed helper: 10-second timeout, secrets only on stdin.
  Confirm termination before fallback; preserve process-release recovery owners.
- Windows batches root/file ACL checks in one process. SQLite selection uses asynchronous
  bounded retry on SQLITE_BUSY, never a blocking busy_timeout while awaiting keyring work.

- Resume interrupted first Windows ACL setup only in an empty custody directory;
  any file requires validation-only open.
- `runtime.ts` composes core's Feed/VerifiedLedger, installed keys and optional receiver.
  Open and local status never call the network. Cloud requests stay in cloud-cli-port.
- Journal original records before feed/pin advancement. Rebase after 64 additional
  records; core advances the pin first. Retired cache cleanup cannot fail local open.
- No plaintext RPC, presence, attachments or scheduled automation may be attached to
  an encrypted workspace while their encrypted channels remain unimplemented.
- `realtime-journal.ts` is storage only; exclusive `create` provisions schema 2.
  No application upgrade/repair/replacement of schema or originals. Native SQLite
  rollback/WAL checkpoint may change physical files before validation, even for
  rejected formats. Reject unknown committed schema before app settings/chmod/writes.
  Requests/responses/first outcomes are immutable; no expiry GC/replay. Bounded
  owners retain permits/failed cleanup. Persist replies before send; local indexes
  select no wire profile. A failed response retains one original per permit for
  byte-identical retry, preserving results. Fence execution AND Meta/history.
  Accepted file-global clock floor can expire new requests across workspaces and
  restarts until time catches up after a bad forward jump. Keep completed evidence
  readable; no floor reset, deadline extension or new time source/recovery generation.
  See [integration proposal](../../../../../.agents/notes/proposed/architecture/2026-10-26-e2ee-realtime-journal.md).
- `prepareCliE2eeMachineLegacy` binds the retained credential hash to the exact
  desktop-generated 16-byte pairing session using core's fixed v1 helper.
  Pairing preparation and activation run only on the OS-user control socket;
  Fleet checks its own account and discovered encrypted workspace/genesis first.
  Activation refreshes the verified ledger and mailbox and acknowledges only an
  installed current key; temporary failure leaves the same pairing retryable.

- M2 content bindings pin their write epoch; an epoch change or rotation-required
  flag latches new sends off while local state remains intact. M3 owns resumption.
- Prepared bindings cannot start content replicas. Activation runs only the native
  ledger/key receiver, verifies a current installed key, closes that temporary owner,
  THEN writes `activation.json`; Fleet may attach rooms. The marker is no authority:
  match genesis/device. Activated workspaces reopen locally offline. Per-workspace
  identical activation intents join; Fleet shutdown drains them before cloud-port close.

- Fleet must not construct/register the PR poller for encrypted workspaces. It owns
  hosted GitHub credential/association ports independently of Lody's cloud-port
  restrictions and would disclose decrypted repository/branch metadata.
- The encrypted Lody cloud port also omits hosted GitHub tokens. SessionManager
  must use host git/gh credentials, without sending decrypted repository names
  through its separately owned credential broker.

- Fleet, Lody and one-shot commands load `workspace-legacy` only inside the
  encrypted branch. Keep native custody/core off the ordinary entry graph; the
  CLI build and its source maps must still fit the fixed 2 GiB build heap.

- Runtime key journals are signing-key-scoped; custody loss cannot reuse old KEK
  blobs. Retain old evidence. A same-genesis hint follows a replacement only after
  verified admission/installation. Pairing waits raise no startup issue/timer or global
  offline state. Activation binds the approved key, drains other identities and retains
  its cleanup retry owner.
- Only activation/binding/device-original ENOENT means pairing wait. Check the
  original before custody init; stale hints cannot trigger keyring probes. Preserve
  other file errors/Fleet retry; never cache transient storage as missing pairing.
- Ingest storage failure fences writes until verified refresh. Healthy readers do
  not reconnect on write retry: next seal coalesces one storage-error refresh.
  Validation/conflict needs explicit normal refresh; seal cannot auto-recover it.

## Local machine pairing

- `pairing-journal.ts` retains immutable frontend/session proofs and admission originals
  before key receipt. Verify full original history and current same-member personal
  authority. New sessions need explicit consent; preserve the original signer, keys and
  credential. Latest-session preflight precedes Fleet ownership changes; late sessions fail.
- Publish preparation ownership before replacement originals, then publish material and
  current identity atomically. A same-scope fresh session can take an unpublished
  creating generation atomically: old creating=-1, new creating=1, no original-byte
  edits. Account/machine/workspace/genesis/member must match; superseded sessions
  cannot publish or retake. Reuse custody originals; surviving old credentials
  forbid device replacement. Ledger-only owners cannot receive keys.
  Same-identity retries keep healthy owners; only identical intents share a flight.
  Local cancellation never guesses remote settlement.
- Trusted OS-user socket only; partial upgrades fail closed. No remote authentication is implied. See the
  [pairing note](../../../../../.agents/notes/proposed/architecture/2026-10-26-e2ee-machine-pairing-journal.md).

## Catalog and Fleet containment

- `local-workspace-catalog.ts`: encrypted discovery belongs in the account/machine-bound
  `workspace-catalog.json.e2ee` sidecar; v1 `workspaces` holds ordinary rows only
  (old schemas discard `contentMode`). One catalog lock covers both durable writes.
  Ordinary-only mutations never rewrite the encrypted slice; old v1 writers cannot
  erase the sidecar or its account/machine-bound `.e2ee-invalid` marker.
- Unreadable sidecars preserve their error in memory and cannot be overwritten;
  ordinary rows remain usable. Persist ordinary remote-list results and return an
  explicit degraded receipt, retaining current authorization/revocation checks.
  Publish `.e2ee-invalid` atomically BEFORE encrypted updates; failed writes/cleanup
  retain it until healthy publication. Derive unavailable from that marker, never
  unknown v1 fields; stale sidecars cannot bootstrap. Fleet reports scoped recoverable
  issues and keeps bounded retries/pending signature until the receipt is healthy.

A same-context `creating=-1` socket reply is `prepare-superseded`; other errors stay
errors. Main archives only the matching all-null unsigned desktop attempt before
fresh consent. Retain CLI originals.
- Never cache an unimplemented content mode (offline startup would read it as
  plaintext); `export` refuses and `sync` skips schedules for encrypted workspaces
  ([note](../../../../../.agents/notes/implemented/bug-fix/2026-10-27-e2ee-cli-review-fixes.md)).
