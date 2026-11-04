# Size GitHub credential deadlines for a slow token service

Status: implemented
Translation: current

[中文](2026-10-15-github-credential-deadlines.zh.md)

## Abstract

Sessions on private repositories failed before their first prompt because both
managed credential sources timed out: the broker gave the cloud token request
2.5 seconds and the Git/gh helper gave the broker 3 seconds, while the host's
event loop was stalling for several seconds. Public repositories hid the fault by
falling through to anonymous access. The cloud deadline is now 15 seconds and the
helper waits 20 seconds, so the inner request always expires first. Verification
probes were restored toward their earlier budgets. Whether the hosted token service
or local stalls dominate was not measured.

## Evidence

On 2026-10-15 a Claude session for a private repository failed during worktree
preparation with `personal`/`app` `acquire timeout`, `anonymous`
`git_advertisement_failed`, then `credentials_exhausted`. The broker logged 82
`upstream_error`/`TimeoutError` results that day at 2.6–3.6 seconds elapsed, the
2.5-second abort plus local delay. Direct requests to the cloud endpoint took
about 0.3 seconds, and GitHub was reachable. The daemon worker averaged about 50%
CPU, and its event-loop monitor reported 4.7–9.5-second stalls; sub-5-second
stalls are not logged. A public-repository session in the same minutes succeeded.

## Decision

[Identity fallback](../architecture/2026-10-03-github-identity-fallback.md) (#1224)
introduced the 2.5/3-second pair and shortened neighbouring budgets. The pair left
0.5 seconds for broker handling, so a short host stall aborted the helper even when
the cloud answered in time. Each source is still tried once with no retry. A slow
source now delays the operation instead of failing it, which is preferable to
dropping to a lower-priority identity or failing session setup.

| Budget                          | Before #1224 | #1224 | Now  |
| ------------------------------- | ------------ | ----- | ---- |
| Broker → cloud token RPC        | none         | 2.5 s | 15 s |
| Helper → broker `/github-token` | 15 s         | 3 s   | 20 s |
| Git access advertisement probe  | 10 s         | 5 s   | 15 s |
| Native `git credential fill`    | 5 s          | 3 s   | 10 s |
| SSH `ConnectTimeout`            | 5 s          | 3 s   | 10 s |
| gh `auth token`                 | 5 s          | 3 s   | 10 s |

The cloud deadline is now an unref'd timer that also covers the response body,
so fake timers can test it. The broker logs successes taking 2 seconds or more,
so a shrinking margin is visible before it becomes a failure.

## Verification and limits

Owning suites cover a 10-second response succeeding, a hung request aborting at
the deadline, caller cancellation, and the cloud deadline staying below the
helper's. Helper-script budgets are interpolated constants; spawned-script tests
do not wait real seconds. `clones recursive native SSH submodules while cloud
credentials fail` fails identically on the unmodified base in this Lody-hosted
environment (`context_unreadable`). No measurement separated hosted latency from
local stalls; event-loop stalls themselves remain unfixed.
