# Preserve the inline Mermaid view on deactivation

Status: implemented
Translation: current

[中文](2026-09-21-mermaid-retain-view.zh.md)

## Abstract

Leaving an inline Mermaid canvas reset its pan and zoom, discarding the reader's
position. Deactivation now stops input while preserving the rendered SVG's view,
and activation no longer adds an outline. Retention ends with the rendered SVG's
lifetime; it does not add durable session state.

## Decision

This partially replaces the reset-on-release and activation-ring choices in
[click to activate](../feature/2026-09-10-mermaid-click-to-activate.md).
The [view contract](../../../../specs/mermaid-inline-view.md) owns current intent.

A weak map keyed by SVG retains the transform independently of the active canvas.
Reactivation restores its numeric state so the next gesture does not jump. Release
also ends pointer capture and clears drag state. The viewer gets a clean clone
and unscaled dimensions, preserving the inline view without a temporary reset.
A replacement SVG starts fresh, avoiding stale geometry from different content.

## Verification and limits

The existing Mermaid suite now checks retained drag state after Escape, retained
views after outside press, focus loss, Enter and viewer use, inactive wheel
behavior, and continued zoom on reactivation. Tests could not execute because
this checkout and the main checkout have no usable Vitest installation. Browser
visual verification remains unexecuted.
