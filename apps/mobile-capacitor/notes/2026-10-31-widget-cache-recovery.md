# Recovering empty Home Screen widget snapshots

Status: implemented
Translation: current

[中文](2026-10-31-widget-cache-recovery.zh.md)

## Abstract

Metadata loading could clear Home Screen widget snapshots and block the independent
Token query. Rejected native writes also required another input to recover. The
publishers now separate runtime identity from metadata readiness and retry failed
native writes automatically.

## Decisions

- Conversation and quota reads require metadata from the exact ready runtime.
  During loading, `pendingScope` retains a decoded snapshot with matching user and
  workspace IDs, preserving its timestamp; invalid or differently owned data is
  cleared. Token queries use authenticated runtime identity and keep the existing
  auth-session/result checks.
- Missing runtime identity clears caches, including early cold startup. Confirmed
  logout remains latched for the page lifetime. Snapshot expiry stays at 15 minutes
  (Token usage measures freshness from the source window's end).
- Rejected writes retry after 1, 5 and 30 seconds, reading the current publication
  each time. Changed input or foreground refresh can rearm recovery. Rejection also
  invalidates deduplication because native storage may have changed before its
  acknowledgement failed. Writes remain serialized; disposal joins raw calls and
  bounded final-clear recovery.
- Native bridge failures emit fixed error codes. Hard clears reload the timeline
  even if the key is already absent, since an earlier rendered entry can remain.

## Validation

The mobile suite passes 82 JavaScript tests, including 31 widget behavior tests;
Foundation tests cover cache ownership, unchanged retained bytes and expiry.
Lost-acknowledgement clearing and recovery without new input fail against the
original synchronizer and pass against the fix. The affected check and repository
formatting pass. The iOS simulator App/extension build passes with the modified
native sources and existing generated WebView assets.

Full mobile TypeScript checking matches the unmodified baseline's dependency/API
diagnostics. A fresh WebView build is blocked by the borrowed dependency graph's
missing `@lody/platform/telemetry` export. Distribution-signed device presentation
and the original device symptom still need acceptance; WidgetKit controls repaint
scheduling. Permanent native failure or a never-settling call can prevent a clear
from completing.

Review: [PR #3971](https://github.com/loro-dev/lody/pull/3971).
Implementation: [Home Screen widget note](2026-10-12-home-screen-widget.md).
