# Store the CLI cloud token in the OS credential store

Status: implemented
Translation: current
PR: [#1421](https://github.com/LodyAI/Lody/pull/1421)

[中文](2026-10-10-cli-credential-keystore.zh.md)

## Abstract

The CLI saved its cloud login, including the long-lived access token, as JSON
under the data directory. That file now keeps the profile and machine id, and
the token is also copied into the OS credential store with `@napi-rs/keyring`
when macOS Keychain, Windows Credential Manager, or Linux Secret Service can be
opened. The file copy stays in place by default: an older CLI still requires
the token field, and removing it would make that version treat the machine as
signed out. `LODY_CLI_DROP_FILE_TOKEN=1` removes the field only after a
read-back of the same token. A missing store leaves the file login working.

## Decision

`credentials.json` remains version 3. Profile, machine id, and any unknown
fields stay in the file. The token is written with the binding's `Entry`
constructor, service `Lody CLI`, and a username of `cloud-token.` plus a
SHA-256 of the resolved data directory, so two installs do not share an entry.
A `target` is not used: on macOS it selects a keychain domain, and on Windows
constructing an entry with a target writes an empty password. Linux entries
require Secret Service. The kernel keyring is not used, and this path does not
add a second encryption key.

Reads prefer the file token when it is present, including when it differs from
the store, and otherwise use the store. A file token is copied into the store
on save and on read. The copy is kept only when a following read returns the
same value. Failure leaves the file as it was. `LODY_CLI_DISABLE_KEYSTORE=1`
skips the store. `LODY_ELECTRON_SESSION_TOKEN` is unchanged: startup still
exchanges it through the existing bootstrap and does not treat it as the stored
token.

Removing the file token is off by default. Turning it on rewrites the file
without the token only after the store read-back matches and a second read of
the file still contains that same token, so a concurrent login is not erased.
Logout and rejection of the current token clear the store entry and the file.
Clearing the store first means a crash still leaves the file token.

The file is published by opening a temporary file with mode `0600`, then
renaming it into place. On POSIX the data directory is created and tightened to
`0700`. Permission changes that fail are logged once and do not discard a
readable login. On Windows the published file is restricted to the current user
with `icacls` when that command succeeds.

This reuses the CLI's existing `@napi-rs/keyring` 2.1.0 dependency, already
external in the CLI bundle and staged with the desktop. The
[Codex credential vault](../bug-fix/2026-10-07-codex-credential-failure-recovery.md)
is a different entry and still has no file fallback. The binding is loaded with
`createRequire` so the package stays external.

## Compatibility

Existing files that already contain a token keep working with no extra prompt.
A machine without Secret Service, or a disabled store, continues to read and
write the file token and logs that choice once. A credential file that has
already dropped the token still supplies its machine id to the installation
identity path.

An older CLI that only accepts a file token would treat a removed token as
signed out. This release therefore keeps the file token until a later release
decides the downgrade window has closed. Operators who do not need that
downgrade can set `LODY_CLI_DROP_FILE_TOKEN=1`.

## Verification and limits

Unit tests cover read precedence, a verified removal, a store that throws or
returns a different value, a read during the removal window, a newer file token
left in place, logout of both locations, and POSIX modes. They also construct
two plain entries for the same install and check that the second still reads
the password, and they reproduce an empty password written by a targeted
constructor. Windows ACL behavior is covered by a failing restrict callback.
A separate CI job writes, reads from another process, and deletes a real
entry on macOS and Windows. The Linux job does the same when Secret Service
is available and otherwise skips. A Linux bus that exists but never answers
can still stall one synchronous store call; `LODY_CLI_DISABLE_KEYSTORE=1`
skips it. The desktop session store is unchanged.
