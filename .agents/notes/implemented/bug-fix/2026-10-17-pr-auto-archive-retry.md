# Retain observed PR auto-archive work after an unsuccessful attempt

Status: implemented
Translation: current
PR: [#1666](https://github.com/LodyAI/Lody/pull/1666)

[中文](2026-10-17-pr-auto-archive-retry.zh.md)

## Abstract

A failed PR auto-archive consumed its observed status transition, so later metadata
updates could not complete the archive. The owning window now retains the unfinished
intent and retries the existing archive action with capped backoff. Accepted target
receipts let a retry distinguish a partially archived tree from a tree the user has
restored, even when native Repo observers expose only the final restored metadata.
This remains device-local, in-memory work; startup and restore do not create new
archive intents, and local-only desktop capability gating is unchanged.

## Decision and alternatives

[#1660](https://github.com/LodyAI/Lody/issues/1660) applies to the shared frontend
watcher with GitHub integration enabled. The public local-only desktop does not
expose that capability; no packaged-desktop incident is established.
Keeping the component unchanged would leave its supported transition behavior
broken after an unsuccessful attempt. Removing it would remove the existing
preference. Rolling back the previous PR snapshot would confuse observations with
unfinished execution and still provide no retry trigger. Instead, the watcher
keeps its observation baseline and a separate pending intent, and reuses
`archiveSession` for target discovery, accepted writes and cleanup.

```text
observed active PR transition -> pending intent -> archiveSession
  failure -> one retry timer -> authoritative target snapshot -> attempt again
  success / superseded intent -> forget pending work
```

The original [archive relation contract](../../../../specs/session-relations.md)
already permits partial completion and retry of an archived root. The
[retention decision](2026-10-01-archive-worktree-retention-contract.md) is unchanged.
The automatic-only `shouldContinue` check and caller-owned `accepted` set reuse the
action's existing authoritative target snapshot and successful write boundary.
A restored or removed accepted target retires the intent before cancellation of held sends
or archive writes. Manual archive retains its unwritten-creation behavior and
receives no new gate. Native `WorkspaceRepoLegacy.watch` can rehydrate both an
archive and a restore event to the final unarchived row, so UI metadata alone
cannot prove the accepted intermediate state.

The existing PR baseline suppresses startup. Pending-entry identity also supplies
completion and unmount fencing, so separate initialization, failure and active flags
are redundant. The archive action is stable for its runtime and store; retries
capture it directly.

## Ownership and failure containment

The trigger is an enabled terminal PR transition actually observed for a Session
owned by the current user. The window owns one pending intent and at most one
in-flight archive per Session. Each unsuccessful attempt waits 1 second, doubling
to a 30-second cap; unrelated metadata changes do not bypass that wait. Persistent
failure remains retryable without blocking other Sessions or manual actions.

Changing the runtime, user, Session owner, PR identity/status, applicable setting
or visibility retires superseded work. Owner-window loss and unmount clear timers
and subscriptions. A later callback cannot revive a retired intent. Already
started writes retain the existing captured runtime and target-set semantics;
this change does not pretend that canceling a waiter stops an accepted write.
There is no recovery handoff beyond the owning component's lifetime, durable
queue, new readiness wait or attempt-count limit. Background failures are observed;
a failing diagnostic sink cannot create an unhandled rejection.

A native Effect migration was assessed in feature/fix mode against Effect 4.0.2.
The existing archive action still orchestrates Promise-based pending sends and the
registered Repo Legacy facade. Wrapping that unfinished dependency chain would
not complete a native ownership unit, so migration is deferred without changing
the roadmap's migration facts.

## Verification and limits

The owning `use-session-actions` suite mounts the real watcher and uses the real
archive/restore actions, target selector and pending-send owner. It checks
successful recovery after merged/closed transitions, partial descendant failure,
manual root/Tab restore, persistent-failure isolation, capped retry scheduling,
in-flight deduplication, invalidation and startup/restore baselines. A real native
Repo case verifies coalesced archive/restore observation and authoritative retry
cancellation; a restored Session's newly held send remains deliverable. Removing
accepted-ID tracking makes that native case archive the restored root again,
confirming that the progress boundary is necessary.
Restoring the base watcher makes both merged and closed recovery cases fail.
The fixtures and injected failures are synthetic. No hosted writes, real PR
mutations or packaged-desktop reproduction are claimed.
