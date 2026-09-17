# Main-process desktop login coordination

Status: implemented
Translation: current

[中文](2026-09-17-desktop-login-coordinator.zh.md)

## Abstract

Desktop login previously required a React deep-link handler to drive a renderer
transaction that rolled back authentication when organization loading failed.
Completed callback replays could redeem a consumed code and trigger sign-out, while
most failures silently returned to the login button. The main process now owns a
PKCE attempt and revisioned result, and the renderer publishes authenticated identity
independently of workspace hydration. This removes renderer lifetime from exchange
ownership while retaining a deliberate limitation: main-process restart requires
fresh browser authorization.

## Decision

This complements the [browser account-choice change](../bug-fix/2026-09-15-electron-browser-signin-account-choice.md),
which exposed a manual link but did not change desktop callback handling. The new
[Spec](../../../../specs/desktop-browser-login.md) defines the client behavior.
The browser payload and Better Auth token endpoint stay compatible with 1.5.5.
Lody now generates state/verifier and performs the exchange through the existing
Better Auth client, preserving its cookie storage hooks. Using the SDK's opaque
requestAuth attempt map alongside an application attempt would leave two owners;
its local bookkeeping is therefore replaced, not mirrored or monkey-patched.

Main receives callbacks before renderer routing and retains the latest result for
new windows. Same-state replays after settlement do nothing; old states cannot
replace the active attempt. Cancellation and timeouts fence late publication.
AuthService serializes credential-mutating operations, and checks the abort signal
before and after exchange. Diagnostics omit tokens, callback URLs and user data.

Renderer subscription precedes snapshot retrieval; revision ordering rejects stale
snapshots. Pending queries are fenced. Failed attempts release held queries without
clearing an existing identity, and query durable session state for an uncertain
exchange outcome. Organization errors use the existing workspace guards with an
explicit retry button. CLI restart is triggered once by main after success.

Extending the five-second URL debounce was rejected because it cannot express
completed or superseded attempts. Keeping organization hydration inside authentication
was rejected because a recoverable resource failure must not consume another login.
Persisting PKCE across process restarts and changing auth libraries are out of scope.

## Verification

The existing callback suite now exercises the real main coordinator with synthetic
sessions, deferred requests and fake timers: PKCE challenge matching, duplicate
callbacks before/after success, superseded browser tabs, cancellation, timeout,
late success/failure, expired attempts, browser launch failure and restart recovery.
The browser handoff suite also covers visible desktop errors, retry and restored
exchange progress. Existing browser account-choice coverage is retained.
An in-memory Better Auth 1.5.5 server also verifies the real transfer/token
contract against coordinator-generated PKCE parameters without network access.

Packaged OS protocol dispatch and hosted login are not established by these tests.
Repository type checking, lint, i18n, boundary and documentation checks passed.
The complete `test:ci` suite passed outside the sandbox (loopback listeners are
blocked inside it), including all 137 Electron tests. No deployment or account
login is implied.
