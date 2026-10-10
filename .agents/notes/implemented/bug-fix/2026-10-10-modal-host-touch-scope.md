# Keep every modal family member inside legacy drawer interaction scope

Status: implemented
Date: 2026-10-10
Translation: current

[中文](2026-10-10-modal-host-touch-scope.zh.md)

## Abstract

Dialogs opened inside mobile Vaul drawers still mounted on the body, inheriting its pointer lock and leaving the drawer's focus and scroll scope. Earlier fixes covered menus and the mobile diff only. A separate modal-container context now carries the legacy drawer's existing no-drag host to Dialog, AlertDialog and Drawer. Ordinary floating popup containers do not change modal positioning; device-specific scrolling still needs physical-device validation.

## Decision and evidence

The [mobile diff fix](2026-10-03-mobile-diff-portal-scope.md) correctly avoided making every modal inherit its nearest floating popup container: a centered panel's transform changes fixed positioning. This change generalizes the interaction-scope repair through a distinct `ModalContainerProvider`. Only the legacy drawer publishes that host; Base UI panels continue publishing their own floating popup container without replacing the modal host. Explicit `container` values retain priority, including Base UI's null/unmounted behavior. Standalone modals retain their body default.

Changing pointer events alone would leave the outer focus trap and scroll lock treating the visible dialog as outside. Reusing the existing boxless host also keeps nested modal gestures outside Vaul's drag handling and avoids adding layout children. File-preview callers using the common Dialog adapter receive this fix without changing file routing or loading.

## Verification

Six regression cases fail on the original implementation and pass with the fix: Dialog, AlertDialog and Drawer, each initially open or opened later. The existing drawer suite checks containment, effective pointer events, focus retention and closing only the inner modal. The UI suite additionally checks independent floating hosts and explicit container overrides. These component checks do not simulate native touch hit testing.

A synthetic 390×844 mobile browser fixture using the real drawer wrapper and UI primitives passes Chromium touch swipes (only preview content scrolls), taps, input and reopen checks for all three families. WebKit passes taps, input, hit testing and reopen checks; native WebKit swipes and physical iOS/Android devices remain unverified. The fixture supplies minimal layout and excludes application services; it is not a full file-preview journey.

The UI suite passes 300 tests and the drawer suite passes 22. UI typechecking, changed-file lint, and root formatting pass. Root check and components typechecking are blocked by the reused installation's dependency/API mismatch (including Effect and ACP exports). Docs check reports 82 existing errors from missing submodule links, none for changed files. No protected documentation topics are registered.
