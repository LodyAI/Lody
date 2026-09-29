# Composer mention menu placement

Status: draft
Translation: current

[中文](composer-mention-menu-placement.zh.md)

When a user opens an `@`, `$`, `/`, or `、` menu in a desktop composer and moves
the caret or types more of the query, the menu follows the current insertion
point. It prefers to open below that point and flips above when the visible
space cannot fit it. Changing menu levels must not switch the anchor back to the
composer box. Soft wrapping, textarea scrolling, layout movement, and scaled
editor containers must not leave the menu at an earlier caret position. The
menu remains constrained to the input's usable width. When neither side has
room for its full height, its rows remain reachable by scrolling within the
visible viewport.

The inline edit-and-resend menu uses the same caret placement. On small mobile
viewports, the main composer retains its keyboard-adjacent docked mention panel;
the inline editor retains its floating menu. The docked panel sits above the
whole composer frame, including attachments and controls above the textarea,
and never extends behind the top viewport inset.

## Evidence

- [Menu caller](../packages/components/src/components/mentions/mention-two-level-menu.tsx)
- [Caret anchor](../packages/components/src/ui/mention/mention-input.tsx)
- [Behavioral test](../packages/components/tests/mention-ref-stability.test.tsx)
- [Mobile placement test](../packages/components/tests/mention-two-level-menu.test.tsx)
