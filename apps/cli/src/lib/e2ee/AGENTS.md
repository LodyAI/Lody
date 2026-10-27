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
- A future machine pairing flow must display file protection before the user approves it.

- Native keyring calls run in a managed helper: 10-second timeout, secrets only on stdin.
  Confirm termination before fallback; preserve process-release recovery owners.
- Windows batches root/file ACL checks in one process. SQLite selection uses asynchronous
  bounded retry on SQLITE_BUSY, never a blocking busy_timeout while awaiting keyring work.

- An interrupted first Windows ACL setup can resume only while the custody directory
  is completely empty. Any existing file makes this a validation-only open.
- `runtime.ts` composes core's Feed/VerifiedLedger, installed keys and optional receiver.
  Open and local status never call the network. Cloud requests stay in cloud-cli-port.
- Journal original records before feed/pin advancement. Rebase after 64 additional
  records; core advances the pin first. Retired cache cleanup cannot fail local open.
- No plaintext RPC, presence, attachments or scheduled automation may be attached to
  an encrypted workspace while their encrypted channels remain unimplemented.
- `prepareCliE2eeMachineLegacy` binds the retained credential hash to the exact
  desktop-generated 16-byte pairing session using core's fixed v1 helper.
  Pairing preparation and activation run only on the OS-user control socket;
  Fleet checks its own account and discovered encrypted workspace/genesis first.
  Activation refreshes the verified ledger and mailbox and acknowledges only an
  installed current key; temporary failure leaves the same pairing retryable.

- M2 content bindings pin their write epoch; an epoch change or rotation-required
  flag latches new sends off while local state remains intact. M3 owns resumption.
- A prepared binding alone cannot start a content replica. Activation first runs
  only the native ledger/key receiver, checks a verified current key, closes that
  temporary owner, then writes `activation.json`. Fleet can now attach rooms.
  The marker grants no authority and is checked against genesis/device identity;
  existing activated workspaces can reopen locally without network. Identical concurrent
  activation intents join per workspace, and Fleet shutdown drains them before
  closing its cloud port.

- Fleet must not construct/register the PR poller for encrypted workspaces. It owns
  hosted GitHub credential/association ports independently of Lody's cloud-port
  restrictions and would disclose decrypted repository/branch metadata.
- The encrypted Lody cloud port also omits hosted GitHub tokens. SessionManager
  must use host git/gh credentials, without sending decrypted repository names
  through its separately owned credential broker.

- Fleet, Lody and one-shot commands load `workspace-legacy` only inside the
  encrypted branch. Keep native custody/core off the ordinary entry graph; the
  CLI build and its source maps must still fit the fixed 2 GiB build heap.

- Keep runtime key journals under the signing public key, so custody loss cannot reuse old KEK blobs. Retain old evidence. A same-genesis activation hint may follow a replacement key only after verified admission and installation; waiting for pairing is normal, without startup issue/timer or global offline status. Activation binds the approved key and drains a different live identity; retained cleanup uses its retry owner.
- Only ENOENT opening an activation/binding file or the machine device original means waiting for pairing. Check the original before initializing custody; a stale activation hint cannot justify a new keyring probe. Other file-open failures retain their original error and Fleet retry; never cache transient storage failures as missing pairing.
- A ledger ingest storage failure fences writes until a successful verified refresh. Streams write retries do not reconnect healthy readers, so the next seal coalesces one refresh for that storage failure. Validation/conflict failures stay fenced until an explicit normal refresh succeeds; do not auto-recover them through seal.

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

- `local-workspace-catalog.ts` keeps encrypted discovery in the account/machine-bound
  `workspace-catalog.json.e2ee` sidecar. The released v1 catalog's `workspaces`
  array contains ordinary workspaces only: older CLI schemas discard `contentMode`
  and would otherwise start an encrypted workspace as plaintext. Keep one catalog
  lock around both durable writes; old ordinary-catalog rewrites cannot erase the sidecar.
  An unreadable sidecar leaves ordinary rows available, retains the original error
  in the in-memory snapshot, and cannot be overwritten. Ordinary-only mutations
  never rewrite the encrypted slice; Fleet reports only a scoped recoverable issue.
  Remote-list reconciliation returns an explicit degraded cache receipt after
  persisting ordinary rows, so current remote authorization and revocations still
  apply. Publish the account/machine-bound `workspace-catalog.json.e2ee-invalid`
  marker atomically before updating the encrypted slice; old v1 writers cannot
  erase it. Keep it through failed writes and cleanup until healthy publication
  clears it. The in-memory unavailable flag derives from this marker, never from
  an unknown field in the ordinary v1 file; stale sidecar rows cannot bootstrap.
  Fleet retains its bounded retry and pending signature until that receipt is healthy.

A precise same-context `creating=-1` reply is `prepare-superseded` on the same-user socket. Other failures stay failures. Main may archive only the matching all-null unsigned desktop attempt before fresh consent; CLI originals remain retained.
