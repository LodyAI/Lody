# Count shared mention file failures at the request

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1359

[中文](2026-10-09-mention-file-fetch-accounting.zh.md)

## Abstract

Repository tree requests were shared, but every mounted mention hook reported the
same rejection separately. The request owner now calls one failure observer while
all consumers keep their error state and later attempts remain retryable. Typed
GitHub authentication errors and HTTP 429 gain the correct classification, and a
failed repository switch no longer retains another repository's paths. These are
code-backed defects, not proof of a production outage or its contribution to
aggregate telemetry volume.

## Evidence and decision

The [earlier cache decision](2026-09-23-portal-full-restyle.md#follow-up-reductions)
introduced memory / IndexedDB caching and in-flight sharing. Each hook's catch
still captured an event, and the PostHog object was a fetch-effect dependency.
File discovery runs for hydration even with the menu closed. GitHub fetching
reads metadata, ref and recursive tree, with the existing token manager retrying
a typed 401 once; a logical attempt is therefore not one HTTP request.

The cache accepts the first failure observer, including when a browser request
started before a mention joined. Notification survives consumer unmount and cannot
replace the original error if the observer throws. Failures remain uncached;
remount or source change retries, client identity churn does not. There is no
cooldown, background retry timer, or new menu retry affordance. Cache freshness
and eager hydration remain unchanged. Sampling was rejected because it would
hide independent failures; menu-only loading would change hydration behavior.

The real GitHubAuthError default message contained neither a numeric status nor
our recognized auth keywords. HTTP 429 also missed classification. Both are now
handled without sending raw messages. Existing platform telemetry disabling is
unchanged. The [draft contract](../../../../specs/mention-file-fetch.md) describes
the accounting and retry boundaries.

## Verification and limits

The focused cache / hook suites passed all 9 tests. Synthetic tests cover concurrent rejection, one observer, request duration,
uncached retries with the same error object, recovery, retained stale cache,
observer failure isolation, hook unmount, analytics-client churn and repository
switch failure. No raw production events, private sources or transcripts are
included. Aggregate counts cannot distinguish consumer amplification, remount
frequency, authentication failures, rate limits or network/service failures;
production attribution requires event-level evidence and deployment validation.

The full components suite passed: 557 files / 4,938 tests.
Root `pnpm check` passed typechecking and lint, then stopped at the unchanged
CLI native recursive-submodule test (`context_unreadable` from the Git wrapper;
3,645 CLI tests passed). `pnpm format`, i18n, Code Collab imports, platform and
public boundaries, and `pnpm run docs check` passed separately.
