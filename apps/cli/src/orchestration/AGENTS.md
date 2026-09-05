# MCP Session orchestration

Root and `apps/cli/AGENTS.md` apply. Normative behavior lives in
`specs/session-orchestration.md`; this file is only a code-navigation index.

- `operation-store.ts` is the shared machine-local WAL SQLite source of truth.
  The key is `(requesterSessionId, operationId)`; foreign Session lookup must be
  indistinguishable from absence. Operation finalization and Delivery insertion
  are one transaction. Delivery/system-Turn ids include both key parts; never
  derive a globally unique id from the Session-scoped `operationId` alone.
- Target input creation is fenced by the SQLite item-materialization claim.
  Acceptance owns new claims; the lease Worker only adopts absent/expired
  claims. Loro history evidence clears the claim. Before an adopted claim may
  treat a missing fixed Turn as permission to write, an explicit remote Streams
  target-document sync must confirm that the local replica is caught up. A local
  transport-only sync is not confirmation. A failed remote confirmation is
  uncertainty and arms the same owned bounded-backoff wake as a materializer
  error; unrelated SQLite/Meta watch hints must not be the only retry path, and
  every retry rechecks the fixed user Turn id first.
- Successful item completion copies only visible assistant text into an 8 KiB
  `output` preview. The store may further head/tail-bound it to keep the whole
  completion at 64 KiB; preserve both per-output and aggregate omission metadata.
- The Operation directory and SQLite database contain prompts and assistant
  output and must remain private to the local account (0700/0600 on Unix).
- Create Operations freeze each target's effective dispatch config at
  acceptance; recovery must not re-read mutable requester history defaults.
  Full content stays in the target Session history.
- Accepted Operations store the invoking user once as `requesterUserId` and bind the exact source
  Turn as `sourceTurnId`. `requesterSessionId` already identifies the source Session. Recovery
  routes attribution and member-scoped authorization through that frozen user while the current
  owner Machine credential remains the executor credential. Completion system Turns retain the
  same userId so a continuation cannot silently switch identities. The Operation store matches
  requester user and source Turn together with kind and command fingerprint; a later Turn reusing
  the id is `OPERATION_ID_REUSED`, not a retry.
- `operation-coordinator.ts` is owned only by the local Host-lease Worker. MCP
  subprocesses may accept Operations but never schedule completion Turns.
- Reconciliation is level-checked. Loro subscriptions and SQLite directory
  watch events are hints; startup/lease acquisition scans active Operations and
  pending Deliveries once. The watcher never carries result data.
- The coordinator holds ONE store connection from start to stop. Closing the
  last SQLite connection deletes the WAL/SHM sidecars, so per-reconcile
  open/close makes the directory watcher observe its own churn and wake itself
  in a CPU-starving loop (per-workspace coordinators share the machine-level
  store and amplify it). Watch wakes are leading-edge coalesced; never do
  store work per raw fs event.
- The MCP server process also holds ONE store connection (lazy singleton),
  opened with `maintenance: false` so non-owner opens are not themselves write
  transactions; the daemon coordinator owns open-time repair/cleanup. Do not
  reintroduce per-call open/close: each close checkpoints against the shared
  WAL and each default open writes, which is the "database is locked" source.
- WAL allows one writer machine-wide. Every writing store transaction runs
  `BEGIN IMMEDIATE` (deferred read→write upgrades fail with
  `SQLITE_BUSY_SNAPSHOT`, which `busy_timeout` cannot wait out). Subprocess
  boundaries wrap store calls in `runWithOperationStoreBusyRetry` (bounded
  async backoff; exhausted retries surface as retryable `STORE_BUSY`). Daemon
  paths must not add blocking waits on top of the driver's `busy_timeout`.
- `operation-model.ts` is the reduced executable race model. Update its bounded
  exploration and concrete traces whenever scheduling semantics change.
- Delivery never writes user dispatch pointers. Pending user input wins every
  idle boundary; completion uses a stable `role: system`
  `operation_completion` Turn and then the existing Session execution mutex.
- Missing Session metadata, a recoverable tombstone, or an unsynchronized
  Machine Flock document is uncertainty, not permanent deletion/configuration
  absence. Keep the item/Delivery pending until positive evidence or deadline.
- Deadlines finish the root with item `TARGET_TIMEOUT` results but never cancel
  target Turns. Operation cancel is the only best-effort remote-cancel path.
- A pending Delivery still undeliverable 8h after its Operation's deadline is
  consumed as `expired_stale` without a continuation turn: waking a Session
  with a completion for work that ended long ago (stranded store, multi-day
  downtime) surprises the user and spends tokens on a stale result.
- Store paths are keyed strictly by an explicit machineId
  (`getLodyOperationStorePath` has no default): the MCP server resolves it from
  the session context, never from its own process environment. The former
  env/`'local'` fallback let the daemon-hosted HTTP transport (whose process
  has no `LODY_MCP_MACHINE_ID`) silently write Operations into a store no
  coordinator reconciles, so completions were never delivered.
- `session_create_many` and `session_chat_many` target writes bypass cooperative
  Session/Turn quotas. Preserve the bypass in both MCP-process materialization
  and daemon recovery replay; otherwise quota rejection degrades into a false
  `TARGET_TIMEOUT`.
- Tests use injected clocks and explicit reconciliation/idle barriers. Do not
  add polling sleeps or wall-clock races.
