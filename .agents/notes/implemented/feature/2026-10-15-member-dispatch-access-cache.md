# Cache confirmed member access for one hour at dispatch

Status: implemented
Translation: current
PR: not created

[中文](2026-10-15-member-dispatch-access-cache.zh.md)

## Abstract

When a workspace member's message reached another user's Machine, every dispatch blocked on a live
control-plane access query, and a brief network outage left the turn pending even though the same
member had been allowed minutes earlier. Dispatch now keeps a local allow for a member, keyed by
requester and local project, for one hour after the control plane last confirmed it. A cached allow
dispatches immediately while the same backend query runs in the background to refresh or clear the
entry. The trade-off is revocation latency: while the control plane is unreachable, a revoked
member can keep dispatching for up to one hour.

## Problem

`decideSessionAccessFromCatalog` could only grant an owner-cached allow. Any requester other than
the Machine's signed-in user fell through to `canUseMachine`, which for members is always a real
backend call. On 2026-10-15 a workstation whose CLI account differed from the account sending
messages saw several `fetch failed` / `ETIMEDOUT` access queries within minutes, so every affected
turn became `indeterminate`.

## Decision

- The catalog workspace entry gains optional `memberAccessSnapshots` entries:
  `{ requesterUserId, localProjectId?, ownerUserId, machineId, verifiedAt }`. The local project is
  part of the key because project sharing is part of the backend verdict. `ownerUserId` and
  `machineId` record the CLI account and Machine whose check produced the allow. A grant only
  answers "may this member use this owner's Machine", so the policy requires both to match the
  current dispatch, and a workspace refresh under a different account or Machine drops all member
  entries. Review caught the earlier version: workspace refreshes preserved grants across an
  account switch, so a member allowed on account A's Machine was trusted after account B signed
  in, when both accounts shared the workspace.
- A member entry is fresh while `0 <= now - verifiedAt < 1 hour`. A timestamp in the future, for
  example after the clock moved backwards, is not trusted.
- A fresh entry returns `{ outcome: 'allow', source: 'member-cached' }`. Dispatch does not wait. The
  already-started backend query for that dispatch acts as the recheck: a confirmed allow rewrites
  `verifiedAt`, a definitive denial removes the entry, and `indeterminate` writes nothing.
- Uncached member dispatches record their confirmed verdicts the same way, as does the background
  retry fiber when it reaches a definitive answer.
- Writes prune expired entries and keep at most 64 per workspace. Workspace list refreshes preserve
  the entries, like the owner snapshot.
- The owner snapshot is unchanged and still has no expiry.

## Alternatives considered

- **Use the cache only as an offline fallback.** Online revocation would be immediate, but every
  member dispatch would still wait for the backend, and a hanging request would delay the turn
  until it failed. The owner path already accepts one dispatched turn after an online revocation,
  so the member path matches it.
- **Shorter or longer expiry.** The requester asked for 30 to 60 minutes. One hour bounds offline
  revocation latency, and an online Machine refreshes the entry on every dispatch anyway.

## Verification and limits

`apps/cli/tests/session-access-policy.test.ts` uses a real catalog file and an injected clock to
cover expiry at exactly one hour, project and requester keying, workspace refresh preservation,
denial clearing and pruning. `apps/cli/tests/session-dispatch-watcher.test.ts` drives the watcher
against the real catalog: an offline member turn stays pending without a cache, dispatches after an
online allow seeded it, and returns to remote verification after a denial. That test fails without
the watcher change.

Only message dispatch uses the cache. Session preparation, cancellation, and local-project RPC access
checks still query the control plane directly. The related defect where an `indeterminate` access
result finished the Operation Inbox input is recorded in
[Keep access-pending Inbox inputs admissible](../bug-fix/2026-10-15-access-pending-inbox-withdraw.md).
