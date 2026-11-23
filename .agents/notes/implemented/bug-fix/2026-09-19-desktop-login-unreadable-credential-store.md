# Unreadable desktop credential store blocked browser login

Status: implemented
Translation: current

[中文](2026-09-19-desktop-login-unreadable-credential-store.zh.md)

## Abstract

A Windows user completed browser authorization and returned to the desktop app,
which then showed only "Could not finish sign-in". Every retry failed the same way
until the user deleted `%APPDATA%\Lody\config.json`. Credentials in that file that
the current OS key cannot decrypt are now backed up and dropped automatically. Missing
secure storage fails before the browser opens. Every login failure also carries a
credential-free detail, which the login page shows and main logs and reports.

## Diagnosis

`@better-auth/electron` 1.5.5 stores the session cookie jar encrypted with
`safeStorage` under `better-auth.cookie` in `userData/config.json`. Its fetch
plugin's `init` decrypts that value before *every* request, including the
unauthenticated `/electron/token` exchange, and does not catch the exception. On
Windows, `safeStorage` uses a DPAPI-protected key held in the profile's `Local State`
file. If that key changes, `decryptString` throws on every call. This happens when
`Local State` is rewritten or lost, or when the profile moves to another machine or
account. The exchange then rejects locally before sending any request, so the
one-time code is not spent. The `DesktopLogin` catch discarded the error and
published `exchange_failed`. A new browser attempt fails identically; deleting the
file is the only way out. The user's workaround confirms this path. Network, TLS,
clock and deep-link registration were all ruled out on the affected machine. That
machine had reportedly just been restored with a new Windows account or password.
DPAPI master keys are bound to the user's SID and credentials, so this is the likely
trigger: the old ciphertext survived the restore, but the key did not. This was
reported, not reproduced. The new detail line would show `Error: Error while
decrypting the ciphertext...` if it recurred.

A corrupt (unparsable) `config.json` throws from `Conf`'s constructor at module load
of `main/auth.ts`, which would stop the main process before any window opens.

## Decision

- `main/auth-storage.ts` wraps the Conf store backing Better Auth. On read of
  `better-auth.cookie` or `better-auth.local_cache`, it verifies the ciphertext
  decrypts. If not, it copies `config.json` to `config.json.unreadable-<ts>.bak`,
  deletes the key and returns `null`. The request then proceeds without a cookie,
  and the exchange sets a fresh one. Values are kept when the app is not ready or
  encryption is unavailable, because a failure then does not prove the ciphertext is
  lost. Verified ciphertext is cached per value to avoid a decrypt per request.
- An unparsable store is renamed aside and reopened empty at startup.
- Deleting the whole file was rejected as the automatic fallback. The file also holds
  cross-domain plaintext keys, and a scoped deletion loses nothing that could be read.
- `DesktopLogin` summarizes failures with `describeDesktopLoginFailure`:
  - Server 4xx becomes `exchange_rejected`, with the HTTP status, Better Auth code
    and message.
  - Other failures keep their category, with the error name, message and system
    code.
  - A dependency may throw `DesktopLoginFailure` with a specific category, as
    `secure_storage_unavailable` does before the browser opens.

  The detail travels as `ElectronLoginState.errorDetail`. The login page shows it
  under the localized message as selectable text, and `AuthService` logs it and
  reports it through the existing main-process PostHog client (cloud builds only).
  Request bodies, headers and callback payloads are never read.

## Verification

- `auth-storage.test.mjs` uses a real Conf file with a synthetic cipher:
  - A foreign-key ciphertext is backed up byte-for-byte, removed durably and not
    re-flagged after a fresh write.
  - Cross-domain plaintext is untouched.
  - Nothing is dropped before app readiness or without encryption.
  - A truncated JSON store is moved aside and reopened empty.
- The callback suite now drives a real in-memory Better Auth 1.5.5 server through
  the Better Auth client. An unknown code yields `exchange_rejected` with
  `HTTP 4xx INVALID_TOKEN ...` and no code or state in the detail. It also checks a
  transport failure's system code and the pre-browser secure-storage failure.

Packaged Windows DPAPI behavior and the hosted exchange are not exercised by these
tests.
