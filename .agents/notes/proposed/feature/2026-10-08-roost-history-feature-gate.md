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

## Verification

The session-actions contract tests cover both gates: Roost is selected only when
both are enabled, and the legacy Loro default remains when the master switch is
off. The settings Storybook story exposes the disabled, remembered, and enabled
states.
