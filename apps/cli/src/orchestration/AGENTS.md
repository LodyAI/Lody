# MCP Session orchestration

Root/CLI rules apply; `specs/session-orchestration.md` owns behavior.

- `operation-store.ts` is the shared machine-local WAL SQLite source of truth.
  Key: `(requesterSessionId, operationId)`; foreign Session lookup must be
  indistinguishable from absence. Operation finalization and Inbox result insertion
  are one transaction. Manual target Stop stays queryable but never queues a receipt; persist its cause atomically. Cleanup retains retired ids; accepting them again is forbidden.
  Result/system-Turn ids include both key parts, never the Session-scoped
  `operationId` alone.
- Target input creation is fenced by the SQLite item-materialization claim.
  Acceptance owns new claims; the lease Worker only adopts absent/expired
  claims. Loro history evidence clears the claim. Before an adopted claim may
  treat a missing fixed Turn as permission to write, confirm authority: cloud
  requires remote Streams catch-up (local transport sync is insufficient); OSS
  uses the daemon repo that owns every MCP write. A failed confirmation is
  uncertainty and arms the same owned bounded-backoff wake as a materializer
  error; unrelated SQLite/Meta watch hints must not be the only retry path, and
  every retry rechecks the fixed user Turn id first.
- Successful item completion copies only visible assistant text into an 8 KiB
  `output` preview. The store may further head/tail-bound it to keep the whole
  completion at 64 KiB; preserve both per-output and aggregate omission metadata.
- Operation files hold prompts and assistant output; keep them account-private
  (0700/0600 on Unix).
- Create Operations freeze each target's effective dispatch config at
  acceptance; recovery must not re-read mutable requester history defaults.
  Full content stays in the target Session history.
- Accepted Operations freeze `requesterUserId`, `sourceTurnId` and notification origins; `requesterSessionId` names
  its source. Recovery uses that user for attribution/authorization and the current owner
  Machine credential to execute. Completion preserves userId. Matching includes both ids, kind,
  and fingerprint; reuse from another Turn is `OPERATION_ID_REUSED`, not a retry. A same-Turn
  identical single create under a new id adopts the active original.
  Author/attachment snapshots in `operation_authors` / `operation_inputs` freeze atomically.
  Missing authors retain frozen Session/Turn provenance, never human identity.
- `operation-coordinator.ts` is owned only by the local Host-lease Worker. MCP
  subprocesses may accept Operations but never schedule completion Turns.
- Reconciliation is level-checked. Loro subscriptions and SQLite directory
  watch events are hints; startup/lease acquisition scans active Operations and
  durable Inbox intents and unsettled progress once. The watcher never carries result data.
- Synchronous Inbox startup failure disables only Inbox orchestration. Keep ordinary
  dispatch available, reject Inbox-dependent tools before storage access, and report
  a runtime warning. Coordinator owns capped startup retry and cancels it on stop;
  incompatible schema/protocol never auto-retries or receives degraded writes.
- Coordinator owns ONE connection from start to stop. Watch wakes are
  leading-edge coalesced; never do store work per raw fs event.
- The MCP server holds ONE lazy store connection with `maintenance: false`.
  Current-schema detection is read-only; migration locks only when needed.
  The daemon owns open-time repair/cleanup. Never reopen per call.
  See [README](README.md).
- One scoped connection is shared by repositories. Transactions are synchronous; never await
  or return Effect/Promise inside them. WAL has one writer; writes use `BEGIN IMMEDIATE`. Subprocess
  boundaries wrap store calls in `runWithOperationStoreBusyRetry` (bounded
  async backoff; exhausted retries surface as retryable `STORE_BUSY`). Daemon
  paths must not add blocking waits on top of the driver's `busy_timeout`.
- `operation-model.ts` is the reduced executable race model. Update its bounded
  exploration and concrete traces whenever scheduling semantics change.
- Receipts coalesce into one intent when idle, unpaused and released; busy Sessions wait
  for normal release. Claim requires a wakeable result and freezes all available members.
  Later arrivals wait; pause, empty queues and duplicates cannot wake.
- `inbox/service.ts` is native Effect v4. Scope owns its signal/fibers and repository connection;
  one per-Session admission covers Stop, fresh input acceptance and actual transport start.
  Core imports no platform/consumers; registered bridges execute. Submit/settle through execution owners.
- Inbox-aware Stop pauses/cancels queued eligibility; legacy Stop only cancels execution.
  Pause blocks only automatic wakes; fresh human and Agent-chat input both clear it. New
  acceptance cannot revive a canceled execution or discard an already prepared human input.
- Fixed batch claims and submission fence precede synchronous transport start under the
  same gate, with no await between. Post-fence uncertainty never replays, including
  human-plus-batch stale-ACP recovery. Retry failed settlement only, never the request.
- Physical resource release differs from waiter exit. Keep immutable execution IDs,
  shared close receipts, full Cause and resource registration. Unconfirmed release must
  not block successors or shutdown: detach the failed Agent before returning the slot,
  report it and attempt bounded background cleanup using only the old handles.
  Startup retires interrupted input as unknown without replay and clears legacy blocks.
  Coordinator recovery calls `recoverClose`, not cached failed `close`. Release finishes
  input; a still-pending turn `withdraw`s before submit/acquisition.
- Inbox v2 removes Delivery APIs/data, not Operations/retired IDs. Preserve queued
  input/results, pause, unknown/resource evidence and monotonic sequences. Host v3
  rejects old workers before storage; end prior Workers before handoff. Passive
  results are not busy. Resource identities are cleanup evidence, never admission gates.
- Create Operations may also maintain one stable `role: system` `operation_progress`
  Turn in the requester Session, written only by the Host-lease Worker, never by MCP
  replicas. It is durable UI state, never agent input/dispatch. Merge duplicate rows through
  HistoryWriter without raw alias writes. Publish cards only from materialized Session/UserTurn evidence or an existing
  target, and merge status monotonically by exact target.
  Progress failures must not fail acceptance, materialization, cancellation, finalization,
  result persistence, or target cancellation. Set `progressMessageId` only when the row covers every durable
  target and successful result; otherwise retain completion fallback cards. Root cancellation,
  errors, and deadlines do not terminate targets. Result consumption does not end reconciliation:
  retain it through target terminal state and local Loro flush, and preserve it through SQLite
  cleanup/restart. Missing evidence or writes retain an owned retry and never wake the agent.
  Unchanged progress must return before `updateHistory` / `Mirror.setState` to prevent
  self-waking loops. Test with real Mirror subscriptions.
- Missing Session metadata, a recoverable tombstone, or an unsynchronized
  Machine Flock document is uncertainty, not permanent absence. Keep the item/result pending until positive evidence or deadline.
- Deadlines finish the root with item `TARGET_TIMEOUT` results but never cancel
  target Turns. Operation cancel is the only best-effort remote-cancel path.
- Store paths require explicit machineId (`getLodyOperationStorePath` has no default),
  resolved by MCP from trusted Session context, never its environment or a fallback.
- `session_create_many` and `session_chat_many` target writes bypass cooperative
  Session/Turn quotas. Preserve the bypass in both MCP-process materialization
  and daemon recovery replay; otherwise quota rejection degrades into a false
  `TARGET_TIMEOUT`.
- Tests use injected clocks and explicit reconciliation/idle barriers.
