# PR Status Reconciler (`src/lib/pr-poller/`)

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Machine PR discovery, lifecycle, CI and merge/conflict reconciliation.
[Authorization](../../../../../specs/local-github-pr-observation.md).

## Architecture

Pure modules own policy; `pr-poll-scheduler.ts` wires facts → decisions → effects. Do not add priority/quota/selection/write-back
logic to the scheduler, the GraphQL client, or the workspace adapter.

Pure modules:

- `pr-poll-targets.ts` — metadata replica → status/discovery targets; owner
  normalization (`parentSessionId ?? sessionId`); idle-terminal fingerprint
  rule; archived/deleted exclusion; current PR = LAST `pullRequests` item per repository for Project groups.
- `pr-poll-priority.ts` — viewing presence + `lastMessageAt` → high/low lane
  (top-100 cap). Priority only shortens intervals; never a precondition.
- `pr-poll-quota.ts` — per-scope token bucket, provider safety-floor freeze,
  repo cooldowns. Lane-blind: answers "can scope X spend now, else when".
- `pr-poll-select.ts` — dueness (`max(lastSuccess + interval, lastAttempt +
floor)`, never a stored next-poll time), `(workspace, repo)` batching, lane
  fairness (≥1 of every N dispatches is low under contention), next wake.
- `graphql-batch-builder.ts` — batched query: status aliases + two bounded
  discovery aliases per branch (newest open + newest merged/closed) +
  `rateLimit`. No review decision/threads/check-run details.
- `github-graphql-client.ts` — pure parsing/mapping exports (CI, merge state,
  error taxonomy) + a thin fetch transport class.
- `pr-poll-writeback.ts` — deterministic current-PR selection (branch match →
  open/draft → updatedAt → number → array position), association planning,
  minimal meta patch (null = no write).

Effect adapters: `pr-poller-workspace.ts` (Loro repo + presence + credentials

- association endpoint + local machineId), `github-credential-resolver.ts`,
  `pr-poller-state.ts` (dedicated SQLite at `~/.lody/pr-poller-state.sqlite3`,
  house store pattern, row-level write-through; DISPOSABLE scheduling memory
  only — never a PR status cache, safe to delete; do not grow it into an
  observation store), `pr-poller-config.ts` (`LODY_PR_POLL_*`),
  `pr-status-poller.ts` (Effect service facade; fleet wires it in
  `lody-fleet.ts`).

## Invariants

- **Observation and webhook linkage are independent.** Publish authenticated exact-branch
  GitHub observations even if hosted association fails. Retry linkage under existing gates;
  runtime confirmations are separate from published metadata. The cloud port adds
  a shared repo cooldown and six-failure budget, reset on client recreation.
  Skipped association remains unconfirmed
  while GitHub observation and metadata publication continue. Clear an older fingerprint
  on linkage failure so terminal publication cannot suppress retry, including after restart.
  Without that port, never call product cloud. Tokens remain machine-local.
- **Fresh-meta is the write predicate.** Every write re-reads owner meta and
  diffs; there is no persistent status cache. Write never happens when nothing
  changed. `t` bumps only on `s`/`m` semantic changes. The re-read also
  revalidates `machineId` (migrated owners are not this daemon's to write)
  and, for discovery results, the repo/branch context — a mid-flight branch
  switch invalidates the old branch's candidates.
- **Success stamps commit AFTER effects.** `lastSuccessAt` (and the discovery
  fingerprint) are recorded only when the alias was actually queried, the
  provider result was valid (a malformed alias is never a confirmed empty),
  and the owner's association + write-back effects succeeded. Failed rounds
  keep the target due and retry — GitHub query included — at the attempt
  floor. Committing the fingerprint before effects loses newly discovered
  PRs forever on terminal owners (review finding; regression-tested).
- **Target keys identify the actual target.** Status keys carry the PR
  number, discovery keys the branch — a new PR / switched branch is
  never-refreshed and immediately due. Truncated (over-alias-budget) targets
  are NOT stamped as attempted; they stay due and form the next batch.
- **Associations.** Only the reconciler publishes `pullRequests` membership/order
  (current = last per repository). Other writers publish independent lifecycle records,
  never the array. Shared `session-pull-requests.ts` owns URL/source identity, provider
  revision ordering and read projection; all readers use it. Keep array status for old
  clients, including one terminal refresh until it matches. Webhooks use fresh,
  provider-clocked Flock entries; machines use the ordinary local writer. Retain orphan
  records until session purge.
  Rewrites strip legacy detail fields and `.r` readiness on touch.
- **Machine ownership.** Each daemon enumerates only session metas whose
  `machineId` matches the local machine; archived owners are excluded.
- **Deleted sessions get nothing.** Missing/tombstoned meta stops both writes
  and associations (the endpoint does not validate session existence).
- **Ambient authentication is recoverable.** Recheck local `gh` credentials on a bounded cadence,
  including missing/logout results. `/user` failure is not repository denial; unidentified
  credentials share a conservative quota scope.
- **Credential scope boundary.** Quota/cooldowns are charged to a stable
  GitHub user/installation scope, never token bytes; token rotation must not
  reset freeze/cooldown/bucket state. A token-invalid retry must pass the
  replacement scope's own gates before the second call.
- **Discovery requires `branchName` (Member `branch` for Project groups).** Never query by `baseBranch` (the
  starting ref — would associate unrelated PRs). Discovery continues while an
  open/draft PR exists (newer-PR detection); only idle-terminal owners
  (terminal PR + checkpoint matching repo, branch and owner/child activity) stop.
- **GitHub-capable direct local projects are tracked.** A local project using
  its original directory gets the same PR discovery and status targets when
  `githubRepoFullName` and runtime `branchName` are present. Its branch is shared
  mutable state and may be briefly stale after Git operations outside Lody; the
  next runtime branch sync / metadata reprojection is the accepted repair path.
- **Gated scopes short-circuit the wake.** An empty bucket is the STEADY state
  for a few repos sharing one credential. `scheduleWake` is the only wake entry
  point: it may move a wake earlier but never past a gate, so presence and
  metadata triggers defer to the scope's `availableAtMs`. `runWake` drops gated
  batches BEFORE resolving credentials, keyed by the last observed
  `repo → scope`, trusted no longer than the resolver's ambient refresh
  cadence so gating never delays a login or account switch;
  scope-wide skips log once per gate window; and a metadata write counts as a
  change only when `computePrPollMetaSignature` moves.
- CI demand follows [Automations](../../automations/AGENTS.md).
- **No turn-end hook.** `lastMessageAt` wakes terminal discovery. Persist the
  dispatched activity snapshot only after success; later activity remains due.
  Checkpoints outlive pruned targets. Never stamp fresh writeback activity.
- **Bounded initial sync.** Enumeration waits ≤60s for initial meta sync and
  retries outside the serialized scheduler chain; an unhealthy workspace must
  never stall healthy workspaces. After that one full projection, the metadata
  watcher must pass `sessionId` for both metadata and existence changes and
  maintain the scheduler's per-session replica with point reads; steady-state
  changes must never call the full workspace scanner. Events racing initial
  projection are queued and re-read before the replica becomes ready.

## Testing

`npx vitest run src/lib/pr-poller` from `apps/cli`. The scheduler tests advance
fake time in 1s steps on purpose: one big jump lets callbacks see `now` at the
window end while the fake clock lags, which busy-loops timers and flakes
boundary assertions.
