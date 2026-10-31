# Automations

[Module guide](README.md); Session and Inbox own resource execution.

- Keep the ledger machine-local and private. Freeze rule revision, authenticated
  author, scope, grants and event at acceptance; intersect current grants at dispatch.
- Remote controls require verified, operation-bound proof and exact Session/daemon
  ownership. Do not advertise control until the verifier exists. [Decision](../../../../.agents/notes/proposed/architecture/2026-10-30-remote-session-automation-control.md).
- Observe facts through existing owners. A clock wake never proves capacity;
  missing windows, native identity, release or tool boundaries remain unknown.
- Persist a stable action/Session/Turn mapping before effects. Reconcile uncertain
  outcomes; only proven unsubmitted input may be materialized again with the same ids.
- Stage Session outcomes before Inbox release; recover only those staged identities.
  Never scan history for plausible work or replay a transcript for native continuation.
  Scan pending outcomes by due time; hashes identify duplicates, never recovery progress.
  Retain unconfirmed release and failed observations until a later successful check.
- External JavaScript checks conditions and returns false or a resume result. Keep
  event-to-action mapping internal; registration binds the same Session once.
- Commit a matched result and its continuation identity together. Never rerun a matched
  program; recheck admission and captured source evidence. Retry interrupted checks,
  reconcile accepted effects, and never use tool side effects as durable steps.
- CodeMode exposes only scoped `ctx` reads. Credentials and network auth stay with
  resource owners. Scope close joins interpreter and owner reads; no ambient shell or env.
- Capture source evidence on the Host, freeze it with the receipt, and recheck at
  admission. Active continuations retain source demand; results cannot forge provenance.
- Approved derived inputs use the existing Inbox after source/action admission; inherited revisions are frozen requirements, not new human configuration selections.
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
- PR poller: active CI waits and undelivered continuations retain current-PR demand,
  including terminal PRs, under existing quota/fairness gates. Actions denial cools
  only Actions reads. Source data belongs in this ledger, not poller scheduling state.
  Revalidate owner metadata before publishing.
- Fleet uses the shared workspace content policy to withhold Automations from encrypted
  workspaces until their automation channel is implemented, including control and retry paths.
