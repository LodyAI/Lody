# Dispose the terminal DPR monitor with its owner

Status: implemented
Translation: current

English | [中文](2026-11-09-xterm-dpr-monitor-disposal.zh.md)

## Abstract

Closing an xterm 5.5.0 terminal leaves its device-pixel-ratio monitor alive, retaining window and media-query listeners. The November 8 Desktop Scout heap independently confirms 33 undisposed monitors after three warmup and 30 measured terminal lifecycles. A version-scoped pnpm patch registers the monitor with its browser service, following the upstream ownership fix. A real Chromium comparison changes listener growth across 30 terminal lifecycles from 60 to zero; other Scout heap and RSS growth remains unattributed.

## Evidence and decision

[Issue #441](https://github.com/LodyAI/Lody/issues/441) reports an informational trend, not proof of a leak. Its [November 8 Scout artifact](https://github.com/LodyAI/Lody/actions/runs/42473762994/artifacts/13615014122) contains 33 objects with `_resolutionMediaMatchList`, `_windowResizeListener`, `_outerListener`, and `_isDisposed: false` in the work renderer's post-cleanup heap. This independently corroborates the earlier investigation in the issue comment.

`CoreBrowserService` creates `ScreenDprMonitor` without registering it for disposal. The monitor owns a window resize listener and a DPR media-query listener. Registering this child releases both through the existing terminal disposal path. The patch changes the shipped bundle and included TypeScript source, following [xterm's upstream fix](https://github.com/xtermjs/xterm.js/commit/b0667aacca4cc1d0c14d57bb6f51333bd03fecea) and crediting [Dante-dan's original backport](https://github.com/Dante-dan/Lody/commit/db482104d0fe4e731f40242c97818e07cb752478). Reaching into private xterm fields from the application would give the wrong component ownership of cleanup. Remove the patch when upgrading to a version containing the upstream fix.

## Verification and limits

In fresh real Chromium pages, three warmup cycles followed by 30 measured `Terminal.open`/`dispose` cycles and explicit GC produced +60 JS event listeners with the original shipped bundle and +0 with the patched bundle. The committed browser regression checks that post-GC listener count returns to its warm baseline. This is a narrow deterministic lifecycle assertion, not a memory ceiling or a new Scout threshold.

The remaining renderer heap/RSS slope requires separate attribution; this result does not establish that every resource trend is resolved. A full built-desktop Scout after the patch remains the integration check.
