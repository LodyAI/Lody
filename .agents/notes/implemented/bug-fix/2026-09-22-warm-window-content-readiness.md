# Warm-window adoption and content readiness

Status: implemented
Translation: current
PR: [#885](https://github.com/LodyAI/Lody/pull/885), [#914](https://github.com/LodyAI/Lody/pull/914)

[中文](2026-09-22-warm-window-content-readiness.zh.md)

## Abstract

Warm windows exposed Loading, transient Session Not Found, or a blank message
viewport. Adoption now preserves the real target and presents only after history,
layout and scroll restoration are ready; peer snapshots keep independent durable
state. Shell/runtime optimization reduced the measured 3,000-entry opening median
from 1,139 ms to 431 ms. macOS local mode now uses the same opt-in spare to prepare
a predicted Session before the click and directly claim its existing renderer.
Misses and clicks before preparation finishes still wait; this is not universal
instant opening.

## Decision and evidence

This corrects the [window prewarming decision](../feature/2026-09-18-desktop-window-prewarming.md).
The [desktop window Spec](../../../../specs/desktop-windows.md) owns the resulting intent.

`window-target.ts` clears spare identity and saves the real reload target before
sending navigation. It temporarily disables background throttling so a hidden
renderer can prepare and paint. Main accepts `app.windowContentReady` only from the
claimed WebContents and for its matching workspace/Session, then restores throttling
and shows/focuses the native window. Renderer readiness requires two frames with
the target marker; a conversation marker requires hydrated history, not merely an
index count. The stream separately signals its visible state after hydration and
initial scroll restoration; the native reveal requires both signals for populated
history. An empty conversation still waits for sync. The old opaque cover was
removed: it hid Loading by displaying a blank window and did not reduce work.
Main's independent five-second deadline exposes recovery UI if navigation/rendering
fails. This fallback is not a content-ready acknowledgement. Closing the window
cancels pending presentation; replacement prewarming begins after show to avoid
competing with target preparation.

`RuntimeProvider` initializes the implicit local workspace while the spare remains
on its neutral route. This moves Repo creation, local metadata sync, and peer
bootstrap ahead of the click without writing route context or mounting a Session.
The effective workspace keys remain stable on a matching claim, retaining both a
ready runtime and initialization still in flight. Missing local identity waits;
ordinary neutral windows and cloud runtimes retain route-driven initialization.
The spare also loads workspace layout code without mounting it. A resolved component
renders directly; passing an already fulfilled Promise through React.lazy still
caused an initial suspension. The component choice stays stable across rerenders
to preserve mounted layout state. Target history and painting follow selection.

`window-state.ts` owns product registration and close cleanup. Claimed windows can
become the main fallback and survive closing the original. Only the current spare
owns its shell-readiness timer, so closing an older claimed window cannot cancel
its replacement's timeout.

`doc-meta.ts` separates bootstrap readiness from per-Session projection settlement.
Queued events, the latest full read, and unresolved/failed reads block absence only
for their target. Deletion cancels obsolete waiting; runtime disposal fences late
results. Workspace-global waiting was rejected because unrelated failures could
leave a missing Session loading forever. Existing Sessions do not subscribe to
pending-state churn; workspace chrome retains bootstrap readiness.

`local-window-bootstrap.ts` exchanges CRDT metadata and already owned Session
snapshots over a workspace-scoped BroadcastChannel in local-only mode. Metadata
merges asynchronously through normal Repo/Flock projection. Each runtime holds a
uniquely named Web Lock for its lifetime; the inventory identifies live peers
without persistent membership or heartbeats and disappears on renderer exit.
Session startup checks disk first, avoiding unnecessary exports on every peer when
cache data exists. On a miss, it requests only inventoried peers. No peers means
immediate fallback; explicit negative replies finish the request once all listed
peers report absence. The 150 ms deadline remains for a peer that disappears or
stops responding after inventory. Missing Web Locks support disables Session peer
requests. Payloads are capped at 16 MiB; disposal closes channels and resolves waits.

Cold Session snapshots merge with any persisted edits inside the storage load,
before Repo subscribes. The candidate must be saved durably before adoption:
Repo assumes storage-loaded versions are already persisted, so returning a
non-durable seed could let a cursor outrun its document. A failed import/save keeps
the original document and falls back to the normal live merge. Already-owned
documents always merge in place, preserving identity, edits and subscribers.
History readers initialize afterward. Importing into an initialized reader was
rejected because it replayed bulk history through the projection. No second UI
store, Mirror, daemon connection, or shared persistence/cursor is introduced.
Cloud and dual-mode runtimes do not participate in peer sharing.

## macOS target preparation

The first stage of the [prepared-surface proposal](../../proposed/architecture/2026-09-23-prepared-session-surfaces.md)
is integrated into the existing developer warmup setting, still off by default.
Row hover/focus waits 150 ms; opening a Session menu requests immediately. Capture
listeners are necessary because row controls stop bubbling. A click cancels pending
intent so a fast open does not later start competing speculation.

Main owns one target-bound hidden window in place of the neutral spare, with a
30-second expiry and two-second cancellation grace for menu-to-click handoff.
Requests are source-bound; renewal fences stale cancellation, and readiness includes
a fresh preparation ID. Changing targets destroys the old view. Expiry, cancellation,
source close and renderer failure release unclaimed resources. A claimed view keeps
its lifetime and five-second recovery deadline; it adopts reload identity without
navigating. Neutral replacement starts after presentation or unclaimed disposal.

The renderer's explicit preparation state suppresses read receipts, workspace
ownership (notifications, badges and background owner work), navigation autofocus
and external-history refresh while allowing real hydration and layout. Main sends
activation only after showing the window. Content removal and viewport resize
revoke readiness. Live synchronization continues; source state and independent
durable replicas retain their existing contracts. The native animation addon stays
probe-only because its independent benefit was not established.

## Verification and limits

The macOS product path passes 39 relevant component tests and 168 Electron tests;
components/Electron typechecks and the OSS app build pass. The real Session-row
Command-click probe measured ready-hit show/input-confirmation medians of
32.50/82.46 ms (ten samples), zero-lead 451.13/492.84 ms (five), and 200 ms lead
346.94/421.82 ms (five). All 29 final checks including warmups preserved unread
state while hidden and showed visible content accepting unique text. Preparation
still costs 404.42 ms median before a ready-hit click. An earlier attempt timed out
after native show was requested; its exact screenshot/input stage was not recorded,
and its cause remains unestablished. Stage diagnostics and a full rerun passed.
The [benchmark README](../../../../packages/components/benchmarks/window-bootstrap/README.md#macos-production-preparation)
owns reproducible commands, raw measurements and timing limits. Physical input,
IME, Spaces/multi-display behavior and memory budgets remain unverified.


The provider, renderer readiness, stream rendering and sticky-scroll suites pass
48 deterministic tests. They cover pre-route initialization, ready/in-flight claim
reuse, scope disposal, mismatched stream identity, and hydrated but hidden content.
The earlier 39 component and nine shared IPC cases cover adoption, metadata races
and snapshot exchange. Components and Electron typechecks pass. The current bootstrap, layout, runtime,
metadata recovery, reveal and lifecycle run passes 47 tests. Added cases exercise durable
cold adoption, blocked/failed saves, persisted and live edits, corrupt snapshots,
and layout preload without mounting or losing state.

The [benchmark](../../../../packages/components/benchmarks/window-bootstrap/README.md)
separates data-path, synthetic-DOM and real desktop measurements. The real desktop
probe uses a fresh profile, the current React renderer, an existing bundled CLI
0.93.3 and a synthetic 3,000-entry conversation. It records native show, captures
the surface, and checks actual stream visibility. Every preinitialized spare had
its Repo and Session metadata before claim, with no runtime recreation at claim.

The sequential comparison measured 820.30 ms median before runtime preinitialization
(five samples), 1,057.22 ms afterward (ten), and 1,139.32 ms with the visible-stream
fix in the reproducible runner (five). These timings start at target IPC dispatch,
not physical input. Preinitialization alone did not improve opening. Cold adoption
then reduced the median to 700.14 ms; layout preloading reduced it to 430.77 ms
(424.24–463.15 ms, five samples), 62% below the visible-stream baseline. The same
path with 100 entries measured 256.56 ms (248.05–261.43 ms, five samples). CPU
profiles identified bulk Repo import and the initial layout suspension as costs.
A prior corrected run
included a 2,708.94 ms outlier; samples are too small for stable tail estimates.
The initial baseline probe crashed; the replacement run completed.

The preinitialization-only capture had chrome but no visible message body despite
hydrated history. The corrected first-show captures contain the synthetic answer;
all eight captures per corrected run passed, including three discarded warmups.
This validates the previously omitted React/scroll boundary; the earlier 152.39 ms
synthetic-DOM measurement did not exercise it. All optimized runs also passed the
first-show checks. Opening is faster but still perceptible; this is not a zero-delay guarantee.
The CLI artifact was reused rather than rebuilt from this checkout. Root `pnpm check`
still stops at missing `packages/ignore` dependencies; `docs check` reports existing
links into absent ACP submodules. The PR remains draft.
