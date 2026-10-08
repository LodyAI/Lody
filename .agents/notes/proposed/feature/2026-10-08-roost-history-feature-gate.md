# Roost history feature gate

Status: proposed
Type: feature
Translation: current
PR: [#1329](https://github.com/LodyAI/Lody/pull/1329)

[中文](2026-10-08-roost-history-feature-gate.zh.md)

## Abstract

Roost history is available behind an opt-in settings gate while Loro remains the
safe default for new sessions. The renderer passes an explicit backend choice at
session acceptance, and persisted session metadata keeps that choice immutable so
turning the gate off never makes an existing Roost conversation open through Loro.
Non-renderer creation paths also default to Loro because they cannot read the
renderer-local preference.

## Decision

The Experimental features section owns a master switch and a Roost history switch.
The effective gate requires both switches. The preference is stored per renderer
in local storage and is read before session creation.

When the effective gate is off, a new session has no explicit Roost selection and
the shared creation default resolves to Loro. When it is on, the renderer writes
`historyBackend: 'roost'` into the new session metadata before accepting its first
turn. A session that already has a persisted discriminator continues using that
backend regardless of later preference changes.

The switch does not migrate history, rewrite session metadata, or provide a
per-message fallback. A backend choice remains an immutable session boundary.

The CLI pins the published `@loro-dev/roost@0.1.2` npm package. Its lockfile uses
registry integrity instead of a sibling source directory. Only that exact version
is exempt from the seven-day release-age policy. The CLI resolves the Node client
through the package's ESM export; Electron stages the client from the CLI's
installed package before considering a sibling development checkout. The native
owner binary remains a separate build artifact.

## Verification

The session-actions contract tests cover both gates: Roost is selected only when
both are enabled, and the legacy Loro default remains when the master switch is
off. The settings Storybook story exposes the disabled, remembered, and enabled
states.

A standalone checkout without a sibling Roost tree passes
`pnpm install --frozen-lockfile`, workspace typechecking, and lint. Published
package API and Node client imports succeed. Client staging was checked for
darwin, linux, and win32 with x64 and arm64 file selections using synthetic owner
files; this does not verify native binaries. Full desktop packaging still requires
the target owner artifact.

Full `pnpm check` stops in the CLI suite with 3514 passed, 4 failed, and 7 skipped
tests. Three runtime-config assertions still expect a synchronous boolean from
`applyAcpRuntimeConfigPatch`, now a `Promise<boolean>`; machine registration's
expected capabilities omit `sessionHistory: 2`. These feature-test mismatches
remain unresolved in the npm dependency update.
