# Machine E2EE custody

`CLAUDE.md` is a symlink to this file. Parent CLI rules apply.

- Lazy, machine-only module: ordinary CLI startup never probes the keyring.
- First creation write/read-probes a temporary OS keystore entry and permanently selects
  os-keystore or file protection. Reopen never probes/changes selection; originals require
  their selector and KEK.
- File protection requires owner-only directories/files, no symlinks; Windows uses actual
  owner/DACL checks through the official process Layer, not Unix mode bits.
- Blob formats belong in core node-custody. No personal management, private exports,
  plaintext device files or silent downgrade after keyring errors.
- Display file protection before pairing approval.

- Native keyring calls run in a managed helper: 10-second timeout, secrets only on stdin.
  Confirm termination before fallback; preserve process-release recovery owners.
- Batch Windows root/file ACL checks in one process. SQLite selection retries SQLITE_BUSY
  asynchronously with a bound; no blocking busy_timeout while awaiting keyring work.

- Resume first Windows ACL setup only in an empty custody directory; otherwise validate only.
- `runtime.ts` composes Feed/VerifiedLedger, installed keys and optional receiver.
  Open/status are offline; cloud requests stay in cloud-cli-port.
- Journal originals before feed/pin advancement. Rebase after 64 more records, core pin
  first. Retired cache cleanup cannot fail local open.
- No plaintext RPC, presence, attachments or scheduled automation on encrypted workspaces
  while their encrypted channels remain unimplemented.
- `realtime-journal.ts` is storage only; exclusive `create` provisions schema 2.
  Never upgrade/repair/replace schema or originals. Reject unknown committed schema
  before app settings/chmod/writes; native SQLite recovery may precede validation.
  Immutable requests/responses/first outcomes; no expiry GC/replay. Bound owners retaining
  permits/failed cleanup. Persist replies before send; indexes select no wire profile.
  Failed responses retain one original/permit for exact retry and preserve results.
  Fence execution AND Meta/history.
  Preserve the file-global clock floor across workspaces/restarts and readable completed
  evidence. No floor reset, deadline extension or new time source/recovery generation.
  See [integration proposal](../../../../../.agents/notes/proposed/architecture/2026-10-26-e2ee-realtime-journal.md).
- `prepareCliE2eeMachineLegacy` binds the retained credential hash to the exact
  desktop-generated 16-byte pairing session using core's fixed v1 helper. Machine
  possession additionally binds the strict UTF-8 machineId; activation compares it
  with both the verified current device and the retained signed admission. Session
  IDs stay outside possession and ledger records; old developer formats need recreation.
  Pairing preparation and activation run only on the OS-user control socket;
  Fleet checks its own account and discovered encrypted workspace/genesis first.
  Activation refreshes the verified ledger and mailbox and acknowledges only an
  installed current key; temporary failure leaves the same pairing retryable.

- Pin M2 write epoch. rotationRequired only prompts administrators to update keys; it
  must not latch sends off or block workspace use. Do not add rotation-hint send guards.
- Prepared bindings cannot start content replicas. Activate only the native ledger/key
  receiver: verify current installed key, close temporary owner, THEN write `activation.json`
  before Fleet attaches rooms. The marker grants no authority; match genesis/device.
  Activated workspaces reopen offline. Join identical per-workspace intents; Fleet shutdown
  drains activation before cloud-port close.

- Never construct/register the Fleet PR poller for encrypted workspaces.
- Encrypted cloud ports omit hosted GitHub tokens. SessionManager uses host git/gh
  credentials; never send decrypted repository names through its credential broker.

- Fleet/Lody/one-shot commands load `workspace-legacy` only in the encrypted branch.
  Keep custody/core off the ordinary entry graph; CLI plus maps must fit the 2 GiB heap.

- Runtime journals are signing-key-scoped: retain old evidence; never reuse old KEK blobs.
  Hints follow replacements only after verified admission/install. Pairing waits raise
  no startup issue/timer/global offline state. Activation binds the approved key,
  drains other identities and retains its cleanup retry owner.
- Only activation/binding/device-original ENOENT means pairing wait. Check the
  original before custody init; stale hints cannot trigger keyring probes. Preserve
  other file errors/Fleet retry; never cache transient storage as missing pairing.
- Ingest storage failure fences writes until verified refresh. Next seal coalesces one
  storage-error refresh without reconnecting healthy readers. Validation/conflict needs
  explicit normal refresh; seal cannot auto-recover it.

## Local machine pairing

- `pairing-journal.ts` retains immutable frontend/session proofs and admissions before key
  receipt. Verify full history and current same-member personal authority. New sessions
  need consent; preserve signer/keys/credential. Preflight latest session before Fleet
  ownership changes; reject late sessions.
- Publish ownership before replacement originals; publish material/current identity atomically.
  Same-scope takeover atomically changes old creating=-1/new creating=1, retaining bytes.
  Match account/machine/workspace/genesis/member; superseded sessions cannot publish/retake.
  Reuse originals. Unpublished generations with retained credentials cannot replace missing
  devices; fresh explicit sessions may replace lost published identities with distinct
  signing-key-scoped credentials. Ledger-only owners cannot receive keys. Same-identity
  retries keep healthy owners; only identical intents share flights. Cancellation never
  guesses remote settlement. See [recovery rationale](../../../../../.agents/notes/implemented/bug-fix/2026-10-27-e2ee-local-pairing-recovery.md).
- OS-user socket only; partial upgrades fail closed. No remote authentication. See the
  [pairing note](../../../../../.agents/notes/proposed/architecture/2026-10-26-e2ee-machine-pairing-journal.md).

## Catalog and Fleet containment

- `local-workspace-catalog.ts`: keep encrypted discovery in account/machine-bound
  `workspace-catalog.json.e2ee`, ordinary rows only in v1 `workspaces`; lock both writes.
  Ordinary-only mutations never rewrite encrypted rows. Old v1 writers cannot erase
  the sidecar or account/machine-bound `.e2ee-invalid` marker.
- Never overwrite unreadable sidecars; retain errors in memory and usable ordinary rows.
  Persist ordinary remote-list results; return degraded receipts with current auth/revocation
  checks. Atomically publish `.e2ee-invalid` BEFORE encrypted updates; retain through failed
  writes/cleanup until healthy publication. Derive unavailable from the marker, never unknown
  v1 fields; stale sidecars cannot bootstrap. Fleet keeps scoped recoverable issues, bounded
  retries and pending signature until healthy receipt.

- Same-context `creating=-1` means `prepare-superseded`; other errors stay errors. Main
  archives only the matching all-null unsigned attempt before fresh consent. Keep CLI originals.
- Never cache an unimplemented content mode; `export` refuses and `sync` skips schedules
  for encrypted workspaces
  ([note](../../../../../.agents/notes/implemented/bug-fix/2026-10-27-e2ee-cli-review-fixes.md)).

- Explicit same-user reset drains the workspace, takes its stable sibling identity
  lease, and archives the entire directory. Require fresh approval and a new KEK;
  OS/unknown protection cannot reset into file protection.
