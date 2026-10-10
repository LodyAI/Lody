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

When the effective gate is off, the shared creation default resolves to Loro.
When it is on, the renderer reads the target machine's capabilities before any
session write. It persists Roost only for a supported target; missing/older
capabilities retain Loro for that new session. An explicitly requested Roost
backend fails before metadata, history or warm-up if the target is unsupported.
An existing discriminator remains immutable regardless of later preference changes.

The switch does not migrate history, rewrite session metadata, or provide a
per-message fallback. A backend choice remains an immutable session boundary.

The desktop session hover card exposes that persisted choice as a neutral database
fact row, Roost or Loro, so users can identify a conversation's history backend.
Workspace, Updated and Pinned rows carry the same metadata-derived value;
legacy metadata without a discriminator resolves to Loro. The card receives the
existing row data rather than subscribing to settings or loading history.
The display contract is recorded in [session history writes](../../../../specs/session-history-writes.md).

The CLI pins the published `@loro-dev/roost@0.1.2` npm package. Its lockfile uses
registry integrity instead of a sibling source directory. Only the pinned browser,
native main and six matching platform package versions are exempt from the
seven-day release-age policy. The [native runtime integration](../architecture/2026-10-09-roost-native-runtime.md)
replaces the separately staged owner executable with the published
`@loro-dev/roost-node@0.1.1` package, while preserving this session-selection gate.

## Verification

The session-actions contract tests cover both gates: Roost is selected only when
both are enabled, and the legacy Loro default remains when the master switch is
off. The settings Storybook story exposes the disabled, remembered, and enabled
states.

Creation regressions additionally cover unavailable/older target capabilities,
explicit Roost refusal before side effects, and explicit Loro overrides. Both
renderer entry points and the CLI use the same capability resolver.

The hover-card change passes the components typecheck and 23 existing list/hover
tests. Chromium verification in Storybook covers Roost and Loro, English and
Chinese, light and dark themes, and opening the card by hovering a row.

The native integration now passes the full workspace checks and actual macOS
arm64 packaging, removing the earlier dependency on a separately supplied owner
artifact. It also corrects four outdated CLI fixtures: asynchronous runtime-config
writes are awaited and machine registration expects `sessionHistory: 2`.
Runtime and cross-platform validation limits are recorded in the linked native
runtime note.
