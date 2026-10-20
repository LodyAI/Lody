# Sidebar ink contrast in Lody Light

Status: implemented
Translation: current

[中文](2026-10-18-sidebar-ink-contrast.zh.md)

## Abstract

After the [neutral grays](2026-10-17-neutral-light-grays.md) change, a measured screenshot of the
light sidebar still read as one grey haze: navigation icons sat at 2.7:1 on the sidebar, the machine
name at 1.9:1, a disabled Forward arrow at 1.8:1, and the selected conversation's fill was only
1.18:1 from the sidebar. The sidebar now uses five inks instead of seven: selected text, row text,
one muted ink (`#6B6B6B`, 4.7:1, for icons, details and the Offline pill), a group-label step (that
ink at 80%, 3.2:1) and the muted ink at 60% for disabled controls. The selection fill is darker (`#D6D6D6`, 1.28:1) and the
project folder icon takes the navigation icons' stroke and resting ink. Nothing was rendered: the
values are computed contrast ratios, not a visual review.

## Findings

- `--sidebar-foreground-muted` resolved from `sideBarSectionHeader.foreground` (`#939393`), so every
  muted sidebar element sat at about 2.7:1. Group labels then faded it to 70% (about 1.9:1), and
  disabled header buttons to 40%.
- Navigation icons rested at the muted ink while the project folder icon used the row ink with
  lucide's default 2px stroke, so two icon columns a few pixels apart had different weights and inks.
- The Offline pill used the product's `muted-foreground` and a `foreground/12%` border, not the
  sidebar's own inks.
- The page card's shadow was blue-tinted (`hsl(225 10% 11%)`) after the greys became neutral, and
  faint against a 1.08:1 lightness step.
- The text columns of navigation, project and repo rows are the same in code (9px border-box inset,
  text 31px from the row edge). The 2–6px offsets in the measurement are glyph side bearings and
  icon artwork, so no geometry was changed on that evidence alone.

## Decision

| Ink         | Value (Lody Light)                                      | Use                                    |
| ----------- | ------------------------------------------------------- | -------------------------------------- |
| Selected    | `--sidebar-selection-foreground`                        | the selected row                       |
| Row         | `--sidebar-row-foreground` (capped 10:1)                | titles, navigation and project labels  |
| Muted       | `#6B6B6B`, 4.7:1 on the sidebar, 3.7:1 on the selection | icons, details, Offline                |
| Group label | muted at 80%, about `#868686`, 3.2:1                    | machine names, GitHub Worktrees, Chats |
| Disabled    | muted at 60%, about 2.3:1                               | Back / Forward with no history         |

Group labels first took the full muted ink. Reviewed by the person owning the work, that made a
machine name match the icons and details around it, only one step above the project rows, so it
stopped reading as a heading. They now sit one step lighter than the muted ink (still medium, 12px)
and the gap between navigation and the first group grows from 8px to 12px, so position, not colour
alone, marks the group; groups below are already 16px apart. The cost is a label under the 4.5:1
text guideline. The earlier 70% (1.9:1) was rejected because it read as disabled, and a darker,
heavier heading was rejected because it would weigh the sidebar down.

Fills: hover `#E2E2E2` (unchanged, 1.14:1), selection `#D6D6D6` (was `#DEDEDE`), so hover and
selection stay distinct (1.12:1). The unthemed Tailwind fallbacks follow (muted 42%, selection 84%).
The page card keeps its neutral shadow and uses one light 1px border at 60% of the theme border color, so the edge reads without a strong frame or nested outline.

The light canvas and sidebar surfaces were subsequently set to `#F9F9FA` and `#EFEFF0`. Their
calculated contrast is 1.09:1, a very small separation; the inset, shadow and low-contrast border
work together to define the page card. The existing `#6B6B6B` muted ink remains at 4.64:1 on the
sidebar.
The dark Vesper palette is unchanged. This is a source-level contrast calculation; the revised
surfaces still need a rendered visual review.

Not changed: the web-only `Lody` wordmark keeps its brand face, since a wordmark is a brand decision
rather than interface type; the header arrows keep lucide's artwork, whose arrows are drawn narrower
than the panel glyph inside the same 16px box; other spacing is unchanged pending a rendered review.

## Verification limits

The authoring environment has no Node or pnpm, so `pnpm check`, `pnpm format`, tests, Storybook and
`pnpm run docs check` were not run, and nothing was inspected on screen. Contrast ratios were
computed from the sRGB values above. Before merging, look at the `LoroSidebar` stories in light and
dark (the dark theme's muted ink is unchanged), with a selected conversation, an offline machine and
a disabled Forward button.
