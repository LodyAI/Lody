# Make the shared image viewer a keyboard modal

Status: implemented
Translation: current
PR: [#1177](https://github.com/LodyAI/Lody/pull/1177)

[中文](2026-09-30-image-viewer-modal-focus.zh.md)

## Abstract

The shared image lightbox allowed Tab to enter background attachments and exposed
its close/previous/next controls as SVGs or divs. Keep PhotoSlider's existing zoom,
pan, backdrop dismissal and gallery engine, but place its portal inside a modal
focus boundary with named UI buttons. Focus now starts at Close, cycles within
the viewer, and returns to the connected opener on close; background content is
inert while open. Desktop and mobile-shaped Chromium regressions pass; production
and native touch/assistive-technology acceptance remain separate.

## Decision and evidence

`react-photo-view` has window-level Arrow/Escape handlers but no modal focus
isolation, and its default controls are not native buttons. Changing only their
roles would leave the background focus escape intact. Replacing the image engine
would risk the gesture behavior established by the
[gesture note](2026-09-27-mermaid-and-image-viewer-gestures.md).

The existing Floating UI dependency supplies modal focus guards, restoration and
outside-element inert handling. PhotoSlider portals into that boundary, retaining
the Vaul-aware outer container and no-drag markers. Lody disables the library's
default banner and supplies transparent `@lody/ui` ghost buttons with translated
accessible names. Controls use the dark palette for contrast against the existing
mask, without adding resting button fills or changing the mask's color/opacity.
Arrow/Escape events are handled once inside the modal, not also by the library's
window listener. Existing end limits and looping for galleries larger than three
images are retained. The dialog remains usable before the full-size source loads.

## Verification and limits

The new behavioral unit regression fails on the original component and passes
after the modal change. The existing image-preview suite passes 11 tests,
including loading sources, copy/save bytes and a photo tap that must not dismiss. Chromium E2E
passes at 1280px and 390px: initial focus, native Tab/Shift+Tab loops, inert
background, Right navigation, previous click, Enter on Next, Escape, button close,
and restored opener. Manual isolated-browser acceptance confirms one named
dialog, the same focus cycle and restoration; a synthetic gallery screenshot was
visually inspected. Components typecheck passes.

No signed-in production test or deployment was performed. Native Vaul touch
gestures, Electron native controls, and screen-reader announcements were not
manually revalidated. A removed or disabled opener cannot be focused; callers
remain responsible for a connected, focusable opener.
