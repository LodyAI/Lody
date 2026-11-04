# Preserve desktop session fallback failures

Status: implemented
Translation: current

[中文](2026-10-20-desktop-session-fallback-errors.zh.md)

## Abstract

A stale renderer bearer can return 401 while the desktop still has another durable
cookie credential. If checking that cookie fails temporarily, returning the original
401 lets shared session verification interpret repeated checks as confirmed session
rejection and sign out. The desktop now preserves the fallback response or transport
error, reusing an already resolved identity for transport failure only within the
same authentication generation. Definitive rejection and explicit sign-out retain
their invalidation behavior; this does not establish a particular release regression.

## Decision and evidence

`AuthService.getSession` owns credential fallback and its generation-scoped cache.
The fallback result describes the most recent verification attempt; the rejected
bearer cannot establish that the alternative credential is invalid. HTTP errors
retain their status for the existing bounded recovery UI. Thrown network errors
and timeouts use the existing in-memory session only when its generation still
matches; cold starts surface the error without claiming an authenticated identity.
The reverse case also remains retryable: cookie rejection does not settle a
transient failure of the renderer bearer. Definitive invalidation requires both
attempted credentials to be rejected.

The change preserves the shared
[bounded recovery policy](2026-10-10-bounded-auth-recovery.md). Increasing retries
would not correct an erroneous terminal result, and suppressing every 401 would
break genuine revocation. Neither policy is changed.

The regression suite imports the real service, mocks Electron/network boundaries,
and uses synthetic credentials and fake timers. It covers repeated 5xx/status-0/429
fallbacks, recovery to success, transport errors, a hanging request, definitive
rejection, empty sessions and a late failure after sign-out. Hosted authentication,
OS keychain behavior and packaged restart behavior require separate acceptance;
these tests do not reproduce an end user's release-specific report.

Validation: the ten service cases plus the existing stable-session, recovery
provider and recovery-dialog suites pass (44 tests total). Workspace typechecking
and lint pass. Replacing the service with its pre-fix version fails all nine new
regression cases; the reverse case preserves pre-existing behavior. The docs check
has no errors and no diagnostics for this note pair; existing guide-size warnings
remain outside this change.
