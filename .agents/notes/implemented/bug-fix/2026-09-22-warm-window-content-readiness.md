# Warm-window adoption and content readiness

Status: implemented
Translation: current
PR: [#885](https://github.com/LodyAI/Lody/pull/885), [#914](https://github.com/LodyAI/Lody/pull/914)

[中文](2026-09-22-warm-window-content-readiness.zh.md)

## Abstract

Claimed warm windows exposed Loading or transient Session Not Found, retained spare
identity, and recovered to the neutral route after a crash. Adoption now preserves
the real identity and reload target. The native window remains hidden until its
matching content is painted, without a blank renderer cover; preparation still
contributes to click-to-show time. Local windows reuse metadata and loaded Session
snapshots with independent persistence/cursors. Benchmarking exposed an unconditional
151 ms miss penalty, now removed by checking live peers and accepting negative replies.
The local spare now starts workspace initialization before a claim and retains it
across matching navigation. Full application click-to-show latency remains unverified.

## Decision and evidence

This corrects the [window prewarming decision](../feature/2026-09-18-desktop-window-prewarming.md).
The [desktop window Spec](../../../../specs/desktop-windows.md) owns the resulting intent.

`window-target.ts` clears spare identity and saves the real reload target before
sending navigation. It temporarily disables background throttling so a hidden
renderer can prepare and paint. Main accepts `app.windowContentReady` only from the
claimed WebContents and for its matching workspace/Session, then restores throttling
and shows/focuses the native window. Renderer readiness requires two frames with
the target marker; a conversation marker requires hydrated history, not merely an
index count. An empty conversation still waits for sync. The old opaque cover was
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
Target-specific history hydration and painting still occur after selection.

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

Snapshots merge into the existing document before constructing its history reader;
unsent edits remain intact. A measured alternative that imported into an already
initialized reader removed waiting but replayed bulk-import events through its
projection, greatly increasing large-history cost, so it was rejected. No second
UI store, Mirror, daemon connection, or shared persistence/cursor is introduced.
Cloud and dual-mode runtimes do not participate in peer sharing.

## Verification and limits

46 deterministic component tests plus nine shared IPC tests cover adoption,
recovery, matching-sender/target reveal, hidden preparation, timeout/close cleanup,
replacement timing, metadata races, CRDT reuse/merge, peer absence and cache selection.
Provider lifecycle coverage verifies preparation before routing, retention across
ready/in-flight claims, scope replacement, identity gating, and disposal.
Components and Electron typechecks pass. Changed helper/benchmark lint is clean.

The [benchmark](../../../../packages/components/benchmarks/window-bootstrap/README.md)
retains the original regression and the corrected measurements. It uses two real
Electron renderers, native BroadcastChannel/Web Locks/IndexedDB, synthetic CRDT
history, and the production reader. A native presentation probe runs production
main/renderer readiness code and captures the first shown synthetic surface with
30 readable rows. This verifies the presentation ordering, not the full Lody React
interface. Those recorded timings predate workspace runtime preinitialization;
they do not measure its latency benefit. Click-to-show and data-readiness measurements must not be conflated.

Real application visual acceptance remains unverified; E2E disables the warm pool
and this checkout lacks complete desktop/CLI build artifacts and ACP submodules.
`pnpm check` stops at missing `packages/ignore` dependencies. `check:public-boundary`
and `docs check` report existing references to those absent submodules.
