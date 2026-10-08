# Synchronize mention positioning with content changes

Status: implemented
Translation: current
PR: [#1317](https://github.com/LodyAI/Lody/pull/1317)

[中文版](2026-10-08-mention-layout-position-sync.zh.md)

## Abstract

Entering the dedicated `@role:` menu could briefly paint a taller popup at the
previous top coordinate, overlapping the composer before moving upward. Resize
observation updated positioning a frame after the content changed. Desktop
mention content now requests positioning in a layout effect when its children
change. Chromium frame sampling and a behavioral regression test verify that
content height and position update together; packaged Electron remains unverified.

## Decision and evidence

`MentionContent` owns floating positioning and requests an update after the
content commit, before paint. The existing resize observer remains responsible
for later changes such as font or anchor layout. The mobile dock bypasses this
desktop update. This preserves the
[composer placement decision](2026-09-29-main-composer-mention-above-frame.md)
and its [Spec](../../../../specs/composer-mention-menu-placement.md).

In the real `MainComposerAboveFrame` story at 700 × 500, completing `@role:`
changes the popup from 36px to 176px tall. The old implementation briefly
retains top = 321.109px before correcting to 181.109px. Its bottom crosses the
composer instead of retaining the 8px gap. With the layout update, the first
frame containing the taller content already has the corrected top. Filtering
and hovering the two synthetic roles also retain the expected placement.

Playwright records the same three entries into `@role:`, filtering, hover, and
selection before and after the fix. Animation-frame sampling detects three
140px transient offsets in the old implementation and none in the fixed one;
both recordings successfully insert `@Code-Reviewer`. The side-by-side video
plays at half speed and retains the maximum sampled offset in its caption so
a one-frame defect is assessable. Generated recordings remain uncommitted.

The owning composer-placement test injects explicit popup dimensions and
renders 2, 6, then 1 rows without dispatching a resize event. It asserts the
resulting top coordinates and retained popup node. The old implementation
fails at the taller list, retaining 536px instead of 424px; the fixed version
updates both growth and shrinkage.

Waiting only for resize observation produced the visible intermediate frame.
Recreating the popup would replay entrance behavior and discard its identity.
The layout update retains the mounted popup, independently of the
[list scroll continuity fix](2026-10-08-mention-detail-scroll-continuity.md).
Repeated hover between the two dedicated Role candidates did not reproduce
continuous flicker; the evidence supports the content-height transition defect.

The additional height-flicker report remains unresolved. The production main
composer uses a top caret anchor; `MainComposerAboveFrame` exercises the
explicit frame-anchor alternative. A new caret story has 23 synthetic Roles,
including disabled entries and alternating empty/long instructions. At 960px
and 650px widths, Playwright samples eight animation frames after each hover,
scroll, and keyboard action: the full list remains 356px tall. Filtering to
one available Role reduces it to 176px with a detail pane or 64px without one.
No repeated height oscillation was observed in these scenarios or the tested
detail-visibility threshold. No additional height-locking fix is justified by
this evidence. The two browser tests retain coverage for these interactions,
disabled selection, and successful insertion. This investigation also corrects
stale frame-anchor descriptions in the pipeline doc and mention scope rules.

## Verification limits

All 135 tests in six focused mention suites pass, as do source lint and format
checks. They cover positioning, list identity, Role selection,
navigation, registration, and trigger activation. Browser acceptance uses
synthetic Storybook catalogs, rather than user or agent conversations.
The two added Role height tests pass in Chromium. Full `pnpm check` stops at
the reused installation's missing `@agentclientprotocol/sdk` dependency.
Component type checking remains blocked by missing or mismatched dependencies
in the reused local installation. Documentation checks still report existing
links into uninitialized ACP submodules. No packaged Electron or physical
mobile acceptance was performed. The
[mention pipeline explanation](../../../docs/ui-mentions.md) owns current
implementation context.
