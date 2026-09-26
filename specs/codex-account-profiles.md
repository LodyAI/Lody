# Codex account profiles

Status: draft
Translation: current

[中文](codex-account-profiles.zh.md)

A user adds named Codex providers such as Work, Personal, and Custom API through
the existing machine/provider settings. ChatGPT uses the existing device-login
interaction; Custom API confirms a Base URL and receives its key through the
existing secret-input interaction. Local and remote machines retain the same
setup, verification, retry, cancellation, and session-selection workflow.

## Ownership and transport

The execution machine owns each opaque profile, its isolated Codex home, and its
credentials. Shared provider state contains only the profile reference, mode, and
normalized endpoint. ChatGPT uses Codex's native keyring, never file fallback; API
keys use the host system credential store. Unsupported or locked storage fails
closed. Existing providers without a profile keep their native behavior and history.

Remote secret input uses the existing request-bound encrypted Machine RPC. No
hosted credential service or model proxy is introduced. OSS composition remains
local-only. API traffic passes through a per-process loopback broker on the user's
execution machine; it supplies the real key only to the confirmed endpoint and
rejects redirects. The native process receives an ephemeral broker capability,
not the upstream key. This does not sandbox malicious code running as the same OS user.

## Identity and lifecycle

One provider owns one immutable account binding. Changing endpoint or account
requires a new provider; existing sessions cannot silently change identity. New
profiles contain no copied global auth, history, or session database. Managed
profiles reject custom runtime and identity-changing environment overrides.
Preparation, start, resume, fork, edit/resend, verification, and title fallbacks
resolve the same host binding before launch.

Both distinct profiles and multiple native processes for the same ChatGPT profile
may run concurrently. Per-process use records only delay deletion cleanup until
every native process has exited; unknown orphans never block another session.
Lody does not add credential-refresh coordination or account scheduling.
Reauthentication must not replace an existing ChatGPT
identity; users add a new provider when a new login is required.

API key replacement stages a new vault generation, verifies a tools-free synthetic
Responses request, and only then atomically changes the active generation. Failure
or cancellation before commit preserves the old key. Running processes retain
their original generation. Host readiness precedes catalog publication; failed
publication is retryable. Deletion records local removal, rejects future launches,
and reconciles credential cleanup without deleting history or killing sessions.

The daemon advertises `codexAuthProfiles` v1. Persisted managed providers carry an
invalid executable-path guard for older daemons; supported readers normalize it
only as part of the typed profile contract. Old peers must fail, not use native auth.

## Evidence and remaining validation

Owners: [profile store](../apps/cli/src/agent/codex-profile-store.ts),
[credential broker](../apps/cli/src/agent/codex-credential-broker.ts),
[decision and validation limits](../.agents/notes/proposed/architecture/2026-09-26-codex-account-profiles.md).
This draft does not assert completion of all lifecycle or platform acceptance tests.
