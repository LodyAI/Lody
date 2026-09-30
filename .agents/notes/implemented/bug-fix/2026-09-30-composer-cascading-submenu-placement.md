# Composer cascading submenu placement

Status: implemented
Translation: current

[中文](2026-09-30-composer-cascading-submenu-placement.zh.md)

PR: [#1169](https://github.com/LodyAI/Lody/pull/1169)

## Abstract

Centering composer submenus against the whole parent menu separated them from
their triggering rows. All desktop run-config submenus now anchor to their own
rows and align at the top when space permits, including Roles. Viewport collisions
may shift or flip a submenu; equal rules do not imply equal screen coordinates.
The model list's height cap now constrains its actual content rather than its
positioner. Isolated Playwright checks verify geometry and interaction, but do
not establish packaged Electron acceptance.

## Decision and evidence

The shared trigger anchor remains in effect. The later search-header alignment
refinement and rejected size/position experiments are recorded in
[model search anchoring](2026-09-30-model-search-trigger-anchor.md); that record
owns the current searchable Model offset and its verification.

This replaces only the positioning decision in the
[previous Role note](2026-09-29-composer-role-submenu-placement.md). Content-driven
Role panes, their 14rem cap, independent scrolling, and standard insets remain.
The rejected alternative was to extend whole-parent centering and bottom-clamping
to every submenu; that made placement uniform relative to the parent surface,
not to the option that opened it.

[Fluent's submenu specification](https://github.com/microsoft/fluentui-react-native/blob/main/packages/components/Menu/SPEC.md#submenu-positioning)
explicitly anchors to the menu item and aligns at its top edge.
[Material Web's submenu defaults](https://github.com/material-components/material-web/blob/main/docs/components/menu.md)
connect `START_END` on the anchor to `START_START` on the menu. In horizontal LTR
layout this means the trigger's top-right meets the submenu's top-left.

`DesktopRunConfigMenu` shares `align: start` and side-flip/vertical-shift collision
handling across Role, Agent, Model, Interaction, Reasoning, and provider-defined
select menus. The menu primitive retains its trigger anchor and inline-end side,
including RTL handling. No height-dependent parent offset remains. Filtering a
long model list restores row alignment when the result fits. Tall submenus may
extend below the parent or over adjacent page content; the viewport, not the
composer footer, bounds collision handling. Intent is in the
[draft placement Spec](../../../../specs/composer-run-config-submenu-placement.md).

The model height cap previously applied to `Menu.Content`'s positioner while its
popup could grow past it. A StyleX wrapper inside the popup now caps content at
20rem and the available height. Search stays visible while only options scroll.
The existing browser suite checks viewport bounds, filtered row alignment, and
the four submenu families present in its production story.

## Verification and limits

Playwright Chromium rendered the real menu, UI primitives, Role panel, and model
search with synthetic catalogs and isolated service/data hooks. Its composer
frame is synthetic, not the production `ChatComposer`. Correction: the initial
frame left 80px below the composer and the screenshots excluded the viewport
bottom, so those screenshots did not establish bottom-docked acceptance. The
revised frame mirrors the desktop shell's 8px bottom inset from
[`getSessionChatInputAreaShellClassName`](../../../../packages/components/src/components/sessions/session-chat-input-area.tsx);
the screenshot includes the viewport bottom and Playwright asserts that inset.

The comparison uses the rejected centered implementation and the corrected
implementation at the same 1040×720 viewport, with the same content and height
cap. Agent and Model tops match their rows at y=512 and 540. Reasoning's row is
at y=568, but its 176px popup shifts up 32px to y=536–712 to avoid the viewport
edge. The long model popup shifts to y=384–712 with a 328px height; filtering to
one match returns it to its row at y=540–608. All six submenu families pass the
same row-anchor/viewport-shift rule with the composer docked 8px above the bottom.

Executed checks cover all six submenu families, consecutive pointer switching,
menus without a Role row, horizontal flipping near the right edge, a 480px-high
viewport, actual option overflow, search focus, and model selection. Screenshot
artifacts and the fixture stay ignored; no captured transcripts enter source.
The existing run-config face suite passes all 11 tests. Source formatting and
lint pass. Component typecheck remains blocked by missing Electron dependencies
and stale shared/ACP exports in borrowed dependencies. Full Storybook and
packaged Electron validation are not established by this isolated fixture.

Very narrow windows where neither side fits still need a separate navigation
design; this change does not introduce drill-in navigation. Current implementation
documentation is [composer run config](../../../docs/sessions-run-config.md).
