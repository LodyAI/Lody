# PR Status Reconciler (`src/lib/pr-poller/`)

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Machine-side reconciler for PR discovery/association, lifecycle, CI rollup,
and merge/conflict state. Compensation path for the hosted GitHub webhook →
Streams fan-out. Spec (normative):
`specs/pr-status-reconciler.md`.

## Architecture: pure decisions, thin effects

Every policy lives in a pure module; `pr-poll-scheduler.ts` only wires
facts → decisions → effects. Do not add priority/quota/selection/write-back
logic to the scheduler, the GraphQL client, or the workspace adapter.

Pure modules (deterministic, unit-tested without IO):

- `pr-poll-targets.ts` — metadata replica → status/discovery targets; owner
  normalization (`parentSessionId ?? sessionId`); idle-terminal fingerprint
  rule; archived/deleted exclusion; current PR = LAST `pullRequests` item.
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

## Invariants (expensive to rediscover — do not break)

- **Association before local write.** Discovered PRs go through
  `github:associatePullRequestForCli` and only then into meta — the backend
  hosted association is what the webhook fan-out keys on.
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
- **Current PR is the LAST `pullRequests` item; the reconciler is the
  ordering authority.** The hosted webhook fan-out is a blind single-PR
  overwrite and must not load Loro Streams;
  the reconciler re-discovers and re-associates overwritten current-branch
  PRs instead of expecting webhook writes to preserve the array. Reconciler
  rewrites emit `{url, status}` entries only — legacy detail fields
  (`number/repository/branch/headCommitSha/reportedAt`) are stripped once
  (ordering bootstrap), and legacy `.r` readiness is deleted on touch.
- **Machine ownership.** Each daemon enumerates only session metas whose
  `machineId` matches the local machine; archived owners are excluded.
- **Deleted sessions get nothing.** Missing/tombstoned meta stops both writes
  and associations (the endpoint does not validate session existence).
- **Credential scope boundary.** Quota/cooldowns are charged to a stable
  GitHub user/installation scope, never token bytes; token rotation must not
  reset freeze/cooldown/bucket state. A token-invalid retry must pass the
  replacement scope's own gates before the second call.
- **Discovery requires `branchName`.** Never query by `baseBranch` (the
  starting ref — would associate unrelated PRs). Discovery continues while an
  open/draft PR exists (newer-PR detection); only idle-terminal owners
  (terminal current PR + unchanged `repo|branch` fingerprint) stop entirely.
- **Direct local projects have no Session-owned branch.** A local project using
  its original directory (`useWorktree !== true`, with legacy `isWorktree`
  honored) gets no PR discovery, status polling, or post-turn automatic PR
  association. Its current branch is shared mutable directory state and cannot
  safely identify a Session's PR.
- **No turn-end hook.** Post-turn freshness comes from the `lastMessageAt`
  activity rule (high lane for 10 min); do not re-add scheduler callbacks to
  turn finalization.
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
