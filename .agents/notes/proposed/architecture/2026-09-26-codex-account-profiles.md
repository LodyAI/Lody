# User-owned Codex accounts and endpoint credentials

Status: proposed
Translation: current

[中文](2026-09-26-codex-account-profiles.zh.md)

## Abstract

Multiple Codex accounts must not swap global authentication files or publish API
keys in shared provider environment state. The implementation uses immutable
host-owned profile bindings, native ChatGPT keyring storage, and system-vault API
generations while retaining existing local and remote provider interactions.
The pinned native runtime forwards Authorization during a same-host HTTPS-to-HTTP
redirect, so custom API requests require a user-side credential broker that rejects
redirects. Same-profile ChatGPT sessions retain concurrent native processes; missing
refresh evidence is not a reason to change that existing behavior.

## Decision

[The draft Spec](../../../../specs/codex-account-profiles.md) owns the intended
product contract. Profiles live under the execution host's Lody data directory;
nonsecret metadata binds workspace, machine, provider, profile, mode, and endpoint.
Codex owns OAuth refresh. Lody stages API key generations in `@napi-rs/keyring`
2.1.0, requiring durable Linux Secret Service rather than an ephemeral keyutils
fallback. No renderer reads saved secrets back. Remote input uses the existing
context-bound encrypted interaction channel, not a separate credential transport.

A per-launch loopback broker freezes the endpoint and generation. Native processes
receive only its random capability; its upstream fetch refuses every redirect and
does not echo provider error bodies. Only model/Responses operations are accepted.
This additional local process boundary is necessary despite the initial preference
for direct native requests. A general-purpose coding-agent prompt is not an acceptable
credential probe: validation sends only synthetic text with no tools through the broker.

Global auth-file swapping, plaintext encrypted-file lookalikes, API keys in
`AgentConfig.env`, and a hosted proxy were rejected because they violate isolation,
storage, or deployment boundaries. Native API environment injection was rejected
after the redirect experiment. A second OAuth token snapshot/refresh implementation
was rejected because Codex remains the credential owner.

The initial implementation incorrectly introduced an exclusive runtime lease based
on unproven refresh concerns. It is replaced by independently owned process-use
records, registered before checking the removal tombstone. Deletion first persists
the tombstone, then waits for all records to prove exit. Unknown processes delay
credential cleanup only. Late exit proofs address their own host-generated token,
never another process's record. Existing login-operation serialization is unchanged.

Native 0.156.0 reloads shared credentials before refresh but only serializes
within each process. A controlled two-process fixture confirmed that both can
submit the same old refresh token before either persists a successor. The
adapter's legacy session-open error handler previously interpreted the losing
process's "log out" message as authority to delete the shared credential,
potentially invalidating the winner. For managed ChatGPT profiles it now
propagates that error without automatic logout; legacy behavior remains. This
contains the destructive consequence but does not coordinate native refresh.
Cross-process refresh serialization belongs in the native credential owner,
not a launch-time lease or a second host OAuth implementation.
The adapter mitigation is tracked separately in
[acp-extension-codex PR #58](https://github.com/LodyAI/acp-extension-codex/pull/58).

A restored Session may carry a legacy `codexAuth` value. That value verifies the
historical identity but cannot authorize a new native process: launch now requires
the current Provider to retain the same managed binding. The local removal
reconciler is asynchronous and cannot substitute for this check. New Sessions do
not write per-Session launch configuration; the missing-Provider fallback already
rejected their normal restore path, but it left legacy-bound restores exposed.
The generic edit-dialog sign-in action also conflicted with immutable ChatGPT
bindings: a ready profile is deliberately rejected by the daemon. Editing such a
Provider now explains that another account needs a new Provider; initial login
during creation and API key replacement retain their respective actions.

Older daemons ignore unknown profile fields. A persisted NUL-containing
`runtimeOverrides.codexPath` therefore makes old launch/login resolution fail before
native auth can run; supported Flock readers remove only the exact marker while
retaining the profile contract for host validation. Ordinary user runtime overrides
remain forbidden. The marker is not a credential or executable override users edit.

## Evidence and limits

The exact managed runtime is Codex 0.156.0, macOS arm64 artifact SHA-256
`27a4c6ad8d63ab0988eb2a6699fb092d999b78845c75edad1eef674064a026de`.
Pinned upstream auth storage derives the native keyring account from canonical
`CODEX_HOME`. Its refresh lock is process-local. Cross-application keychain ACLs
blocked a manually seeded refresh experiment, which is not evidence of native
refresh failure or success. The later
[synthetic refresh probe](../../../../packages/acp-extension-codex/scripts/probe-refresh-contention.mjs)
used two pinned native app-server processes with one isolated file-backed home
and a barriered local refresh endpoint. Both submitted the same old token; after
one success and one simulated `refresh_token_reused`, only the winning process
reported a usable token. No real account, keyring refresh, or existing credential
was involved.

Executed isolated experiments used synthetic credentials only: system-vault
set/read/delete; real native API Responses completion without auth.json; different-port
redirect stripping; same-port HTTPS downgrade forwarding the secret; broker-protected
completion and downgrade rejection; two real native device logins, status, and logout
through a test HTTPS CONNECT fixture. On macOS the OS home must remain available for
the default keychain; isolate CODEX_HOME, Lody data, and Electron userData instead.
No real account or existing credential was inspected.

Behavioral tests cover generation rollback/cancel, restart, immutable bindings,
locked storage, independent homes, symlinks, concurrent/live/unknown/exited process uses,
late old-process proofs, deletion reconciliation, frozen endpoint submission, and
restore identity. The built OSS desktop passes synthetic API login and model replies,
two real native device logins and independent model replies, restoring A after B,
rejected key replacement preserving a working key, and UI vault cleanup. The
[maintained recorder](../../../../e2e/scripts/acceptance-codex-profiles.mts) retains
video and checks no profile writes `auth.json`; its external-wire fixture uses no real accounts.

`pnpm check`, formatting, public boundary, docs check, and E2E suite checks pass.
The existing encrypted RPC suite passes; a remote desktop end-to-end run has not
been performed. Windows/Linux vault execution and real-account keyring refresh
contention remain unverified. Synthetic native refresh contention is reproduced,
not fixed by the adapter's no-logout guard.
The recorder holds two same-account requests behind an explicit arrival barrier to
verify overlapping native execution, not refresh contention. Unknown native orphans
delay deletion cleanup, never session startup. The legacy external-history catalog
does not aggregate all managed profiles; bound replay refuses a missing provider.
New homes intentionally omit native global config/history; existing Lody project,
MCP, and skill setup remains in the normal launch path. Keep this note proposed
until independent delivery review completes; the Spec remains draft.
