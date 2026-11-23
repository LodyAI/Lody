# Stored state fills with accent

Status: implemented
Translation: current

[中文](2026-09-22-stored-state-accent-fill.zh.md)

## Abstract

Checked controls — Checkbox, Radio and Switch — now fill with the palette's
accent colour instead of ink. The
[choice controls note](2026-09-10-ui-choice-controls.md) settled stored state as
the `label` fill with a `background` mark on top, reserving `accent` for live
state such as the focus ring. Visual review preferred a coloured fill: a stored
value is exactly the state the eye should find, and an ink switch reads like a
raised black button rather than an on-state. One token, `field.checkedFill`,
moves the whole family's stored fill from `colors.label` to `colors.accent`; the
mark on top stays `colors.background` and the top highlight stays the ink edge.
In the Vesper palette `accent` is the warm tone, so a checked control is orange
there rather than blue — stored state follows the palette by design.

## Decision

`checkedFill` is re-declared in both places the group lists palette-valued
tokens: the `field` definitions and `fieldPaletteTheme`, so a forced-palette
subtree keeps the accent rather than the root palette's. The `Toggle` contrast
is unchanged — a pressed toggle still sinks into the well rather than filling,
because it rests on nothing; the AGENTS rule now reads "on is the well, not the
accent". `specs/ui-primitives.md` (draft) is updated: the stored-value passages
and the evidence links state the accent fill.

## Trade-offs and limits

Ink and accent no longer separate stored from live state — the accent now means
both the focus ring and a stored value. The mark and the ink edge highlight are
unchanged, so a checked box keeps its raised look on the accent fill. Verified
on the token board in both palettes: Lody Light shows the blue fill, Vesper the
warm one. No test asserts the rendered colour.
