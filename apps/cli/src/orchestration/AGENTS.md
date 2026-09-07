# MCP Session orchestration

Root and `apps/cli/AGENTS.md` apply; `specs/session-orchestration.md` owns behavior.

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
- Operation files contain prompts and assistant output; keep them private to the
  local account (0700/0600 on Unix).
- Create Operations freeze each target's effective dispatch config at
  acceptance; recovery must not re-read mutable requester history defaults.
  Full content stays in the target Session history.
- Accepted Operations freeze `requesterUserId` and exact `sourceTurnId`; `requesterSessionId` names
  the source Session. Recovery uses that user for attribution/authorization and the current owner
  Machine credential to execute. Completion preserves userId. Matching includes both ids, kind,
  and fingerprint; reuse from another Turn is `OPERATION_ID_REUSED`, not a retry.
- `operation-coordinator.ts` is owned only by the local Host-lease Worker. MCP
  subprocesses may accept Operations but never schedule completion Turns.
- Reconciliation is level-checked. Loro subscriptions and SQLite directory
  watch events are hints; startup/lease acquisition scans active Operations and
  pending Deliveries and unsettled progress once. The watcher never carries result data.
- The coordinator holds ONE store connection from start to stop. Closing the
  last SQLite connection deletes the WAL/SHM sidecars, so per-reconcile
  open/close makes the directory watcher observe its own churn and wake itself
  in a CPU-starving loop (per-workspace coordinators share the machine-level
  store and amplify it). Watch wakes are leading-edge coalesced; never do
  store work per raw fs event.
- The MCP server process also holds ONE store connection (lazy singleton),
  opened with `maintenance: false` so non-owner opens are not themselves write
  transactions; current-schema detection is read-only and migration takes the
  writer lock only when that probe finds work. The daemon coordinator owns
  open-time repair/cleanup. Do not
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
- Delivery never writes user dispatch pointers; pending users win idle boundaries. Completion uses
  one stable system Turn, the Session mutex, and Assistant id `assistant:<systemTurnId>`;
  Assistant `finished`/`endedAt` is not evidence because teardown also writes it.
  Fences are the Host lease, Worker boot id, and attempt token. Execution fields stay
  in `delivery_execution_state` because stable binaries parse `SELECT * FROM deliveries`. Active
  claims cannot be taken over; contention has no history/ACP effects, and release/consume match both
  ids. Terminal and no-execution paths claim too, write history before consume, retain failed
  finalization for settlement-only retries, recheck ownership after awaits, and never rewrite
  durable history. `claimed` becomes `prepared` after history and spends an attempt; `started`
  precedes provider prompt, and stale-ACP recovery skips that fence. A failed start fence
  finalizes the Assistant, restores idle under Session ownership, and settles `not_started`; only
  confirmed pre-provider interruption releases prepared work. Cancellation or accepted steer
  consumes the Delivery. Missing post-start settlement becomes `uncertain`, never replay, and emits
  `DELIVERY_EXECUTION_UNCERTAIN` while preserving output. Claim-bound live outcomes survive store
  failures for settlement-only retry. Startup recovers older boots without resetting attempts;
  started work becomes uncertain. Stop abandons only its Worker: claimed/prepared work becomes
  runnable and started work uncertain. After two prepared attempts, consume with
  `DELIVERY_ATTEMPTS_EXHAUSTED` without ACP. Pre-claim pending migration is uncertain.
- Create Operations may also maintain one stable `role: system` `operation_progress`
  Turn in the requester Session, written only by the Host-lease Worker, never by MCP
  replicas. It is durable UI state, never agent input/dispatch. Repair duplicate ids before keyed
  Mirror updates. Publish cards only from materialized Session/UserTurn evidence or an existing
  target, and merge status monotonically by exact target.
  Progress failures must not fail acceptance, materialization, cancellation, finalization,
  Delivery, or target cancellation. Set `progressMessageId` only when the row covers every durable
  target and successful result; otherwise retain completion fallback cards. Root cancellation,
  errors, and deadlines do not terminate targets. Delivery consumption does not end reconciliation:
  retain it through target terminal state and local Loro flush, and preserve it through SQLite
  cleanup/restart. Missing evidence or writes retain an owned retry and never wake the agent.
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
