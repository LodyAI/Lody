# Keep the mobile Files drawer open beneath an opened file

Status: implemented
Date: 2026-10-25
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1881
[中文](2026-10-25-mobile-files-drawer-back-to-folder.zh.md)

## Abstract

On mobile, opening a file from a session's Files drawer closed that drawer before opening the file viewer, so Back from the viewer landed on the conversation instead of the folder the user was browsing. The Files drawer now stays open and the file viewer stacks above it, so Back reveals the same folder, scroll position and breadcrumb. No layer values changed: both are Vaul drawers on the same `z-50` rung, and the viewer's portal is always appended later. Device validation of the gesture and stacking remains required.

## Decision and evidence

The session host passed the browser an `onOpenFile` that called `setMobileFilesBrowserOpen(false)` before `handleOpenIndexedFile`. Closing unmounted the Files drawer content, so `MobileProjectFileBrowser` lost its folder stack; reopening Files after the viewer closed would still have started at the root. The browser's own delegate contract already promised to stay on the folder level.

`MobileFileViewerDrawer` sets `forceMount` only on its content, but Radix's Dialog portal mounts children only while open, so each viewer open appends a new portal after the already-open Files drawer. Both use `fixed z-50`, so DOM order puts the viewer above. Radix dismisses only its top layer, so taps in the viewer do not close the Files drawer.

Rejected: keep the Files drawer content force-mounted and reopen it when the viewer closes. That needs a separate "opened from Files" flag so conversation-opened files do not reopen it, plays two slide animations for one Back, and the Files provider request is gated on the drawer being open.

This differs deliberately from the [diff-sheet handoff](2026-09-28-mobile-diff-file-handoff.md): that sheet sits on a higher modal layer (80) that would cover the viewer, and it cited the old Files behavior only as a matching pattern.

The drawer moved from `session-detail.tsx` into `MobileSessionFilesDrawer` so its real composition with the viewer drawer can be tested. Current context: [mobile navigation stack](../../../docs/ui-mobile.md#stacking).

## Verification

`tests/mobile-session-files-drawer.test.tsx` renders the real Files and viewer drawers: open a folder, open a file, then check that the viewer portal follows the still-open Files drawer and Back returns to the folder before drilling out and closing. It fails when opening a file closes the Files drawer first. Device validation remains required for the edge-swipe order (viewer → folder → parent → conversation) and for reopening a file already open as a viewer tab.
