# Reconcile closed PRs until GitHub reports a final merge

Status: implemented
Translation: current

[中文](2026-09-13-terminal-pr-status-verification.zh.md)

Pull request: [#670](https://github.com/LodyAI/Lody/pull/670)

## Abstract

The session sidebar can show `closed` for a merged pull request because its compact
`SessionMeta.pullRequests` projection has neither provider version nor merge evidence. GitHub also
represents a merge as a `closed` webhook activity with a separate `merged` flag, while GraphQL's
`PullRequestState` distinguishes `CLOSED` from `MERGED`.

The reconciler now treats `closed` as a reversible state and keeps querying that known PR by exact
number. Only `merged` is final. A fresh stored `merged` value is absorbing during write-back, so an
older in-flight `closed` result cannot roll it back. No poll count or persisted fingerprint is used
as evidence that `closed` is final.

## State model

`draft`, `open`, and `closed` can change. `merged` cannot. This distinction controls polling:

- known `draft`, `open`, and `closed` PRs remain exact `pullRequest(number:)` status targets;
- a lifecycle change creates a new cadence key and is due immediately;
- known `merged` PRs produce no status target;
- branch discovery remains a separate association query and never verifies a known PR.

The lifecycle segment in a cadence key is disposable scheduling memory only. It ensures that an
`open → closed` metadata event does not inherit the previous open poll time. The key is removed
when the target disappears, so a later blind `merged → closed` overwrite becomes immediately due.

## Write ordering

The scheduler plans against freshly read owner metadata. If GitHub returned `closed` and hosted
fan-out wrote `merged` while that request was in flight, write-back retains `merged`. This is the
only lifecycle ordering rule that does not require a shared clock: GitHub cannot unmerge a PR.

Reversible states do not claim the same guarantee. A stale response may temporarily replace one,
but the target remains scheduled and converges on a later exact observation. Repeating the same
`closed` result never suppresses future checks.

## Failure recovery and rollback

Provider, parsing, or write-back failure leaves the target due for retry. A stale `closed` response
also leaves the target recurring; it is not a successful terminal verification. Operators can
disable the reconciler with `LODY_PR_POLL_DISABLED=1` or deploy the previous scheduler. The SQLite
state remains disposable cadence/quota memory and contains no lifecycle verification table.

## Evidence and limits

PR #649 is merged. On 2026-09-13, GitHub REST returned `state: closed` together with
`merged: true`, while GitHub's PR/GraphQL view returned `MERGED`. This proves the representation
boundary that can produce the split view; it does not prove whether the hosted write came from
incorrect webhook projection or delayed fan-out. A hosted webhook delivery timeline is still
required to distinguish those producers.

Deterministic tests cover exact identity, repeated stale `closed` observations followed by
`merged`, a late `closed` overwrite, a legitimate reopen, and an in-flight stale `closed` result
racing with a fresh `merged` metadata write. Tests use synthetic hosted writes and fake time; the
hosted delivery path remains outside this public repository.
