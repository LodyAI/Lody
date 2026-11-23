# Bound Git identity preflight before agent startup

Status: implemented
Translation: current

[中文](2026-10-11-git-identity-preflight-deadline.zh.md)

## Abstract

Session startup awaited an optional Git identity-policy Promise without a complete-operation
deadline. A pending lookup could prevent agent launch until the restoration watchdog failed
the turn, despite a lower-level fetch abort. Bound each lookup to 3 seconds, retry once, and
then disable personal identity conservatively so startup can continue. Cancellation ends the
waiter and fences late identity application and launch; the underlying cause of the reported
fetch-abort failure remains unproven.

## Decision and trade-off

The 3-second deadline leaves a small margin over the existing 2.5-second fetch abort, while
limiting two hung attempts to approximately 6 seconds of scheduled time. Effect owns timeout,
retry and interruption; a temporary Promise facade bridges SessionManager. Per-attempt
AbortControllers belong to the existing Promise startup boundary and are captured rather
than re-read by Session ID, so an abandoned attempt cannot borrow a replacement's lifetime.
They do not claim to cancel all worktree or runtime preparation work.

This complements [ordered credential fallback](../architecture/2026-10-03-github-identity-fallback.md).
That network credential chain is unchanged. Commit identity lookup is a separate preflight;
only this read-only query retries, never an uncertain GitHub write or the whole daemon.
Immediate conservative fallback would be faster but would miss a transient recovery. A
fetch-only deadline did not provide the caller-side guarantee needed here.

The existing initializing detail shows `Resolving Git identity`; logs distinguish attempts,
timeout/rejection, resolved/fallback and cancellation with elapsed time. No new wire stage is
needed. [The initialization contract](../../../../specs/session-initialization-deadline.md)
remains draft.

## Verification and limits

Controlled promises and fake timers cover hung/rejected queries, one successful retry,
cancellation and late results. SessionManager tests exercise actual cold startup and verify
fallback reaches agent creation and persistence while retired attempts do not launch.
The four focused suites pass 314 tests. The complete OSS `pnpm check` passes with
inherited session Git shim variables and PATH entries removed from the test environment;
the CLI suite passes 3718 tests (4 skipped). The CLI production build passes with a
2 GiB Node heap cap. Documentation and formatting checks pass. Independent security,
race, scope and simplification reviews found no blocking issue. No production incident
reproduction or daemon deployment is claimed.
