# Machine E2EE

`CLAUDE.md` aliases this; CLI rules apply.

- Lazy machine-only; ordinary startup never probes keyring.
- Creation reads, or writes and reads back, the KEK keyring entry in one helper process;
  never replace an existing entry. It fixes OS/file protection permanently.
  Reopen: original selector/KEK; no re-probe/switch.
- File protection: owner-only dirs/files, no symlinks. Windows: owner/DACL via official
  process Layer, never Unix mode bits.
- Core node-custody owns blobs; no personal management, private exports/plaintext device files
  or silent keyring downgrade.
- Disclose file protection pre-approval.

- Keyring: 10s timeout, stdin secrets; confirm termination before fallback, retain failed owners.
  A read KEK is remembered per process, never absence; opens still check disk.
- Batch Windows ACL checks; bound async SQLite BUSY retries. No blocking busy_timeout in keyring work.

- Resume first Windows ACL setup only with empty custody; otherwise validate.
- `runtime.ts` composes Feed/VerifiedLedger, installed keys and optional receiver.
  Offline open/status; cloud I/O stays in cloud-cli-port.
  Distinguish damaged history/pins; never reset trusted pins from remote hints.
- Encrypted claims authorize every machine-resolved local project the turn reaches, never
  the request alone. [Scope](../../../../../.agents/notes/proposed/architecture/2026-10-28-e2ee-machine-sharing.md#project-scope-at-the-receiving-machine).
- Execution: `authorizeExecution`; same membership or verified owner-signed machine/project policy; authenticated read;
  RAM-only <15min/read-start; [outage](../../../../../specs/e2ee/execution-freshness-outage.md). Credential revoke: fence/clear grants before drain,
  never network-retry.
  A shared grant pins the ledger generation after its policy check, then rechecks the
  signer and machine against that ledger; a later ingest fails `isCurrent()`.
  Claims record verified principals, never history `userId`. Signed `derivedFrom` names
  the human root; member delegation stays on this machine and rechecks the root's rights.
  Members share 20 durable reservations across restart/reset; Owners remain unbounded
  ([derivation](../../../../../.agents/notes/implemented/architecture/2026-10-31-e2ee-shared-member-derivation.md)).
  Origins bind signatures to content ([intent](../../../../../.agents/notes/implemented/architecture/2026-11-10-e2ee-signed-execution-intent.md)).
  An Inbox result continuation has no signed row: `claimContinuation` authorizes every
  distinct Operation `sourceTurnId` through its human root under these rules, keeps refused
  results queued and waits on pending evidence
  ([continuations](../../../../../.agents/notes/implemented/architecture/2026-10-31-e2ee-shared-member-derivation.md#inbox-result-continuations)).
- Retain originals before feed/pin. Pin before compaction, attempted every
  64 records; its failures only warn. Retired cache cleanup must fail closed.
- Iroh and Streams receivers share journal claims and live write completions, registered before
  invocation. Only ownerless uncertain writes return errors; see [iroh rules](../../../../../packages/iroh-native/AGENTS.md).
- Follow [Schedule rules](../schedules/AGENTS.md).
- No plaintext RPC/attachments/schedules before encryption. Presence: shared minimal
  plaintext publish/receive allowlists, ordinary adaptor/90s TTL.
- `realtime-journal.ts`: schema 3/no migration; SQLite recovery before empty-v0 init.
  Retire readable current keys before intact archive; unreadable keys refuse reset.
  No auto-replace/GC/archive replay/import. Exact originals/first outcome;
  uncertain=unknown/no takeover; independent IDs. Floors: genesis/workspace.
  Feature writes reject local >10min ahead of authenticated now, never frame
  time; no reference: current local time, no retained peak. Execution records (`expiresAt` 0) skip that clock. Reset: stop owners, archive/new ID;
  keep control/retired IDs/intent. Shared calls/exclusive reset; keep locks on
  failed main close. Bound permits/cleanup; reply before send; exact retries.
  `agent-execution.ts`: userTurnId claim for RPC/Meta/history; verified signer + host
  authority. UI accounts are display-only. No capability: deny.
  Unreadable ledger: pending, rechecked on events. Missing or invalid intents refuse with
  their reason; no time window. No snapshot-author
  substitution or uncertain ACP retry.
  [Recovery](../../../README.md#local-encrypted-execution-log-recovery).
- `prepareCliE2eeMachineLegacy` binds the retained credential hash to the 16-byte pairing session via core's v1 helper. Machine possession binds strict UTF-8 `machineId`; activation matches the verified device and retained signed admission. Session IDs stay outside possession and ledger records.
- Local prepare/activate uses OS-user socket; remote uses signed offer and scoped port. Fleet checks account/workspace/genesis first: missing/conflicting catalog rows wait for the first authoritative list outcome, then fail closed; cached matches proceed offline ([decision](../../../../../.agents/notes/implemented/bug-fix/2026-10-30-e2ee-pairing-first-workspace-list.md)). Activation refreshes verified ledger/mailbox and ACKs only an installed current key; failure stays retryable. Archive known-revoked identities before new offers; never offer a revoked key ([re-pairing](../../../../../.agents/notes/proposed/feature/2026-10-27-e2ee-remote-machine-pairing.md#re-pairing-a-revoked-machine)). After admission, `lody machine pair` treats missing key as a bounded wait; other activation errors stay terminal.
- Staging read failures never block verified mailbox reception. Retain sealed old-epoch sends and historical reads; new seals use core's verified current epoch when installed, or the newest retained published key only within core's durable 15-min missing-key budget (exhaustion fails for retry). Provider epoch hints and `rotationRequired` are not encryption authority.
- Rejected dispatch/feature requests naming a newer epoch or missing current-epoch key, signed by a current ledger device, join one bounded catch-up per verified ledger state, then reopen (core guard still decides); joined older refreshes missing the key get at most one extra round. Unchanged-state failures cool down independently (`at`-based 4 s `missing-key` vs 60 s newer-epoch); successful key install clears cooldown. Logs carry only both epochs ([M3](../../../../../.agents/notes/implemented/architecture/2026-10-27-e2ee-epoch-receive-barrier.md)).
- Prepared bindings cannot start content replicas: verify current installed key, then write `activation.json` before Fleet attaches rooms. Remote activation closes its owner; local promotes it into Fleet's start (closed unless adopted). Desktop ledger handoffs are untrusted bytes verified from pinned genesis; rejection falls back to history and never confirms authority. Markers grant no authority (match genesis/device). Activated workspaces reopen offline; join identical intents; Fleet shutdown drains activation before cloud-port close.
- Encrypted pollers publish protected Loro metadata with null hosted PR association. `runtime-cloud-port.ts` closes plaintext channels but keeps attachment relay URL and preview tunnel (proof verifier rejects); MessageHandler fences plaintext attachment reads. Edit-and-resend replacements include `signMachineInput` intent in the same commit. Account E2EE ports retain repo-scoped GitHub credentials (personal: account-bound; others: App tokens); device-only ports omit GitHub.
- Fleet/Lody/one-shot commands load `workspace-legacy` only in the encrypted branch; keep custody/core off the ordinary entry graph so CLI plus maps fit in 2 GiB.

- Runtime journals are signing-key-scoped: retain old evidence and never reuse old KEK blobs. Hints follow replacements only after verified admission and install. Pairing waits raise no startup issue, timer, or global offline state; `LodyFleet` parks `e2ee_device_revoked` in `waitingForPairing` too. Activation binds the approved key, drains other identities, and retains its cleanup retry owner.
- Only `activation.json`, `binding.json`, or device-original ENOENT means pairing wait. Check originals before custody init so stale hints never probe keyrings. Other errors retain Fleet retry; never cache transient I/O as missing pairing.
- Ingest failure fences new seals until verified refresh while keeping the last verified view and healthy readers. Retries double up to 5 min and never stop while open; explicit refresh restarts backoff. Seal may request retry but never await it in the SDK save queue. Never skip rejected records or reset pins; close cancels pending retry timers.
- Each encrypted workspace keeps one bounded background authority check (credential plus verified-ledger refresh) joined to the single-flight owner. Exact member/device refusal stops it via durable receipt; generic failures keep the last verified view. Inbound machine-control frames request it; transient history and `waiting-key` retries double from 1 s to 5 min without fencing seals. Never depend on token expiry, and keep the read-only client-loss probe I/O-free.

## Local machine pairing

- `pairing-journal.ts` owns `pairings.sqlite` exclusively (never open it elsewhere) and retains immutable frontend/session proofs and admissions before key receipt. Verify full history and current same-member personal authority; new sessions require consent and preserve signer/keys/credential. Preflight latest session before Fleet ownership changes and reject late sessions.
- Publish ownership before replacement originals; publish material and current identity atomically. Same-scope takeover atomically marks old `creating=-1` and new `creating=1`, retaining bytes, matching account/machine/workspace/genesis/member; superseded sessions cannot publish or retake. Unpublished generations with retained credentials cannot replace missing devices; fresh explicit sessions may replace lost published identities with signing-key-scoped credentials. Ledger-only owners cannot receive keys; same-identity retries keep healthy owners; only identical intents share flights; cancellation never guesses remote settlement ([rationale](../../../../../.agents/notes/implemented/bug-fix/2026-10-27-e2ee-local-pairing-recovery.md)).
- Remote pairing uses workspace custody and scoped grants ([contract](../../../../../.agents/notes/proposed/feature/2026-10-27-e2ee-remote-machine-pairing.md)), retries only `RetryablePairingError` within bounded budget, and never re-calls `claim` after admission. Pass `AbortSignal` explicitly on `CloudE2eePort` (no `AsyncLocalStorage`/hidden symbols) and fence `publishActivation` (`link`/`rename`) and `completeRemotePairing` against cancellation and expiry.

## Catalog and Fleet containment

- Encrypted workspace catalog rules bind `../local-workspace-catalog.ts` ([lib rules](../AGENTS.md#encrypted-workspace-catalog)).
- Same-context `creating=-1` means `prepare-superseded`; other errors stay errors. Main archives only matching all-null unsigned attempts before fresh consent; keep CLI originals.
- Readable `binding.json` outranks listed mode: contradicting rows never start, relabel, revoke, or rewrite cache; unreadable bindings block opens and retry (`retained-binding.ts`).
- Never cache unimplemented content modes. `export` decrypts locally; `export` and `sync` include encrypted Schedule documents and Registry ([note](../../../../../.agents/notes/implemented/bug-fix/2026-10-27-e2ee-cli-review-fixes.md)).
- Reset runs over same-user socket: drain, exclusive sibling lease, archive whole dir, require fresh approval/KEK; OS/unknown stays OS.
- Verify member removal and persist `removed.json` before custody release. Drain execution/sync; erase under identity lease and fail-closed `pairing-mutex.sqlite` (`busy` never swallowed), deleting `roost/` and `custody/` before `remote-bootstrap.json`/`activation.json`/`binding.json` and unlinking corrupt journals. Replay `removed.json` before `openWorkspace` and `loadCliE2eeMachineBootstrapLegacy`, preserve projects, and rejoin with fresh keys ([Roost cleanup](../../session/README.md#encrypted-roost-history)).
- `client-loss-observer.ts` is read-only E2E diagnostics (nonrelease opt-in + `LODY_E2E=1`): bind baseline requester to verified ledger, never trigger refresh/stop, and track raw watcher/ACP promises after cancellation/map clearing (timeout never means drained).

E2EE notification ports forward only the CLI account’s recipients. Live Activity summaries omit HTTP approval IDs; permission responses require signed in-App device actions.
