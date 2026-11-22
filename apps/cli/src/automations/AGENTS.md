# Automations

[Module guide](README.md); Session and Inbox own resource execution.

- Keep the ledger machine-local and private. Freeze rule revision, authenticated
  author, scope, grants and event at acceptance; intersect current grants at dispatch.
- Remote controls require verified, operation-bound proof. Every command, read and
  delivery acts as one principal (the verified remote requester, the active Agent
  input's author, or the machine owner for the CLI) who must currently be able to edit
  the target Session; recheck that access at delivery. Do not advertise control until
  the verifier exists. [Decision](../../../../.agents/notes/implemented/architecture/2026-10-30-remote-session-automation-control.md).
- Observe facts through existing owners. A clock wake never proves capacity;
  missing windows, native identity, release or tool boundaries remain unknown.
- Persist a stable action/Session/Turn mapping before effects. Reconcile uncertain
  outcomes; only proven unsubmitted input may be materialized again with the same ids.
- Stage Session outcomes before Inbox release; recover only those staged identities.
  Never scan history for plausible work or replay a transcript for native continuation.
  Scan pending outcomes by due time; hashes identify duplicates, never recovery progress.
  Retain unconfirmed release and failed observations until a later successful check.
- A run is a wait without a program, owned by the Host's run Scope, never by the check
  that starts it. Persist the start before spawn; a started run without a live owner
  is reported interrupted, never started again. Runs receive an explicit environment,
  not Agent credentials. Per-prompt text does not recommend Automation; MCP help limits `run` to work
  that must outlive the current turn and resume the Session on exit. [Ownership](../../../../.agents/notes/implemented/feature/2026-11-16-managed-long-runs.md);
  [guidance](../../../../.agents/notes/implemented/simplification/2026-11-21-automation-guidance-scope.md).
- External JavaScript checks conditions and returns false or a resume result. Keep
  event-to-action mapping internal; registration binds the same Session once.
- Commit a matched result and its continuation identity together. Never rerun a matched
  program; recheck admission and captured source evidence. Retry interrupted checks,
  reconcile accepted effects, and never use tool side effects as durable steps.
- CodeMode exposes scoped `ctx` reads, bounded HTTP observations and local commands in
  the Session workdir. Commands receive an explicit environment and no implicit shell.
  Scope close interrupts the interpreter and its operations. Credentials and network
  auth for observations stay with resource owners.
- Capture source evidence on the Host, freeze it with the receipt, and recheck at
  admission. Active continuations retain source demand; results cannot forge provenance.
- Session actions use normal admission/queue/Stop/permission owners. Idle maintenance
  expires on new input. Settled groups include unfinished automation and native work.
  Stop blocks continuation admission, not authorized condition reads; only explicit
  user restoration clears it. A stopped target is blocked, never a check error.
- Capacity recovery handles quota and structured Codex overload under one Session
  setting. Fresh available quota observations wake the same receipt; reset times trigger
  a recheck, not permission to dispatch. Unknown quota waits for new evidence. Enabling it also admits the recorded failure for the current input, once. Overload retries are bounded and retain the same release and input checks.
  Coordinate quota Schedule handoff and final acceptance under the Session Inbox gate;
  leave provider queries outside it. [Decision](../../../../.agents/notes/implemented/bug-fix/2026-10-30-discard-unassociated-quota-reservations.md).
- Native Effect owns the loop and interpreter. `workspace-legacy.ts`,
  `actions/session-actions-legacy.ts`, and `sources/sessions-legacy.ts` are explicit
  bridges to unfinished Fleet/Repo/Session Promise APIs. Join raw adapter work;
  remove each bridge when its owner migrates, rather than add a parallel runtime.
- Ledger predicates read normalized columns and indexes; the payload is the frozen
  acceptance record, never a query surface, so a new queryable field is a new column.
  Optional predicates compile to parameter-specialized statements — never
  `(? IS NULL OR col=?)` — driving queries keep positive `state IN` lists so their
  partial indexes apply, and demand readers take one workspace-scoped session set per
  pass, never a per-session lookup. The engine wakes on an explicit signal or the
  earliest durable deadline, capped at 15 seconds for staged-outcome reconciliation
  and auto delivery — no polling probe and no work-remaining rescan. A durable
  denial — revoked grant or authorization, superseded or deleted work — cancels the
  queued input end to end; only transient denials re-verify. Guard predicates share
  one `guard:` reason namespace at engine check and resource admission, so the same
  durable classifier converges both; cancellation preserves that reason. Capacity
  wake scans resolve candidates by the observed binding/model through normalized
  columns and deduplicate on the snapshot's `observedAt`.
  [Decision](../../../../.agents/notes/implemented/architecture/2026-11-21-automation-ledger-query-columns.md).
- Auto delivery requests only the existing quick-action text and facts the agent
  cannot discover, admitted under Session group settlement and a current-head guard.
  The daemon never mutates GitHub. Keep its per-kind repair limit and one merge
  request per head; exhausted limits stop with a reason, never retry.
  [Spec](../../../../specs/session-auto-delivery.md).
- PR poller: active CI waits and undelivered continuations retain current-PR demand,
  including terminal PRs, under existing quota/fairness gates. Actions denial cools
  only Actions reads. Source data belongs in this ledger, not poller scheduling state.
  Revalidate owner metadata before publishing.
- Encrypted workspaces run Automations locally. Session actions sign their queued input
  as this machine before the write, and encrypted admission refuses automation input
  without that signature. Remote control follows the shared `rpc` content verdict: Fleet
  installs the remote verifier, and the renderer offers remote controls, only where it holds.
