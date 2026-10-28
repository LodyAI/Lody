# Machine E2EE custody

`CLAUDE.md` is a symlink to this file. Parent CLI rules apply.

- Lazy machine-only; ordinary startup never probes keyring.
- First creation probes OS keystore write/read and permanently selects OS or
  file protection. Reopen requires the original selector/KEK; never probe or switch.
- File protection: owner-only dirs/files, no symlinks. Windows needs real
  owner/DACL checks via official process Layer, not Unix modes.
- Core node-custody owns blobs. No personal management/private exports, plaintext
  device files or silent keyring downgrade.
- Display file protection before pairing approval.

- Keyring helper: 10-second timeout, stdin secrets. Confirm termination before
  fallback; retain failed release owners.
- Batch Windows ACL checks. Retry SQLite BUSY asynchronously with a bound;
  never block busy_timeout during keyring work.

- Resume first Windows ACL setup only in an empty custody directory; otherwise validate only.
- `runtime.ts` composes Feed/VerifiedLedger, installed keys and optional receiver.
  Open/status are offline; cloud requests stay in cloud-cli-port.
  Report damaged history/pins distinctly; never reset trusted pins from remote hints.
- Journal originals before feed/pin; rebase core pin first after 64 records.
  Retired cache cleanup cannot fail local open.
- No plaintext RPC, presence, attachments or schedules until encrypted channels exist.
- `realtime-journal.ts`: schema 3/no migration; SQLite recovery before empty-v0 init.
  Retire readable current keys before intact archive; unreadable keys refuse reset.
  No auto-replace/GC/archive replay/import. Exact originals/first outcome;
  uncertain=unknown/no takeover; independent IDs. Floors: genesis/workspace.
  Before writes reject local >10min ahead of authenticated now, never frame
  time; no reference: scoped max/reset. Reset: stop owners, archive/new ID;
  keep control/retired IDs/intent. Shared calls/exclusive reset; keep locks on
  failed main close. Bound permits/cleanup; reply before send; exact retries.
  `agent-execution.ts`: userTurnId claim for RPC/Meta/history; verified signer/user
  plus device authority; snapshots/author fields are no origin. No uncertain ACP retry.
  [Recovery](../../../README.md#local-encrypted-execution-log-recovery).
- `prepareCliE2eeMachineLegacy` binds the retained credential hash to the exact
  desktop-generated 16-byte pairing session using core's fixed v1 helper. Machine
  possession additionally binds the strict UTF-8 machineId; activation compares it
  with both the verified current device and the retained signed admission. Session
  IDs stay outside possession and ledger records; old developer formats need recreation.
  Local preparation/activation uses the OS-user socket; remote pairing uses the
  signed offer and scoped service port. Fleet checks account/workspace/genesis first.
  Activation refreshes the verified ledger and mailbox and acknowledges only an
  installed current key; temporary failure leaves the same pairing retryable.

- Staging read denial/I/O failure cannot block independently verified mailbox reception.
- Retain old-epoch sends; select confirmed keys per operation. Rotation hints never pause.
  [M3 selection](../../../../../.agents/notes/proposed/architecture/2026-10-27-e2ee-epoch-receive-barrier.md).
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
- Only activation/binding/device-original ENOENT means pairing wait. Check originals
  before custody init; stale hints never probe keyrings. Other errors retain Fleet
  retry; never cache transient I/O as missing pairing.
- Ingest failure fences new seals until verified refresh; keep the last verified view
  and healthy readers. Retry at most three times per failure episode; explicit refresh
  restarts that budget. Seal may request retry but never await it in the SDK save queue.
  Never skip rejected records or reset pins. Close cancels pending retry timers.

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
- Remote commands use workspace custody and scoped grants; see the
  [remote contract](../../../../../.agents/notes/proposed/feature/2026-10-27-e2ee-remote-machine-pairing.md).

## Catalog and Fleet containment

- `local-workspace-catalog.ts`: keep encrypted discovery in account/machine-bound
  `workspace-catalog.json.e2ee`, ordinary rows only in v1 `workspaces`; lock both writes.
  Ordinary-only mutations never rewrite encrypted rows. Old v1 writers cannot erase
  the sidecar or account/machine-bound `.e2ee-invalid` marker.
- Offline/ordinary writes never replace unreadable sidecars. Only authenticated online-list
  reconciliation may archive a corrupt `.e2ee` file before rebuilding; permission and marker
  errors stay errors. Retain originals, failure receipts and usable ordinary rows.
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

- Reset: same-user socket; drain, exclusive sibling lease, archive whole dir;
  fresh approval/KEK. OS/unknown stays OS.

Member removal: verify identity and persist its receipt before close releases custody.
Stop/drain execution and sync; erase only account/genesis/device content under its
identity lease/pairing mutex. Retry busy cleanup before open; preserve projects.
Rejoin with fresh member/keys.
