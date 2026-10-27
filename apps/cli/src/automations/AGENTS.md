# Automations

[Module guide](README.md); Session and Inbox own resource execution.

- Keep the ledger machine-local and private. Freeze rule revision, authenticated
  author, scope, grants and event at acceptance; intersect current grants at dispatch.
- Observe facts through existing owners. A clock wake never proves capacity;
  missing windows, native identity, release or tool boundaries remain unknown.
- Persist a stable action/Session/Turn mapping before effects. Reconcile uncertain
  outcomes; only proven unsubmitted input may be materialized again with the same ids.
- Stage Session outcomes before Inbox release; recover only those staged identities.
  Never scan history for plausible work or replay a transcript for native continuation.
- External JavaScript checks conditions and returns false or a resume result. Keep
  event-to-action mapping internal; registration binds the same Session once.
- Commit a matched result and its continuation identity together. Retry interrupted
  checks, reconcile accepted effects, and never use tool side effects as durable steps.
- QuickJS exposes only scoped `ctx` reads. Credentials and network auth stay with
  resource owners. Scope close joins worker and owner reads; no ambient shell or env.
- Capture source evidence on the Host, freeze it with the receipt, and recheck at
  admission. Active continuations retain source demand; results cannot forge provenance.
- Session actions use normal admission/queue/Stop/permission owners. Idle maintenance
  expires on new input. Settled groups include unfinished automation and native work.
- Native Effect owns the loop and worker. `workspace-legacy.ts`,
  `actions/session-actions-legacy.ts`, and `sources/sessions-legacy.ts` are explicit
  bridges to unfinished Fleet/Repo/Session Promise APIs. Join raw adapter work;
  remove each bridge when its owner migrates, rather than add a parallel runtime.
- PR poller: active CI waits and undelivered continuations retain current-PR demand,
  including terminal PRs, under existing quota/fairness gates. Actions denial cools
  only Actions reads. Source data belongs in this ledger, not poller scheduling state.
  Revalidate owner metadata before publishing.
