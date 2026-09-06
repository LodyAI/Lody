# apps/cli/src/lib/review-automation — responsibilities and rationale

Binding rules live in [AGENTS.md](AGENTS.md); this file is the navigation index and
the reasoning behind those rules.

## Files

- `review-automation-plan.ts` — PURE policy. Every gate that can spend tokens,
  write to GitHub, or merge lives here. All states are "waiting for" states,
  which is what makes a pass safely repeatable: unchanged facts return `wait`
  rather than dispatching the same prompt twice.
- `review-automation-submit.ts` — PURE. Folds one reviewer submission into a
  run. Owns the convergence rules.
- `review-automation-store.ts` — reads/writes the workspace review Flock doc.
- `review-automation-engine.ts` — gathers facts, calls the planner, performs the
  action.
- `review-automation-github.ts` — `gh` access (facts, comment, merge).
- `review-automation-scheduler.ts` / `-workspace.ts` — coalesced passes and the
  document subscriptions.
- `create-review-automation.ts` — assembles the above; wired in `lody-fleet.ts`.

## Why this is not MCP orchestration

Two hard constraints, not preferences:

- `LODY_MAX_CHAIN_DEPTH = 5` (`packages/shared/src/session-orchestration.ts`) is
  fixed and explicitly non-configurable. A loop that can run several rounds cannot
  be built from MCP session calls — it dies at depth 5.
- `specs/session-orchestration.md`: "MCP observes only Lody-owned state. GitHub,
  CI, webhooks... are outside this contract." This loop is mostly a reaction to
  exactly those.

Stepping around the chain-depth guard is what makes the run's own budgets
load-bearing: they are the replacement safety mechanism.

## Two modes, one engine

`ReviewRun.mode` is either `review_only` (the "Review this branch" action) or
`review_and_merge` (the checkbox). A one-shot review is the full loop with one
round and no authority, ending in the terminal `reviewed` state as soon as the
reviewer reports. The point is that the user learns one concept, and the
low-stakes action is how they meet the reviewer before handing it a branch.

## Why `approvedSha` stamping is a disjunction

All three neighbouring rules have shipped as bugs, which is why
`resolveApprovedShaPatch` is exported and unit-tested:

- Stamp only when unset → stale sha. After a CI-fix push the check compares
  old-vs-new forever: spot check → approve → still unequal → spot check. That loop
  consumes no budget and never throws, so nothing stops it.
- Stamp unconditionally → pins a head the reviewer never judged, silently retiring
  the check.
- Stamp only on a fresh approval → dead in the approve-then-open-PR order, which is
  the PRIMARY flow. The approval predates the PR, so there is no head to record; by
  the time one exists the state has left `reviewing` for good and `approvedSha`
  stays unset for the whole run, so any later push merges unreviewed.

## Why gated states keep failing the same way

Several deadlocks have been shipped and fixed here, most with the same shape — a
gate whose only satisfier was downstream of the gate. `creating_pr` and `merging`
use `stateAgeMs` grace windows because PR association arrives out-of-band (webhook
or the poller's discovery lane), so a turn ending without one is not yet an error,
and a crash mid-merge must be re-evaluated rather than parked. When adding a state,
ask what writes the thing that lets it leave.

Related history: `awaiting_confirmation` mixed with transient blockers used to
report a false terminal error on every first merge whose CI was slower than its
review, and on every no-CI repository before the time-earned exemption existed.
Round-keyed finding ids (`r{round}-{n}`) collided because a CI spot check
deliberately does not bump the round.

## Storage

Policy, machine reviewer configurations, and runs share one workspace-scoped
Flock doc (`<workspaceId>:rp`, `packages/shared/src/review.ts`). A dedicated Loro
doc per run was rejected: a new document type needs plane routing
(`getPlaneForDocRoom`), and a room that resolves to no members stops syncing
without erroring. Flock rows also give the scheduler a cheap enumeration of
active runs.
