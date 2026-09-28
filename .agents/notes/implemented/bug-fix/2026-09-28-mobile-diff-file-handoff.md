# Close the mobile diff sheet when opening its source file

Status: implemented
Date: 2026-09-28
Translation: current
[中文](2026-09-28-mobile-diff-file-handoff.zh.md)

## Abstract

Opening a source file from the mobile diff header left the diff sheet open above the file viewer, making the action appear unresponsive. The session shell now closes the mobile diff sheet before invoking the existing file-open path. This preserves canonical file paths and viewer-tab reuse while making the destination visible. Closing the file viewer returns to the conversation rather than restoring the dismissed diff sheet.

## Decision and evidence

`handleOpenFileFromDiff` previously called only `handleOpenFile`. The latter reaches `upsertViewerTab`, which opens `MobileFileViewerDrawer` on mobile but does not dismiss `mobileDiffState`. The diff sheet uses the UI drawer's modal layer (80), while the file drawer uses the legacy Vaul layer (50).

The diff action now calls `handleCloseMobileDiff` on mobile before starting file resolution, matching the existing mobile Files browser handoff. Raising a global drawer layer would affect unrelated overlays and leave two modal owners active. Desktop behavior continues through the same file-open callback.

Current implementation context: [session file surfaces](../../../docs/sessions-file-surfaces.md).

## Verification

The change is a local event-handler correction; no source-string or mock-call-only test was added. Review the callback wiring for both historical and All Changes mobile sheets. Device validation remains required: open either diff sheet, tap a file's open action, confirm the file viewer is visible and usable, and close it back to the conversation. Automated-check results are reported in the PR.

The existing diff-header and mobile file-drawer suites passed (5 tests). Components typechecking, scoped Oxlint, formatting, and whitespace checks passed. Full `pnpm check` stopped at CLI typechecking because the Claude, Codex, and Grok submodules are absent. Documentation checks still report unrelated broken links.
