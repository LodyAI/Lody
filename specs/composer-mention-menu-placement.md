# Composer mention menu placement

Status: draft
Translation: current

[中文](composer-mention-menu-placement.zh.md)

When a user opens an `@`, `$`, `/`, or `、` menu in the main desktop chat
composer, the menu follows the current caret and opens above it. Typing,
wrapping, scrolling, resizing, and scaling must update that position. Filtering
or changing the menu's height must not move it below the caret while the space
above can show a heading and one option. The menu remains within the input's
usable width even when command descriptions are long; if its full height does
not fit above, its rows remain reachable by scrolling. Only when the caret is
too close to the top edge to show a useful row may the menu open below it.

The inline edit-and-resend menu and dialog composer also follow the current
caret. They prefer the space below it and flip above when needed. Soft wrapping,
textarea scrolling, layout movement, and scaled editor containers must not
leave those menus at an earlier caret position. Their width is constrained to
the input, and their rows remain scrollable within the visible viewport when
neither side fits the full menu.

On small mobile viewports, the main composer retains its keyboard-adjacent
docked mention panel; the inline editor retains its floating menu. The docked
panel sits above the whole composer frame, including attachments and controls
above the textarea, and never extends behind the top viewport inset.

## Evidence

- [Main composer](../packages/components/src/components/chat/chat-composer.tsx)
- [Menu caller](../packages/components/src/components/mentions/mention-two-level-menu.tsx)
- [Caret anchor](../packages/components/src/ui/mention/mention-input.tsx)
- [Composer placement test](../packages/components/tests/e2e/composer-mention-placement.spec.ts)
- [Caret anchor test](../packages/components/tests/mention-ref-stability.test.tsx)
- [Mobile placement test](../packages/components/tests/mention-two-level-menu.test.tsx)
