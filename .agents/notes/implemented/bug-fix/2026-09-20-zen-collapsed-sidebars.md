# Reveal already collapsed sidebars when toggling Zen

Status: implemented
Translation: current

[中文](2026-09-20-zen-collapsed-sidebars.zh.md)

## Abstract

Toggling Zen after manually closing both sidebars changed only an invisible mode
bit, leaving the shortcut apparently unresponsive. The toggle now reveals all
available sidebars when their stored preferences are all closed. Ordinary Zen
hide/restore cycles still preserve asymmetric layouts. The intentional trade-off
is that the explicit reveal updates open preferences for the collapsed case.

## Decision and evidence

The [draft behavior](../../../../specs/zen-layout.md) refines the previous source
invariant that every Zen toggle must preserve preferences. Retaining that rule
for an already collapsed layout would retain the reported no-op.

The mounted desktop Session publishes its current right-panel state and reveal
action through `zenRightPanelAtom`, with identity-guarded cleanup on unmount.
The single app command reads it at dispatch time; the panel's existing owner
continues to manage tab selection and persistence. No second command registration
or new persistence format is needed. Without a mounted panel, only navigation
is revealed.

## Validation

The layout-state and command built-in suites pass: 14 tests, including both
closed, asymmetric layouts, repeated toggles, and no right-panel owner.
Components typecheck, scoped lint, formatting, and `git diff --check` pass.
`pnpm run docs check` reports 28 existing links into absent ACP submodules; none
concern the changed documents. Desktop UI interaction has not been exercised.
Root `pnpm format` passes; root `pnpm check` stops at the documentation site
because its `fumadocs-mdx` dependency is unavailable in this checkout.
Dependencies were reused through ignored links to an existing checkout; no manifest or lockfile changed.
