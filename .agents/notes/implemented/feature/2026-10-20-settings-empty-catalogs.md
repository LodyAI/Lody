# Illustrated empty settings catalogs

Status: implemented
Translation: current
PR: [#1745](https://github.com/LodyAI/Lody/pull/1745)

[中文](2026-10-20-settings-empty-catalogs.zh.md)

## Abstract

Empty settings catalogs looked like a record card containing only an absence
message. They now present a centered Lody jellyfish illustration above localized
copy on the page, preserving every existing message and instruction verbatim.
The shared component also covers existing project, GitHub, share, and provider
empty states, and the empty Project Skills inventory. Existing add actions remain
available, and the illustration is decorative. Data ownership, loading conditions,
permissions, error states, and populated lists retain their existing behavior.

## Decision

This replaces the empty-catalog presentation from the
[settings rhythm decision](2026-09-25-settings-rhythm-and-image-peek.md#design-review-round-2).
`SettingsEmptyList` now draws on the page rather than using `settingsRecordsCard`.
It shares StyleX geometry through the settings surface and accepts an optional
description. It has no internal scroller; copy wraps inside narrow panels. The
page keeps its existing add action, while the existing optional action slot still
supports GitHub installation without adding a second page action.

Existing English and Chinese copy is preserved verbatim, including punctuation
and instructions. No new guidance is added. The optional description carries the
existing Project Skills hint. The same presentation serves
both saved memory associations and an empty external memory inventory. Project
Skills uses it only for an empty inventory, keeping error/retry and search-result
messages separate. No catalog writes, provider requests, selection rules or
capability gates changed.

## Illustration

The new [transparent PNG](../../../../packages/components/src/assets/settings-empty-jellyfish.png)
was generated with the built-in `image_gen` tool using the existing `lody-icon.png`
as the brand reference. A blue/teal jellyfish searches an empty folder with a
magnifying glass; there is no embedded text or theme-colored backdrop. The
[generation prompt](../../../../packages/components/src/assets/settings-empty-jellyfish.prompt.txt)
is retained with the asset. The image is local to the public package and rendered
with empty alt text and `aria-hidden`; the adjacent copy carries the meaning.

## Verification

The components type check, typed lint, translation-key validation and 17 existing
memory, MCP and Prompt Shortcut form tests pass. Two desktop browser cases cover
six empty catalogs in English/light/1180px and Chinese/dark/500px, including image
loading, centering, wrapping, no card or internal scroller, add dialogs, and
loading/read-only conditions. Two mobile cases cover Roles and MCP in both
palettes at 393×852 with touch input. All four browser cases pass; the local run
uses Chromium build 1223 and allows 30 seconds for Storybook rendering.

`pnpm format` passes. The latest `pnpm check` completed type checks and lint but
failed on a five-second timeout in the unchanged iOS simulator panel suite
(5,742 component tests passed). That entire 25-test suite passes independently;
all 4,423 CLI tests passed, with four skipped. Translation and boundary checks
were also run separately and pass. The complete root check is therefore not
green. Documentation checking retains the six existing missing Kimi/Pi submodule
links, with no new errors or protected-topic changes.

## Screenshots

Before and after screenshots are attached to [PR #1745](https://github.com/LodyAI/Lody/pull/1745)
instead of being tracked in the repository. They use the actual catalog components
with synthetic fixtures. Desktop uses an 1180×800 viewport and shows the content
pane; mobile uses the production `MobileSettingsLayout` in a 393×852 touch viewport.
Both palettes are included, with matching fixtures and viewports for each pair.
