# Dimcode as an npx-backed builtin

Status: implemented
Translation: current

[中文](2026-09-22-dimcode-builtin-acp.zh.md)

## Abstract

Dimcode was unavailable in Lody's builtin provider picker. The integration adds a
stable builtin identity and launches the package's native ACP server through npx.
Version 0.5.10 is pinned so offline cache reuse and capability-cache identity agree.
Provider creation reuses durable live verification, and the supplied SVG inherits
theme color. An isolated smoke probe established ACP initialization and the
missing-credential failure; authenticated prompting remains unverified.

## Decision

The [Spec](../../../../specs/dimcode-builtin-acp.md) owns behavior. Unlike
[Bub](2026-09-11-builtin-bub-provider.md), which relies on a user-installed command,
Dimcode resolves `npx --prefer-offline -y dimcode@0.5.10 acp`. A floating npm tag
would undermine exact-version cache recovery and capability freshness, so the
package pin and source key share one version constant. No adapter, workspace
dependency, managed-runtime manifest, or automatic registration is added.

Bub's dialog setup observation is generalized to both providers, preserving
Bub-specific install guidance. Both TS and CJS local request validators accept
Dimcode, and CLI inference classifies its unambiguous name as builtin. No static
models or permission defaults are invented; upstream title ownership is left
unclaimed pending evidence from authenticated prompting.

## Evidence and limits

The public npm package metadata and `--help` identify the `dim`/`dimcode` binary
and `acp` subcommand. A temporary-home 0.5.10 probe completed protocol-v1
`initialize`; `session/new` returned authentication-required without credentials.
The packaged runtime also declares `.agents/skills` and `~/.agents/skills` as
its default skill roots; the builtin skill registry uses those roots.
No prompt, account login, or real user transcript was used. Automated coverage
extends launch/cache parsing, local validator parity, provider publication, and
the dialog's setup/retry/refresh behavior.

Validation: 125 relevant tests passed across the shared, CLI, and components
suites. All three package typechecks, scoped type-aware lint (zero errors),
i18n, public-boundary, formatting, and documentation checks passed. The full
repository build and authenticated end-to-end prompting were not run.

Before PR creation, full `pnpm check`, `pnpm format`, and `pnpm run docs check` passed.
