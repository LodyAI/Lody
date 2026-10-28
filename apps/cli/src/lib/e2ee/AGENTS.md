# Machine E2EE

`CLAUDE.md` aliases this; CLI rules apply.

- Lazy machine-only; ordinary startup never probes keyring.
- Creation probes OS keystore write/read; fixes OS/file protection permanently.
  Reopen: original selector/KEK; no re-probe/switch.
- File protection: owner-only dirs/files, no symlinks. Windows: owner/DACL via official
  process Layer, never Unix mode bits.
- Core node-custody owns blobs; no personal management, private exports/plaintext device files
  or silent keyring downgrade.
- Disclose file protection pre-approval.

- Keyring: 10s timeout, stdin secrets; confirm termination before fallback, retain failed owners.
- Batch Windows ACL checks; bound async SQLite BUSY retries. No blocking busy_timeout in keyring work.

- Resume first Windows ACL setup only with empty custody; otherwise validate.
- `runtime.ts` composes Feed/VerifiedLedger, installed keys and optional receiver.
  Offline open/status; cloud I/O stays in cloud-cli-port.
  Distinguish damaged history/pins; never reset trusted pins from remote hints.
- Execution: `authorizeExecution`; same membership or verified owner-signed machine/project policy; authenticated read;
  RAM-only <15min/read-start. Credential revoke: fence/clear grants before drain,
  never network-retry.
- Journal originals before feed/pin; rebase core pin first after 64 records.
  Retired cache cleanup must fail closed.
- No plaintext RPC/attachments/schedules before encryption. Presence: shared minimal
  plaintext publish/receive allowlists, ordinary adaptor/90s TTL.
- `realtime-journal.ts`: schema 3/no migration; SQLite recovery before empty-v0 init.
  Retire readable current keys before intact archive; unreadable keys refuse reset.
  No auto-replace/GC/archive replay/import. Exact originals/first outcome;
  uncertain=unknown/no takeover; independent IDs. Floors: genesis/workspace.
  Before writes reject local >10min ahead of authenticated now, never frame
  time; no reference: scoped max/reset. Reset: stop owners, archive/new ID;
  keep control/retired IDs/intent. Shared calls/exclusive reset; keep locks on
  failed main close. Bound permits/cleanup; reply before send; exact retries.
  `agent-execution.ts`: userTurnId claim for RPC/Meta/history; verified signer + host
  authority. UI accounts are display-only. No capability: deny.
  Missing origin: backfill/retry pending to original expiry. No snapshot-author
  substitution or uncertain ACP retry.
  [Recovery](../../../README.md#local-encrypted-execution-log-recovery).
- `prepareCliE2eeMachineLegacy` binds the retained credential hash to the exact
  desktop 16-byte pairing session via core's fixed v1 helper. Machine
  possession binds strict UTF-8 machineId; activation matches the verified current
  device and retained signed admission. Session
  IDs stay outside possession and ledger records; old developer formats need recreation.
  Local prepare/activate: OS-user socket; remote: signed offer/scoped port. Fleet checks account/workspace/genesis first.
  Activation refreshes verified ledger/mailbox; ACK only an installed current key. Failure keeps pairing retryable.

- Staging read denial/I/O failure cannot block independently verified mailbox reception.
- Retain old-epoch sends; select confirmed keys per operation; rotation hints never pause.
  [M3 selection](../../../../../.agents/notes/proposed/architecture/2026-10-27-e2ee-epoch-receive-barrier.md).
- Prepared bindings cannot start content replicas. Activate only the native ledger/key
  receiver: verify current installed key, close temporary owner, THEN write `activation.json`
  before Fleet attaches rooms. Marker grants no authority; match genesis/device.
  Activated workspaces reopen offline. Join identical per-workspace intents; Fleet shutdown
  drains activation before cloud-port close.

- Never register Fleet PR pollers for encrypted workspaces.
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
  Same-scope takeover: atomic old creating=-1/new creating=1, retain bytes.
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

Member removal: verify identity/persist receipt before custody release. Drain execution/sync;
erase only account/genesis/device content under identity lease/pairing mutex. Retry busy
cleanup before open; preserve projects. Rejoin with new member/keys.
