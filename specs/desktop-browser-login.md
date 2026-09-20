# Desktop browser login

Status: draft
Translation: current

[中文](desktop-browser-login.zh.md)

When a cloud desktop user authorizes in the system browser, returning to the app
must either establish an authenticated identity or explain how to start a fresh
attempt. Opening a window alone is not authentication. Local OSS mode never starts
this flow.

## Ownership and recovery

The main process owns one current browser-login attempt: random PKCE state and
verifier, lifetime, exchange, and a revisioned result. React pages and product
windows observe that result; they do not own the exchange. A newly mounted window
subscribes before fetching the snapshot and ignores older revisions.

```text
waiting for browser -> exchanging -> authenticated
        |                  |
        +------> error <---+
                  |
             fresh attempt
```

Only the exact auth callback URI and matching current state may exchange a code.
Concurrent callbacks share the exchange. Completed, expired and superseded attempts
cannot exchange again or sign out a valid identity. A fresh attempt replaces a
waiting attempt; an exchange already in progress must settle first. Explicit
sign-out cancels the attempt and fences late results. Main-process restart loses
the in-memory verifier and requires a new browser attempt, not a verifier bypass.

The browser wait expires after five minutes; exchange has a 25-second deadline.
An exchange timeout has an unknown server outcome. The UI may query the existing
session but must not redeem the same code again. Browser-open, expiry, exchange,
timeout and restart errors have localized, actionable messages. A server rejection
of the code (4xx) is distinguished from transport and local failures, and missing OS
secure storage fails before the browser opens rather than after the code is spent.
Each failure also carries a short detail (HTTP status and server error code, or the
local error name, message and system code). The login page shows it and main logs and
reports it. Diagnostics contain the attempt id, phase, error category and that detail,
never callback, PKCE or session credentials.

## Local credential store

The desktop credential store (`userData/config.json`) is a cache of the server
session, not the source of identity. A stored credential that the current OS key can
no longer decrypt must not block sign-in: once the app is ready and secure storage is
available, it is copied to a timestamped `.bak` next to the store, removed, and the
user signs in again. An unparsable store is moved aside the same way at startup.
Values are never discarded while the keychain cannot answer (before app readiness or
while encryption is unavailable), because they may become readable again.

## Authentication and workspace preparation

Successful authentication publishes identity before organization hydration.
Organization loading and active-workspace selection remain independent, retryable
operations. Their failures cannot revoke identity; unavailable workspace data stays
behind the existing workspace readiness guards. CLI restart is a best-effort
post-authentication action, not a login prerequisite.

The browser still confirms which account to transfer. Both its automatic handoff
and manual app link can deliver the same callback safely. Starting a fresh desktop
attempt generates fresh state and verifier. The existing Better Auth 1.5.5
`/electron/token` contract and cookie/session plugins remain the exchange boundary;
the desktop owns PKCE bookkeeping instead of the SDK's separate in-memory attempt
map. The browser's callback payload remains `{ identifier, state }` in base64url.

## Evidence and limits

- Main coordinator: [desktop-login.ts](../apps/electron/src/main/services/desktop-login.ts).
- Renderer projection: [auth.ts](../apps/electron/src/renderer/src/auth.ts).
- Credential store recovery: [auth-storage.ts](../apps/electron/src/main/auth-storage.ts).
- Behavioral tests: [callback suite](../apps/electron/src/renderer/src/auth-callback-transaction.test.mjs),
  [store suite](../apps/electron/src/main/auth-storage.test.mjs).
- Decision and validation: [note](../.agents/notes/implemented/architecture/2026-09-17-desktop-login-coordinator.md);
  [unreadable store](../.agents/notes/implemented/bug-fix/2026-09-19-desktop-login-unreadable-credential-store.md).
- Actual hosted authentication and OS protocol dispatch require packaged-app acceptance;
  synthetic tests do not establish them.
