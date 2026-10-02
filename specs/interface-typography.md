# Interface typography

Status: draft
Translation: current

[中文](interface-typography.zh.md)

## Abstract

Changing Appearance's font size should resize ordinary interface text together,
without flattening its hierarchy or changing font families. One document baseline
drives existing body, control, auxiliary and heading roles, including portals.
Terminal text keeps its independently saved preference and multiplies it by the
global scale. This draft extends the five-tier setting's reach; it does not imply
human approval of this revision or a redesign of the UI.

## Scenario and responsibilities

A person chooses Smaller, Small, Default, Large or Larger in Appearance (12, 13,
14, 15 or 16px). Sidebar labels, Composer input and choices, messages, tool output,
code, terminals, menus, dialogs, tooltips and form descriptions follow that
choice. Body remains larger than controls and helpers; headings remain larger
than body. Existing mono and brand faces stay unchanged.

Settings owns selection, normalization and persistence. The document controller
publishes one baseline. `@lody/ui` owns the existing text roles and their leading;
surfaces choose a role, not a second scale or a parent-relative size. Nested code,
compact tool prose and portal content must not multiply the scale twice.

| Role | Size / leading at Default | Typical content |
| --- | --- | --- |
| caption | 11 / 16px | Metadata, code language |
| footnote | 12 / 16px | Groups, descriptions, tooltip |
| subheadline | 13 / 18px | Controls, code, tool output |
| body | 14 / 20px | Sidebar titles, prompt, message prose |
| headline | 16 / 24px | Dialog heading |
| title | 18 / 24px | Page or Markdown primary heading |

Each size and leading is its Default value multiplied by the selected baseline
divided by 14. A standalone message preview with an explicit size retains that
size independently of the host document's baseline.

## Durability and boundaries

Keep `lody-conversation-font-size` and its existing normalization: legacy
`small/default/large` mean 12/14/16; older numbers snap to the nearest tier, ties
up; invalid values use 14. Reload keeps the selected tier.

Keep the saved terminal base size (9–24px, default 13), family, terminal instance
and buffer. Effective xterm size is `savedSize × baseline / 14`; its 1.2 line
height remains a terminal-specific metric. Changing the interface tier does not
overwrite the terminal preference.

Controls must fit CJK and Latin descenders at all five tiers; long text may wrap,
scroll or intentionally ellipsize, but must not introduce unintended page-wide
overflow. Keyboard focus and dismissal must survive font changes. Verify light
and dark palettes and a narrow desktop window.

This does not resize brand artwork, icon geometry or third-party document/canvas
contents. Intentional landing typography, diagrams, file viewers and editor
zoom remain outside this ordinary-text migration. No new font family or global
spacing scale is introduced.

## Evidence

- [Text roles](../packages/ui/src/tokens/scales.stylex.ts),
  [settings controller](../packages/components/src/components/interface-font-controller.tsx).
- [Cross-surface browser regression](../packages/components/tests/e2e/interface-typography.spec.ts),
  [terminal behavior](../packages/components/tests/local-terminal-panel.test.tsx).
- [Decision and verification limits](../.agents/notes/implemented/simplification/2026-10-03-interface-typography.md).
