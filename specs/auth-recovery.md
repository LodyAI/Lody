# Bounded authentication recovery

Status: draft
Translation: current

[中文](auth-recovery.zh.md)

## Behavior

When an authenticated cloud client loses authentication, it tries to restore it
without discarding the mounted page or local data. Automatic recovery has six
attempts with increasing delays; each attempt has a 15-second deadline covering
session refresh and Convex authentication confirmation. Offline or hidden clients
pause scheduling without resetting the budget.

After exhaustion, protected requests stay gated and a persistent error dialog
replaces indefinite recovery feedback. “Retry connection” starts a new budget;
“Sign in again” uses normal sign-out and login navigation without clearing local
workspace data. Exhaustion alone is not evidence of an invalid session. Existing
confirmed-session-rejection handling still signs the user out.

A new session gets a new budget. Otherwise the budget resets only after 30 seconds
of authenticated state without another recovery request. Intermediate loading or
brief authentication success cannot turn repeated query rejection into an unlimited
loop. A timed-out or retired attempt cannot restart authentication later.

This contract does not change GitHub repository authorization, replay mutations,
or enable cloud authentication in the local-only client.

## Evidence

Implementation: `packages/components/src/providers/authenticated-convex-provider.tsx`.
Behavioral coverage: `packages/components/tests/authenticated-convex-provider.test.tsx`.
UI: `packages/components/src/components/auth-recovery-error.tsx`.
