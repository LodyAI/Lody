# Scroll areas join the Base UI component family

Status: implemented
Translation: current

[中文版](2026-10-21-ui-scroll-area.zh.md)

## Abstract

Lody's settings, sidebar and viewer panels still used a Radix scroll-area wrapper,
while native lists either opted into older CSS classes or kept browser defaults.
Scroll areas now belong to `@lody/ui`: Base UI owns measurement and input, and
StyleX tokens own the neutral thumb, transparent track and interaction states.
All product callers migrate to this implementation; native controls use the same
appearance while retaining their existing scroll and keyboard owners. The old
wrapper, dependency and vendor-specific patches are removed.

## Decision and scope

This completes the scroll-area work deferred by the
[number/password field migration](2026-09-20-ui-number-password-fields.md).
The new component exposes `axis`, `visibility`, `compact` and a native
`viewportRef`. Callers preserve layout and overflow bounds; the package owns
track dimensions and gray-ramp rest/hover/pressed colors. The sidebar continues
to reveal its bar during scrolling; narrow horizontal tab strips use `compact`.

Native Menu/ContextMenu, Popover, Select/Combobox, Textarea, Table and Drawer scroll
regions share a StyleX scrollbar style. Product containers use a low-priority CSS
baseline whose values come from the same token group through a palette-scoped
bridge. This covers existing native scrollers without replacing their nodes.
It also preserves the conversation engine's stable gutter, explicitly hidden
bars and terminal tab-strip geometry. No second scroll controller is introduced.

Every scrollbar is hidden at rest, the overlay convention of macOS and
OverlayScrollbars. `ScrollArea` defaults to `scroll` visibility. A Chromium
custom scrollbar cannot auto-hide or fade, so `installScrollbarPresence` (mounted
at the app root next to focus modality) publishes `data-scrollbar-scrolling`
after a scroll that follows wheel, touch, scroll-key or scrollbar-press input, and
`data-scrollbar-hover` while the pointer is in the element's own gutter.
`nativeScrollbar` and the CSS baseline paint the thumb only under those
attributes. App scrolls, such as a conversation following a streamed reply, stay
hidden. Both owners use a 12px hit area: the thumb is 4px at rest and 8px while
the track is hovered or dragged. Native scrollbars can only change the thumb's
transparent border, while overlay tracks change padding. Rejected alternatives:
revealing on container hover, because a pointer anywhere in a pane paints its
bar (the reason the sidebar already used `scroll`); a CSS-only thumb `:hover`,
which cannot see the rest of the track; Chromium's removed `overflow: overlay`;
and replacing the conversation scroller with `ScrollArea`, because the engine
owns its viewport and first child. The wider native gutter costs 4px of content
width.

Base UI's content part replaces Radix's implicit `display: table` wrapper.
Vertical content has `min-width: 0`; horizontal content may grow past its viewport.
File-tree virtualization and scroll restoration retain their actual viewport refs.
The diff panel now takes that ref directly; consumers and existing checks use the
stable `data-scroll-area-viewport` marker instead of a vendor attribute.

The home Now panel also uses the new owner. Its parent-frame animation hides both
tracks through `scrollbarClassName`, an interaction constraint rather than a second
appearance API. Viewport ownership, focus and motion completion remain with the panel.

The [Radix polling patch](../bug-fix/2026-09-15-scroll-area-frame-cleanup.md) is
retired because its production dependency is gone. Historical patch/wrapper links
point to their original source snapshot. Existing lifecycle checks now target the
public component's event-driven sampling, stable viewport identity and detached
viewport cleanup. No Base UI version or package boundary changes.

The shared jsdom setup supplies an empty `Element.getAnimations()` result when
the API is absent: jsdom does not run Web Animations, while Base UI checks subtree
animations before measuring. Keeping this boundary in shared setup covers every
real ScrollArea consumer. Base UI's no-animation flag preserves the pre-existing
synchronous dialog/popover teardown in jsdom; the exit-animation fixture explicitly
enables its controlled animation. Production behavior is unchanged, and test errors
remain visible.

## Evidence and limits

The gallery presents the actual component in both forced palettes, its dimensions,
all thumb colors, vertical and two-axis scrolling. The product Storybook scene
also includes native overflow, a long menu, Textarea and a hidden scrollbar.
Chromium checks cover wheel scrolling, thumb dragging and keyboard focus; the
600-file tree retains a bounded row window, compact horizontal tabs scroll, and
the notices dialog remains scrollable in a short window. Repository typechecks,
formatting, type-aware lint, i18n, boundary guards and documentation checks pass.
`NODE_ENV=test pnpm check` passes for the component and primitive suites. Targeted
cases cover the missing-API boundary, dialog closure, controlled exit animation
and HomeDashboard. Conversation hydration/scrolling and home browser suites pass;
the real home focus panel hides tracks during frame motion and keeps its viewport
scrollable.
Presence states are pinned in `packages/ui/test/scrollbar-presence.test.ts`.
In Electron 44 (Chromium), attribute changes repaint a custom thumb. Thumb
`:hover` and `:active` win over the attribute rules. A scrollbar drag suppresses
`pointermove` but delivers `pointerup`, so the hover state is re-evaluated on
release. Packaged Electron, touch input and non-Chromium engines remain
unverified.
