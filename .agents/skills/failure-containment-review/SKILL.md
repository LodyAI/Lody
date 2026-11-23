---
name: failure-containment-review
description: Review Lody PRs or local lifecycle and sync changes for failure-containment regressions and disproportionate owner/facade machinery. Use for changes to release, teardown, retry, fencing, readiness, transport or store-cache ownership.
---

# Failure-containment review

Find changes that make one owner stricter at the cost of everything around it.
The rules are in [failure containment](../../docs/failure-containment.md); this
skill is the procedure. Repository review rules still decide what gets reported:
read the root [`AGENTS.md`](../../../AGENTS.md#code-review-rules) and
[`.github/codex-review.md`](../../../.github/codex-review.md) first.

## 1. Fix the comparison

Record the reviewed revision or working-tree snapshot and the comparison base.
Use the requested base; these examples assume `origin/main`. Read the base version
of each cited file. A path already strict on the base is not a new regression.

For a PR, resolve its head and merge base:

```sh
gh pr view <PR> --json headRefOid,baseRefName,files
git fetch origin pull/<PR>/head:pr-<PR>
REVIEW_HEAD=$(git rev-parse pr-<PR>)
BASE=$(git merge-base "$REVIEW_HEAD" origin/main)
```

Without a PR, use the local branch and `git merge-base HEAD origin/main` (or the
requested base). For uncommitted work, record `git status --short` and inspect
staged, unstaged and relevant untracked files. `git diff "$BASE" --` covers tracked
working-tree changes; read new files separately without staging them. Cite local
paths/lines as a working-tree snapshot, not as a commit that lacks those changes.
If the base is unavailable, state the limit rather than inventing a comparison.

## 2. Collect candidates

Search the diff, not the whole tree, for changed failure semantics:

```sh
git diff "$BASE" "$REVIEW_HEAD" -U0 -- 'apps/*/src' 'packages/*/src' | rg -n \
  -e '^-.*\.catch\(\(\) =>' -e '^-.*catch \{' -e 'allSettled' -e 'AggregateError' \
  -e 'retain|fence|retir|failure[s]?\b' -e 'Promise\.reject\(' \
  -e 'dispose|destroy|release|close|unload|teardown' \
  -e 'timeoutMs|syncRoom|waitFor|handoff|confirm|receipt'
```

For working-tree review omit `"$REVIEW_HEAD"`, include the task's actual paths
(including guidance/skills when those are the change), and inspect untracked files.

Then classify each hit:

- **Removed tolerance.** A `.catch(() => {})`, `try/catch` or `allSettled` around
  cleanup was removed or narrowed, or a cleanup now throws.
- **New fence.** Retained state or repeated cleanup failure makes later callers
  reject. Automatic retry can still fence a resource under persistent failure.
- **New gate.** A new `await` on sync, confirmation, readiness or a peer receipt
  sits before an action that previously ran directly.
- **New accumulation.** An array or map gains failures or owners and has no bound.
- **Strict facade.** A compatibility method now propagates failures that its old
  implementation swallowed or logged.

## 3. Trace each candidate to the top

Follow the callers upward until you reach a top-level owner: workspace dispose,
application quit, a request handler, a UI acquire, or a CLI command. At each frame
record what the frame does when the call rejects. Look in particular for:

- a later step in the same sequence that no longer runs;
- a later destroy that removes recovery state during its owned recovery budget,
  or a terminal flush failure silently reported as saved;
- retained recovery without a named longer-lived owner or retention/retry bounds,
  a second Repo on the same database, or shutdown that cannot finish under quota failure;
- a memoized promise (`disposePromise`, `closeReceipt`) that caches the rejection
  and turns a partial teardown into a permanent one;
- a key whose only retry path needs the operation that the fence blocks, which
  is a deadlock in practice;
- a gate that runs on startup, periodic or forced paths as well as on the racy one.
- background or React cleanup callers that use `void` without observing rejection;
- concurrent acquires that duplicate cleanup instead of joining one in-flight retry;
- degraded gate results written into success caches, once sets or pending-write ACKs.

## 4. Test realism and the claimed hazard

Name the concrete trigger: IndexedDB quota or a closed database, SQLite busy, a
network drop during flush or close, an absent local peer, or a timeout. If an
ordinary environmental failure triggers the path, it is not a hypothetical edge
case under the review rules.

Then establish what the owner below actually guarantees after partial failure.
Shared reference counting alone does not prove durable data or safe reuse. Inspect
the relevant implementation and behavioral evidence when available; if it is not,
mark the claim conditional and name the missing verification. For authors, the
default is to preserve base behavior and record that condition in the owning Note.
Missing evidence alone justifies neither a new fence nor destructive cleanup;
investigate before changing the contract. Do not claim that the base is verified safe.

Distinguish awaited failure delivery from background observation, and independent
cleanup from destruction of recovery dependencies within their chosen lifetime.
At quit, sign-out or workspace deletion, check a bounded final flush, user-visible
reporting of unconfirmed persistence and resource release; persistent failure must
not prevent termination. A waiter deadline alone does not stop raw writes.
Cross-dispose recovery is optional: require a named longer-lived owner, bounded
retention/retry, and same-key acquire adopting the retained Repo or joining its
confirmed close before replacement. Never require an ownerless retry loop or a
second Repo on the same database. For gates, verify that unconfirmed/degraded
results remain observable and retryable rather than becoming authoritative answers.

## 5. Proportion pass

- For each new exported Service, Layer or helper, search for consumers outside its
  own module and tests. An export with none is speculative.
- For each new implementation, check whether the one it replaces still exists.
  An old implementation kept only for a type import is dead code.
- In a facade, look for maps or flags that mirror state the native owner already
  holds. Look for two places that decide the same status.
- Compare the size of the change with the
  [migration sizing guide](../../docs/cli-effect-ts.md#small-migrations-during-feature-and-fix-work),
  and name the independent units that could ship separately.

## 6. Report

Rank findings by impact. For each one, give:

1. `file:line` at the reviewed commit or working-tree snapshot;
2. the chain: realistic trigger → propagation through callers → user-visible effect;
3. the base behavior it replaces;
4. the smallest fix consistent with verified ownership, such as continuing
   independent cleanup with bounded recovery or terminal finalization, sharing cleanup retry without
   blocking safe reuse, observing background failure, or returning an explicit
   unconfirmed result without caching it;
5. whether the finding is verified in the code or conditional on unverified
   library behavior.

Under the GitHub Code Review bar, report only P0/P1. An ordinary failure that now
skips independent cleanup, prevents verified safe reuse or gates unrelated work
can meet P1; assess the actual user impact. Necessary exclusion of unsafe overlap
is not itself a containment regression.
Proportion findings are not P0/P1 on their own; include them only in design
reviews that ask for them.

Do not flag strictness already present on the base or complexity without a concrete
failure or maintenance cost. An automatic retry or deadline alone is not an
exemption: assess progress under persistent failures, shared retry, caller error
observation and whether degraded results poison authoritative state.

## Delegation prompt

When dispatching another agent, send this prompt with the placeholders filled in:

```text
Review <PR or branch> in the Lody repository against base <base>. Use the
failure-containment-review skill (.agents/skills/failure-containment-review/SKILL.md)
and the rules in .agents/docs/failure-containment.md.

Look for changes that buy local correctness or predictability with system
stability: cleanup failures that now abort teardown, retained failures that
permanently block a key, new waits or confirmations in front of work that did not
need them, unbounded failure buffers, and compatibility facades that became
stricter than their old callers expected. Then do the proportion pass: exports
with no consumer, superseded code kept alive, and facade state duplicating the
owner.

For every finding, verify the lower owner's partial-release/reuse guarantees and
trace a realistic trigger through callers to user-visible effects. Distinguish
independent cleanup from dependent destruction, awaited from background release,
and authoritative from unconfirmed gate results. Check bounded terminal shutdown
and named recovery ownership with same-Repo adoption on reacquire. Compare with the base and propose
the smallest safe fix. For local changes include staged, unstaged and task-relevant
untracked files. Cite the reviewed snapshot; mark unverified assumptions conditional.
Do not edit files.
```
