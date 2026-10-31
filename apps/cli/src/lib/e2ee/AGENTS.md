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
  A shared grant pins the ledger generation after its policy check, then rechecks the
  signer and machine against that ledger; a later ingest fails `isCurrent()`.
  Claims record the principal: only a turn signed by the owner's own membership lends
  its identity to derived work (MCP, agent control). History `userId` is display data;
  shared-member or steered turns expose no invocation identity.
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
  The local catalog never refuses that check: a workspace it lacks or binds to another
  genesis waits for the first authoritative list outcome (list, rejection, subscription
  error or shutdown), then fails closed; a cached match proceeds offline
  ([startup decision](../../../../../.agents/notes/implemented/bug-fix/2026-10-30-e2ee-pairing-first-workspace-list.md)).
  A known-revoked identity (device receipt or exact `e2ee_device_revoked`) is archived
  before a new offer; never offer a revoked key ([re-pairing](../../../../../.agents/notes/proposed/feature/2026-10-27-e2ee-remote-machine-pairing.md#re-pairing-a-revoked-machine)).
  After admission, `lody machine pair` treats a missing key as a bounded wait for desktop
  delivery, never as failure; other activation errors stay terminal
  ([remote contract](../../../../../.agents/notes/proposed/feature/2026-10-27-e2ee-remote-machine-pairing.md)).

- Staging read denial/I/O failure cannot block independently verified mailbox reception.
- Retain already sealed old-epoch sends and historical reads. New seals use the verified current
  epoch in core when installed. Only genuine absence permits the newest retained published key
  within core’s durable fifteen-minute observation budget; exhaustion fails for retry.
  Provider epoch hints are not encryption authority; rotationRequired alone is only a hint.
  A rejected dispatch or feature request naming a newer epoch, or missing its current-epoch key,
  signed by a current ledger device, joins
  one bounded catch-up per verified ledger state, then reopens; the core guard still decides.
  A joined older refresh that leaves the current key missing gets at most one additional
  round through the same owner and wait budget. An unsuccessful refresh of an unchanged
  ledger cools down; successful key installation must not cool down the next rotation.
  Logs carry only both epochs.
  [M3 selection](../../../../../.agents/notes/implemented/architecture/2026-10-27-e2ee-epoch-receive-barrier.md).
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
- Never cache an unimplemented content mode. `export` decrypts locally; `export` and
  `sync` include encrypted Schedule documents and Registry
  ([note](../../../../../.agents/notes/implemented/bug-fix/2026-10-27-e2ee-cli-review-fixes.md)).

- Reset: same-user socket; drain, exclusive sibling lease, archive whole dir;
  fresh approval/KEK. OS/unknown stays OS.

Member removal: verify identity/persist receipt before custody release. Drain execution/sync;
erase only account/genesis/device content under identity lease/pairing mutex. Retry busy
cleanup before open; preserve projects. Rejoin with new member/keys.

- `client-loss-observer.ts` is read-only E2E diagnostics, requiring nonrelease build
  opt-in and runtime `LODY_E2E=1`. Bind baseline requester identity to verified ledger
  state; never refresh authority or stop owners for observation. Track raw watcher
  and ACP promises after cancellation/map clearing; timeout never means drained.
