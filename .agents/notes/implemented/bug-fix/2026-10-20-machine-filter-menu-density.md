# Compact machine filter menu

Status: implemented
Translation: current

PR: [#1743](https://github.com/LodyAI/Lody/pull/1743)

[中文](2026-10-20-machine-filter-menu-density.zh.md)

## Abstract

The machine filter popup reserved a leading tick column even when both filters
were off, leaving the short labels indented inside an oversized menu. It now
uses the existing compact width and puts selection ticks after the labels.
Removing the redundant heading and separator leaves just the two filter rows.
Online and My machines remain independent checkboxes, with keyboard navigation
and an open menu while changing either option.

## Decision

The [menu family](../feature/2026-09-11-ui-menu-primitives.md) keeps the mark box
reserved so labels cannot shift when a tick appears. `Menu.CheckboxItem` gains
an optional `indicatorSide="end"`, matching the radio row's existing placement
option. It moves that box after the label; the default remains at the start.
The product uses this option with `width="compact"` (180px minimum), without
changing shared menu dimensions or row styles. Longer labels can still expand
beyond the minimum. The trigger retains its translated accessible name.

The UI gallery's compact example demonstrates trailing ticks. The owning menu
suite exercises both placements with pointer and keyboard activation, and the
settings browser suite checks the real machine filter and resulting list.

## Verification

The menu and gallery suites pass all 52 tests. English and Chinese browser cases
pass: the menu is 180px wide and 64px tall, labels begin within 14px of its edge,
and checking does not shift them. The real list changes from four machines to
two online machines, then one online owned machine; keyboard toggling and
reopening preserve the selected filters. Both package type checks and targeted
typed lint pass. Before submission, `pnpm format` and the full `pnpm check`
also passed, including workspace type checks, lint, tests, and boundary checks.
Documentation checking retains the existing six missing Kimi/Pi submodule links
in the bilingual subagent-events note; no new documentation errors were added.

## Screenshots

![No filters selected](../../assets/machine-filter-menu-density/unchecked.png)

![Online selected](../../assets/machine-filter-menu-density/checked.png)
