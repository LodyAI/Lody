# Failure containment in lifecycle code

A failure policy must preserve both resource safety and the availability the
underlying owner can support. This page explains release, teardown, retry, fencing
and readiness waits across the CLI, renderer and shared packages. The root
[`AGENTS.md`](../../AGENTS.md#contributions-and-checks) requires this guide for
lifecycle changes; Effect-specific
lifecycle rules are in the [Effect guide](cli-effect-ts.md#behavior-contract).
Reviewers use the [failure-containment review skill](../skills/failure-containment-review/SKILL.md).

## The trade this page guards against

Retaining unresolved resources and excluding unsafe replacement can protect an
owner. Applied without checking its actual guarantees, the same strictness spreads: a failed
release throws out of a teardown loop, a fence rejects every later caller, and a
new confirmation wait sits in front of work that never needed it. Each step is
locally more correct. Together they turn one ordinary I/O failure into a workspace
that cannot close, or a document that cannot reopen until the window reloads.

Establish what the underlying owner guarantees, including after partial release,
before deciding what must reject, retry, wait or remain alive. Reference counting
alone does not prove persistence, release atomicity or safe reuse after failure.

## Rules

**Match error delivery to the caller.** An awaited release, flush or close reports
failure through its documented result. Timer callbacks, React cleanup and other
fire-and-forget callers must observe rejected work at their boundary, keep custody
within the chosen recovery lifetime and record a bounded safe diagnostic; `void release()` does not
handle a rejection. Keep the owning drain/retry path able to report unresolved
work. Background logging neither confirms release nor replaces that owner, and
diagnostic sink failures must not become unhandled rejections.

**Continue independent cleanup; choose a bounded recovery lifetime.** Attempt sibling
cleanup even after one failure, collect results and report afterwards. Identify
which later steps destroy recovery state before choosing parallelism or order.
Protect those dependencies during the chosen recovery lifetime; this does not
require keeping a failed workspace alive indefinitely or inventing a retry loop.

Quit, sign-out and workspace deletion are terminal boundaries. Stop admitting work
and give the final flush a deadline within a bounded shutdown budget. If persistence
remains unconfirmed, report the affected scope and possible unsaved-data loss through
an available user-visible channel, then release resources and finish termination.
Do not turn a quota failure into endless retries or another approval gate. Reporting
must not itself block termination, and a failed flush must not be reported as saved.
A timeout on a waiter does not terminate a writer: cancellation/drain or termination
of its execution owner must prevent late writes before a replacement starts.

Recovery beyond workspace disposal is optional and needs an explicitly named,
longer-lived owner that accepts the Repo, storage and outstanding work. Bound its
retained resources, retry attempts and lifetime, and end recovery at terminal
boundaries using the same bounded finalization policy. Coordinate by workspace/database
key: a new acquire adopts that retained Repo, or joins its confirmed close before
creating a successor. Never open a second writer on the same database or reactivate
the disposed runtime and its retired UI resources. Without such a handoff, use the
bounded shutdown path; a rejected dispose receipt is not a recovery owner.

**Retry does not automatically mean refusing acquisition.** The next use can drive
retained cleanup; concurrent acquires for one key join the same in-flight cleanup
and creation, using the underlying coordination when it already exists. If the
owner guarantees safe reuse of its retained resource after failure, a failed
cleanup need not reject acquisition or require a new replica. Reject or defer a
successor only while proceeding would overlap an unresolved resource unsafely or
violate another verified owner guarantee. Keep recovery within its defined owner
and lifetime. If lower-owner safety cannot be verified, preserve base behavior by
default and record the assumption and missing evidence as conditional in the Note.
Missing SDK source alone justifies neither a new fence nor destructive cleanup;
investigate before changing that contract. Test persistent failures too: retrying and rejecting on
every request can be just as unavailable as a permanent fence.

**A new gate is scoped to the hazard that justifies it.** A readiness, handoff or
confirmation wait placed before an existing action applies only to the operation
that creates the race, such as the first probe after a configuration save, not to
every startup, periodic or forced call. It has a deadline and an observed typed
failure or unconfirmed result when its precondition cannot be established. Fall
back only where the action's explicit contract permits it. Make that degradation
observable and distinguish it from authoritative success: do not put an unconfirmed
answer in a success cache or once/completed set, or clear the pending write it did
not confirm. Preserve a retry/invalidation path and cancellation semantics; prevent
unhandled rejection at background entries. When possible, carry the
precondition (a version or write receipt) to the owner that can wait for it
locally, instead of making the caller wait on a second channel.

**Diagnostic collections are bounded.** Background failure buffers have a size
limit or a lifetime. A stream failure observed and recovered an hour ago must not
make an unrelated later close fail. Keep necessary full failures private with the
unresolved owner during its recovery lifetime; diagnostics use safe projections.
Trimming history is separate from ending resource custody through the bounded
shutdown or handoff policy above.

**A compatibility facade keeps its callers' failure semantics.** A Legacy facade
over a native owner preserves what its callers observed before: a release they
could ignore stays ignorable at that boundary unless the PR deliberately changes
it, names every affected caller and covers the resulting state. The facade projects
state from the native owner; it does not keep a parallel copy of attachments,
statuses or rooms that can disagree with the owner.

## Realistic triggers

Treat these as expected events, not hypothetical edge cases: IndexedDB quota or a
closed database, SQLite busy or locked, a network drop during a flush or close, an
absent or slow local peer, a timeout, a worker restart, and interruption during
shutdown. A change that turns one of them into lost availability is a shipped
regression, even when the happy path is fully tested.

## Blast-radius questions

Answer these in the owning Note for every new throw, fence, retained-failure map or
wait added to a lifecycle path. They complement the
[behavior contract](cli-effect-ts.md#behavior-contract).

| Question      | What a good answer shows                                                                              |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| Trigger       | Which realistic failure reaches this path, and how often?                                             |
| Spread        | Which callers above it stop, skip steps or reject as a result?                                        |
| Recovery      | Who owns recovery, shares concurrent retry, bounds retention and adopts the same Repo on reacquire?   |
| Base behavior | What did the previous code do, and why is the change worth its cost?                                  |
| Hazard        | What does the lower owner actually guarantee, including partial release, and what remains unverified? |
| Dependencies  | What stays alive within that budget, and how do terminal flush, reporting and release finish?         |
| Results       | Who observes background failure, and can an unconfirmed answer become authoritative state?            |

Behavioral tests for these paths inject the failure at the real boundary and assert
the resulting state: independent teardown completes, terminal shutdown finishes
within its budget and reports unconfirmed persistence, retained recovery has a
bounded owner and reacquires the same Repo, safe reuse stays available under
persistent failure, concurrent retry is shared, background errors are observed,
and degraded results remain retryable.

## Proportion

The same changes that over-apply strictness tend to over-build structure. Keep
both in check:

- A new Service, Layer or exported helper ships with a consumer in the same PR.
  Abstractions for later migrations wait for those migrations.
- When a new implementation supersedes an old one, delete the old one or record
  its remaining runtime consumers. Move shared types instead of keeping a dead
  implementation alive for a type import.
- Split independent units, such as a dependency upgrade, a transport rewrite and a
  consumer migration, using the [migration sizing guide](cli-effect-ts.md#small-migrations-during-feature-and-fix-work).

The [decision note](../notes/proposed/process/2026-10-16-failure-containment.md)
keeps the historical PR example, its reviewed revisions and its unverified assumptions.
