# Stop exhausted authentication recovery

Status: implemented
Translation: current

[中文](2026-10-10-bounded-auth-recovery.zh.md)

## Abstract

Authentication recovery capped its delay but not its attempts, leaving clients in
an endless loading loop when session and Convex identity disagreed. The supervisor
now permits six attempts, bounds each attempt to 15 seconds, and displays a
persistent dialog with explicit retry and sign-in actions after exhaustion. It
retains page state and does not equate network failure with session revocation.
A sustained healthy interval resets the budget; brief success does not.

## Decision and evidence

The provider owns scheduling, timeout retirement and session fencing. Loading,
offline and visibility transitions do not replenish attempts. Timed-out session
requests may still finish in the underlying SDK, but cannot restart Convex through
this supervisor. The deadline also covers a missing Convex loading transition.
A new session retires old work before starting a fresh budget.

Immediate sign-out was rejected because authentication mismatch does not prove
that the underlying session is invalid. Keeping infinite capped backoff was
rejected because it provides no stable failure or user-controlled escape.
The dialog preserves the mounted route and uses the existing sign-out action.
The [behavior contract](../../../../specs/auth-recovery.md) remains a draft.
This complements the [telemetry filter](2026-10-09-posthog-auth-error-filter.md),
which does not control recovery itself.

Fake-timer provider tests cover rejection, hanging requests, missing auth-reset
transitions, stale completions, session replacement, offline transitions,
transient authentication success, exhaustion and explicit retry. Related query,
session and token-provider tests pass. Live credential expiry remains outside
these deterministic tests; deployment is not performed by this change.
