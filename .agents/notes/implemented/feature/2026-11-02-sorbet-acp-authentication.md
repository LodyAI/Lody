# Sorbet authentication and local control

Status: implemented
Translation: current

[中文](2026-11-02-sorbet-acp-authentication.zh.md)

## Abstract

Builtin Sorbet uses `@sorbetai/control` directly for interactive sign-in, credential metadata, custom Provider management, model refresh, and model catalog reads. Prompts and progress still use the existing protected Machine RPC or signed E2EE owned-execution boundary, keeping secrets on the target machine. Sorbet owns the shared data directory, locking, atomic replacement, migration, and reference checks; Lody supplies the directory and does not parse its files.

## Decision and evidence

Sorbet sign-in calls `control.authentication.methods()` and `control.authentication.login()` instead of starting an ACP process. The existing Machine RPC interaction stream carries text, secret, and single-select prompts plus authorization progress. Remote replies are encrypted to the target machine and bound to the request and interaction; secret defaults do not enter retained progress. The behavior tests cover negotiation, form replies, and stale-interaction rejection. Arbitrary forms and terminal authentication methods remain unsupported.

Credential descriptors, logout, custom Provider operations, provider refresh, and available-model reads use the public `@sorbetai/control` package directly. Each operation opens control for `<LodyDataDir>/sorbet`, performs the requested call, and closes the handle. Lody retains the existing Machine RPC `configId` validation and E2EE authorization, but does not duplicate the control API behind another internal interface and no longer starts a temporary ACP process for these management calls.

`credentials.list()` returns only provider IDs and credential types. Login persistence and logout remain inside Sorbet, so raw API keys and OAuth credentials do not cross the Host boundary. Custom Provider create, list, and delete use Sorbet's canonical stores and reference checks rather than reading or rewriting `providers.json`.

Both `@sorbetai/acp` and `@sorbetai/control` track the npm `alpha` tag. The lockfile records the resolved builds, while future installs may advance each approved alpha channel. Sorbet's control package brings its same-release runtime packages, which are exempted from the repository's minimum-release-age quarantine so a newly published approved control build can resolve as one compatible set.

The Sorbet state directory remains owned by Sorbet. Lody passes the same `<LodyDataDir>/sorbet` path to ACP and control; Sorbet owns its format, cross-process mutation leases, atomicity, migration, and cleanup. Lody never parses, exports, previews, or claims reset coverage for those files.

## Consequences

Sorbet authentication and management no longer pay ACP process startup, initialization, timeout, and teardown costs. Other ACP agents retain their protocol authentication paths. A running Node Agent may retain an older in-memory Provider registry until restart or host recomposition, and Sorbet documents a residual cross-process TOCTOU between Provider reference checking and mutation; Lody does not add a parallel lock that would falsely claim to close that gap.

## Verification

[`apps/cli/src/lib/sorbet-credentials.test.ts`](../../../../apps/cli/src/lib/sorbet-credentials.test.ts) verifies trusted local Sorbet identity validation, direct control calls, Provider operations, and handle closure after success or failure. ACP authentication coverage remains in [`apps/cli/src/agent/acp-authentication.test.ts`](../../../../apps/cli/src/agent/acp-authentication.test.ts). Real OAuth behavior and live Agent catalog recomposition are not exercised by these tests.
