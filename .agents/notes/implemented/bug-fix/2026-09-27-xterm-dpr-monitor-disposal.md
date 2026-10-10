# Dispose xterm's device-pixel-ratio monitor with its browser service

Status: implemented
Translation: current

[中文](2026-09-27-xterm-dpr-monitor-disposal.zh.md)

## Abstract

Repeatedly opening and closing a work terminal leaves an xterm.js device-pixel-ratio monitor attached to the window. Its resize and media-query listeners survive terminal disposal, so the desktop Scout's listener count rises across work journeys. A version-scoped patch for `@xterm/xterm@5.5.0` registers the monitor with its owning `CoreBrowserService`, following the [upstream xterm fix](https://github.com/xtermjs/xterm.js/commit/b0667aacca4cc1d0c14d57bb6f51333bd03fecea). The patch changes both the shipped bundle and its included source; a future dependency upgrade should drop it once that version contains the fix.

## Evidence and decision

[Issue #441](https://github.com/LodyAI/Lody/issues/441) is an automated, non-blocking candidate, so a rising heap alone was not treated as a confirmed leak. Independent scheduled [Scout runs 35501078002](https://github.com/LodyAI/Lody/actions/runs/35501078002), [35583886345](https://github.com/LodyAI/Lody/actions/runs/35583886345), and [35707757731](https://github.com/LodyAI/Lody/actions/runs/35707757731) showed two extra work-renderer listeners per terminal lifecycle. The work heap from that investigation contained 33 undisposed monitor objects after three warmup and 30 measured iterations, each retaining a resize and a media-query listener. The [later run 36231521406](https://github.com/LodyAI/Lody/actions/runs/36231521406) still reported a positive work-listener trend; its aggregate +67 includes other activity and is not itself a per-terminal attribution.

In xterm 5.5.0, `CoreBrowserService` constructs `ScreenDprMonitor` without registering it as a child disposable. The monitor registers its own listeners, but disposing the service never calls the monitor's `dispose`. Registering that one child preserves the terminal's behavior while closing the ownership gap. A Lody-level workaround would have to reach through xterm internals and would not own those listeners reliably. The version-scoped pnpm patch is limited to the shipped package and carries the upstream source credit.

## Verification and limit

The patch applies cleanly to the installed `@xterm/xterm@5.5.0` package. Repository checks and a post-patch Scout result must be recorded separately; the original issue's heap trend is not proof that all renderer growth is removed. This note does not promote Scout's candidate signal into a blocking gate.
