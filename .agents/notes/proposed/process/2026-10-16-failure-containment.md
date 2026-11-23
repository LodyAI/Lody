# Failure containment guidance and review skill

Status: proposed
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1607

[中文](2026-10-16-failure-containment.zh.md)

## Abstract

Review of a draft lifecycle migration exposed cleanup failures spreading to other
owners and waits affecting unrelated probes. The initial containment guidance
overcorrected with unconditional rejection, teardown, retry and fallback rules
that could themselves block safe reuse or destroy recovery state. This revision
bases those decisions on verified lower-owner guarantees and bounded ownership:
terminal shutdown reports unconfirmed persistence and releases resources, while
optional recovery across disposal requires a named owner and same-Repo adoption.
When safety cannot be verified, authors preserve base behavior and record the
condition. The review skill covers PRs and local snapshots; later behavioral use
is still needed to validate the guidance.

## Problem

The [Effect guide](../../../docs/cli-effect-ts.md#behavior-contract) asks who
retains an unresolved resource and who can retry cleanup, and its acceptance
matrix requires retaining the owner and full Cause on release failure. Root
`AGENTS.md` prefers explicit contracts over hidden fallbacks. Neither asks what
else stops working when the strict path fails. Read alone, they reward
converting best-effort cleanup into propagated failure and adding fences, because
each such change looks locally more correct.

The review bar compounds this. `.github/codex-review.md` excludes "hypothetical
edge cases", and storage or network failure during cleanup is easy to dismiss as
one. Reviewers can then dismiss an ordinary failure chain before tracing its impact.

## Evidence

### Historical PR snapshot

A review of draft PR #1607 at `9b5122ca`, comparing it with merge base
`d73db66f4`, found:

- `createManagedStoreCache.disposeAll` changed from swallowing store disposal
  errors to throwing `AggregateError`. The workspace `dispose` in
  `create-workspace-runtime.ts` awaits the three caches without a guard before
  `teardownTransport()` and `repo.destroy()`, and memoizes `disposePromise`. One
  failed lease release would therefore leave transports and the Repo open with no
  retry.
- After a failed disposal, `retainedDisposals` makes every later `get` for that
  key reject. The tracker's release callback needs a successful acquire first, so
  nothing retries automatically. `PromptShortcutSync` adds the same fence with
  `retiring` and `failure`. The PR's README claimed a shared native replica;
  this is not proof that every partial release permits safe reuse.
- Every local `acp-capabilities-refresh` began awaiting a Machine Flock peer
  receipt with a 20-second deadline. Only a probe immediately after a
  configuration save can race the write; when offline, other probes now fail.
- `WorkspaceRepoLegacy.failures` collects every non-interrupt background failure
  for the life of the workspace, without a bound, and `destroy()` fails with all
  of them.
- In the same PR, `WorkspaceRepo`, `workspaceRepoLayer` and the
  `openWorkspaceDoc`/`acquireWorkspaceRoom` helpers had no consumers.
  `LocalLoroTransportAdapter` stayed in place although only a type was still
  imported from its module.

These were found by reading the code; nothing was executed. Whether native lease
release actually fails under quota or offline conditions depends on `loro-repo`
and `streams-crdt` internals, which were not checked.
These observations describe that draft revision, not main or later PR heads.

### Local caller contracts

Local call-site inspection at `3ac76bad1` found that `store-ref-tracker.ts` tolerates pending disposal rejection before
recreating a store, documents retained dirty-document reuse, and invokes delayed
release through a `void` callback. Therefore neither mandatory acquire rejection
nor newly unobserved background rejection preserves its caller contract. Concurrent
acquires already share the cached creation promise; retained cleanup should join
the underlying single flight rather than start one retry per borrower.

`startup-acp-capabilities-refresh.ts` puts a config into `refreshedConfigKeys`
after a normally completed refresh. Returning a degraded answer as success would
therefore suppress later probes. Gate timeout must remain unconfirmed and retryable.
The cache's documented safety expectation still needs SDK verification after
partial release; preserve base behavior while recording this uncertainty rather
than adding a fence or assuming a later destroy preserves dirty state.

The renderer provider rules require one Repo view. Retaining a failed workspace's
Repo while reopening its database with another Repo would violate that boundary.
An unlimited retry driver beyond disposal also lacks an owner and can prevent
quit or sign-out under persistent quota failure. Protecting dependencies alone
does not establish a safe or available shutdown policy.

## Decision

- Add [failure containment](../../../docs/failure-containment.md) as the
  cross-module explanation. Condition rejection, exclusion and retry on verified
  ownership guarantees. Separate independent cleanup from dependencies protected
  within a bounded recovery lifetime, and awaited results from observed background failures. Keep gates
  explicit; degraded answers must not enter authoritative caches or once sets.
  Historical worked examples stay here, not duplicated in the maintained guide.
- At quit, sign-out or workspace deletion, attempt a deadline-bound final flush,
  report unconfirmed persistence and possible unsaved-data loss to the user, then
  release resources. Neither persistent quota failure nor reporting may block
  termination indefinitely. A waiter timeout does not establish writer termination.
  Optional cross-dispose recovery needs a named longer-lived owner, resource/retry/
  lifetime bounds and same-key coordination: reacquire adopts the retained Repo
  or joins its confirmed close before replacement, never opens a second writer.
  This transfers Repo custody, not the disposed runtime or retired UI resources.
  If SDK guarantees cannot be verified, preserve base behavior by default and mark
  the missing verification conditional; no new fence or destructive path follows
  merely from uncertainty.
- Add a binding summary and a required-read trigger to root `AGENTS.md`, and
  count a failure-containment regression as P1 in the Code Review Rules.
  `.github/codex-review.md` defines that term and states that ordinary storage,
  network and peer failures are not hypothetical edge cases.
- Add a Containment question and acceptance cases to the Effect guide. Preserve
  safe reuse under persistent failures, share concurrent retry, bound dependency
  lifetimes, test terminal finalization and observe background rejection.
- Add the `failure-containment-review` skill, linked into `.claude/skills`. It
  holds the review procedure and a delegation prompt; the rules stay in the doc.
  Include branch and staged/unstaged/untracked review without requiring a PR.
  Automatic retry or a deadline alone is not an exemption from review.
- Keep the compact PR-documentation rule in root `AGENTS.md`, so it covers guides
  and READMEs as well as Notes. The [note rules](../../AGENTS.md#when-to-write)
  retain only note-specific consolidation guidance. Shorten related root wording
  by requiring the existing selection/status rules in `specs/AGENTS.md` before
  creating or editing any Spec, including incidental edits during ordinary fixes;
  no approval rule moves into a dated note.

## Alternatives considered

- **Only a review prompt.** It would catch some regressions after the fact, but
  the authoring guidance that produced them would stay unchanged.
- **Always reject, always retry first, always finish teardown or always fall back.**
  These deterministic rules ignore safe retained reuse, background callers,
  dependency lifetime and authoritative caches. Rejected after call-site review.
- **Retain recovery dependencies indefinitely.** Rejected: persistent quota failure
  would block terminal shutdown or leave an orphaned Repo competing with a new one.
  Use bounded terminal finalization with an observable unconfirmed-write report,
  or optional bounded custody under a named owner. Ordinary quit needs no new
  human approval gate. Neither path treats a timeout as proof of writer termination.
- **Full rules in root `AGENTS.md`.** Keep the detailed distinctions in the guide.
  A summary with a required-read trigger follows the existing
  "before changing X, read Y" pattern.

## Limits

Documentation and skill metadata checks passed after initializing the referenced
submodules at their locked revisions. Markdown formatting uses the repository-version Oxfmt and this checkout's config.
This integration changes guidance only, with no product code changes. This checkout
has no registered SHA topics. Review covers caller code, persistent-failure shutdown,
same-database reacquire and unknown-owner defaults, not SDK release/destroy behavior
under injected faults. Unknown lower-owner safety remains conditional; the default
preserves base behavior, not a finding of data loss or a license for exclusion. The guidance
has not been validated on a later lifecycle implementation. The skill's search
patterns are a starting point and can miss differently expressed changes. Root
`AGENTS.md` remains above the 7000-byte warning threshold, as it was before this
change.
