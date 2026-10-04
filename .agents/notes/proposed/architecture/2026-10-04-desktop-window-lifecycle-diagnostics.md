# Desktop window close diagnostics and opening latency

Status: proposed
Translation: current

[中文](2026-10-04-desktop-window-lifecycle-diagnostics.zh.md)

## Abstract

An auxiliary window can display a generic unsaved-content warning without identifying
the state that blocked closing, while the optional warm window does not guarantee a
prepared conversation. Investigating these reports requires explicit close reasons
and timing the actual opening path before changing window ownership. The proposed
sequence is to diagnose the close veto, measure preparation coverage, then evaluate
a shared document owner with bounded view subscriptions for cache misses. This initial investigation did not reproduce the reported veto; an isolated probe
ruled out unconditional vetoes on clean pages. The subsequent
[shared-owner implementation](../../implemented/architecture/2026-10-04-shared-desktop-session-owner.md)
records the selected data ownership change and evaluation; the original close cause
remains unestablished.

## Established behavior

| Boundary                  | Evidence                                                                                                                                                            | Consequence                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native close confirmation | [renderer-unload.ts](../../../../apps/electron/src/main/renderer-unload.ts) handles every `will-prevent-unload` with the same text                                  | The attachment/editor wording does not identify the actual blocker.                                                                                                       |
| Held sends                | [SessionPendingSendsHost](../../../../packages/components/src/components/chat/session-pending-sends-host.tsx) registers a guard while the runtime has pending sends | Failed or queued sends in another conversation of that runtime also block closing. Already written sends leave this queue.                                                |
| Editor writes             | [useCodeCollabSaveText](../../../../packages/components/src/hooks/use-code-collab-save-text.ts) checks buffered text, saving, conflict and error state              | A guard may be correct even when the visible conversation is idle.                                                                                                        |
| Optional cloud client     | [convex-provider.tsx](../../../../packages/components/src/providers/convex-provider.tsx) constructs Convex with default options                                     | Convex 1.33.1 also installs a guard for incomplete mutations/actions; applicability requires a cloud composition and a pending request. The public local client is inert. |
| Experiment lifetime       | [window-warm-settings.ts](../../../../apps/electron/src/main/window-warm-settings.ts) stores an initially false module variable                                     | Warmup is off again after restarting the application.                                                                                                                     |
| Target preparation        | [window-warm-service.ts](../../../../apps/electron/src/main/window-warm-service.ts) gates preparation on macOS, local mode and the experiment                       | Enabling the experiment alone does not imply a prepared target, particularly outside local mode.                                                                          |
| Preparation opportunity   | [window-preparation-intent.ts](../../../../packages/components/src/lib/window-preparation-intent.ts) waits 150 ms on row intent; a menu prepares on mount           | Immediate modifier-clicks can miss preparation. One slot is replenished after presentation.                                                                               |

The uniform confirmation is established implementation behavior, not evidence of
an attachment still uploading. Do not disable every unload guard or silently
destroy a window to suppress the warning. Pending sends are intentionally
renderer-owned and volatile under the [send decision](../../implemented/simplification/2026-09-29-remove-session-send-journal.md).

## Opening performance and proposed order

The [existing production-path benchmark](../../../../packages/components/benchmarks/window-bootstrap/README.md#macos-production-preparation)
recorded 3,000 synthetic entries on an M4 Max: prepared hits showed in 32.50 ms
median and confirmed input in 82.46 ms; immediate clicks showed in 451.13 ms and
confirmed input in 492.84 ms. Preparation took 404.42 ms before the click, in
addition to the row debounce. These September measurements used an older runtime
and CLI; they are evidence of the mechanism, not measurements of the current report.

1. **Diagnose before changing protection.** Reproduce an untouched auxiliary window
   and record which guard actually vetoes. Add local, bounded reason diagnostics
   for held-send count and editor save state, without message text or file contents.
   If neither application guard explains the veto, inspect dependency listeners
   in the affected renderer. Retain Stay/Leave and unsaved-data protection.
2. **Measure the user path.** Record disabled, cold, shell hit, preparing-target hit,
   and ready-target hit separately. Time input, IPC receipt, runtime readiness,
   history readiness, initial scroll/layout, native show and usable composer.
   Include zero-lead clicks, menu opens, repeated opens, long histories and RSS;
   do not report only ready hits. A five-second fallback reveal indicates failed
   readiness, not a normal loading budget to shorten blindly.
3. **Improve preparation coverage within its resource budget.** Evaluate whether
   the developer preference should persist and whether preparation should start
   earlier for high-confidence intent. Persisting a hidden renderer preference
   changes product behavior and needs a Spec revision. Increasing the pool or
   removing the local-mode gate is not an established safe fix; measure memory
   and audit speculative effects first.
4. **Reduce miss cost through shared data ownership.** Continue the
   [prepared-surface proposal](2026-09-23-prepared-session-surfaces.md): one
   application-lifetime document/projection owner, with each window subscribing to
   a bounded initial history range and revisioned updates. Keep navigation, scroll,
   selection and drafts view-local. Route commands to the existing authoritative
   writer; design durable acknowledgement, reconnect generations and crash
   recovery before replacing per-renderer Repo/cursor ownership. Sharing a full
   JSON history still repeats projection/rendering work and is not sufficient.

Changing BrowserWindow to BaseWindow/WebContentsView alone does not remove
per-renderer document imports or layout. The existing window contract preserves
the source conversation, so moving its only live view is a different operation.
Application-lifetime ownership of pending attachment sends would also change their
current cancellation/durability contract; it must be a separate decision, not an
incidental consequence of sharing read projections.

## Verification and limits

Inspected the checkout and installed Nightly 0.103.0-nightly.8 code without
accessing conversation content or modifying the installed application. Its framework
version is Electron 43.7.6. An isolated Electron 43.7.6 probe used a temporary
profile and synthetic HTML: no listener, an inactive editor-style listener and a
removed pending-send listener all closed without veto; an active pending-send-style
listener produced a veto. The probe awaited native close events, with no sleeps.
This checks Electron semantics, not the full application or the reported state.

The initial read-only investigation had no installed checkout dependencies and did
not run application benchmarks, typechecks or product tests. The subsequent
[implementation and evaluation](../../implemented/architecture/2026-10-04-shared-desktop-session-owner.md)
uses a separate dependency-complete clone. Remaining proposals above are not shipped
guarantees. No PR or human approval is implied.
