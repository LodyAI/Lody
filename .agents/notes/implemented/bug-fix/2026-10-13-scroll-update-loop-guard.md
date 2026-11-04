# Bound synchronous conversation scroll update cascades

Status: implemented
Translation: current

PR: [#1534](https://github.com/LodyAI/Lody/pull/1534)

[中文](2026-10-13-scroll-update-loop-guard.zh.md)

## Abstract

The scroll engine's per-transaction commit limit does not bound consecutive
transaction restarts or scroll callbacks that keep changing parent state. A new
controller budget allows 24 unsettled commits within a synchronous execution batch,
then records diagnostics and throws a specific error to the message-list boundary.
The boundary unmounts the unstable list while preserving the composer, and explicit
retry creates a fresh controller. This contains synthetic engine-driven cascades;
it neither proves the cause of the reported production React #185 nor detects
independent loops in every child component.

## Detection and exit

`afterCommit` counts work that has not settled, across row-key changes and
transaction restarts. Healthy transactions retain their existing six-commit bound;
24 supplies headroom for several consecutive transactions. Exceeding the budget is
a suspected non-convergent cascade, not a mathematical proof of an infinite loop.
Hidden, empty, disposed, and already-settled commits do not consume the budget.

The host schedules one microtask to reset the counter after synchronous execution
unwinds. The callback never writes a position, reports a viewport, requests a commit,
or retries a transaction. Independent user events and streaming updates therefore
do not accumulate the budget across batches. The failed controller keeps its error
latched even after the counter resets.

Exhaustion cancels an in-flight glide, clears the transaction, records an
`update-loop` diagnostic, and throws `ConversationScrollUpdateLoopError`. The trace
includes synchronous commit count, intent, target/actual position, and anchor keys;
the existing copied report includes that trace. Diagnostics contain geometry and
identifiers, never message text. The ring buffer retains the detailed entry too.

Silently dropping further commits could leave an uncovered or overlapping viewport.
Automatically rescheduling the same work could restart the cascade. The existing
scoped fallback is the explicit recovery boundary; retry can fail again if the
underlying trigger persists. It does not reload or clear session data.

## Verification

Model coverage exercises repeated transaction invalidation, latched failure, and
many independent updates. The adapter test uses real React with alternating
scroll-driven parent state, asserts the specific boundary error and diagnostic,
then disables the trigger and explicitly retries to check mounted, covered,
stable rows. Existing seeded scroll, hidden-tab, native-input, and fallback tests
remain the owning suites. Dependency trees are borrowed from a local checkout;
workspace imports resolve to this checkout's sources.

The three focused suites pass all 122 tests, including 40 randomized model seeds.
Focused formatting and lint complete with no lint errors. The retry fixture
installs browser geometry before the restored controller's first layout effect;
a fully measured restored list need not issue a supplementary commit that would
otherwise hide late fixture setup.

The production crash remains unreproduced; see the
[investigation](../../proposed/bug-fix/2026-10-13-message-list-update-depth-investigation.md).
Full package type checking is still limited by missing dependencies and SDK type
mismatches in that borrowed environment. Root `pnpm check` and `pnpm format` cannot
complete without installed tools. Documentation checking outside the sandbox reports
82 broken links to absent ACP submodule files, with none in the changed document
scope. No full root check or device acceptance is claimed.
