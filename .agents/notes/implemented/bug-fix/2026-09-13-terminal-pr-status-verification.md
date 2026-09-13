# Verify terminal PR status by exact identity

Status: implemented
Translation: current

[中文](2026-09-13-terminal-pr-status-verification.zh.md)

Pull request: [#670](https://github.com/LodyAI/Lody/pull/670)

## Abstract

The session sidebar could retain `closed` after GitHub had merged the same pull request because
hosted fan-out may overwrite lifecycle metadata out of order. Terminal reconciliation now queries
the known current PR through exact `pullRequest(number:)` identity and persists a generation that
includes repository, URL/number, and stored lifecycle. A lifecycle overwrite therefore re-enables
verification; `closed` requires two spaced matching observations to cover GitHub's post-merge
read window, while `merged` is accepted immediately. Live hosted fan-out remains unexercised.

## Problem

The sidebar reads `SessionMeta.pullRequests`, while the active conversation fetches PR details from
GitHub. PR #649 exposed a split view: stored metadata said `closed`, but GitHub reported `MERGED`.
The hosted webhook-to-Streams path performs a blind single-PR overwrite, so the reconciler must also
recover when an older `closed` update arrives after a local correction.

A branch query cannot verify that contract. Discovery asks for the newest terminal PR with a given
head branch; multiple historical PRs may share that branch, and a valid response may omit the
stored current PR. Treating successful branch discovery as verification could stamp the wrong URL
and make the stale lifecycle permanent.

## Decision

Branch discovery retains its `(repository, runtime branch)` identity and remains responsible only
for association and current-PR ordering. The current terminal PR additionally produces an exact
status target using its parsed repository and number. Its persisted verification generation is:

```text
repository | PR number | PR URL | stored lifecycle
```

The scheduler records that generation only after the exact alias returned the identified PR and
fresh-meta write-back completed. If the exact terminal alias is missing or malformed, branch
discovery from the same owner cannot associate, write, or stamp its fingerprint because it lacks
the current PR evidence needed for safe ranking.

A matching `merged` result completes verification immediately. The first matching `closed` result
records target success but not the verification generation; a second result at the normal status
cadence confirms a genuinely closed PR. If the second result is `merged`, write-back creates a new
merged generation, which is exact-queried once before idling. Any later overwrite from `merged` to
`closed` changes the generation and automatically repeats this process, including after restart.

Scheduling state lives in the disposable SQLite `terminal_verification_fingerprints` table. It is
not a PR status cache; session metadata remains the write predicate and GitHub remains the source of
the observation.

## Alternatives

Using the terminal branch-discovery result was rejected because its identity is a branch, not the
known PR. Omitting lifecycle from the generation was rejected because a later same-URL overwrite
would match the old fingerprint and never self-heal. Indefinite terminal polling was rejected in
favor of one exact merged verification or two spaced exact closed observations.

## Failure recovery and rollback

Provider, parsing, association, or write-back failure leaves the generation unstamped and due for
retry. Operators can disable the reconciler with `LODY_PR_POLL_DISABLED=1`, deploy the previous
scheduler, and delete `terminal_verification_fingerprints` rows or the whole disposable
`pr-poller-state.sqlite3`; deletion causes conservative re-polling and loses no PR status data.

## Evidence and limits

Deterministic target, scheduler, and SQLite tests cover exact alias construction, a different PR
returned by branch discovery, `closed` followed by `merged`, a late same-URL `closed` overwrite,
restart with a persisted merged generation, and two owners sharing one repository and branch while
pointing at different terminal PRs. The full PR-poller suite exercises the real GraphQL batch
builder and parsed-result contracts around these scheduler tests.

The tests use synthetic observations and fake timers. A real merge timeline containing GitHub
responses, hosted fan-out writes, reconciler logs, final session metadata, and SQLite row changes
has not yet been captured; that operational evidence must be collected in a signed-in hosted
environment and must not be represented as completed here.
