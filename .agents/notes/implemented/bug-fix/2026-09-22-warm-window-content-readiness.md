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
across matching navigation. Real desktop probes found a hidden virtual-list viewport
after the old readiness signal; presentation now also waits for scroll restoration.
The measured opening path remains about one second, with no demonstrated speedup.

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

The provider, renderer readiness, stream rendering and sticky-scroll suites pass
48 deterministic tests. They cover pre-route initialization, ready/in-flight claim
reuse, scope disposal, mismatched stream identity, and hydrated but hidden content.
The earlier 39 component and nine shared IPC cases cover adoption, metadata races
and snapshot exchange. Components and Electron typechecks pass.

The [benchmark](../../../../packages/components/benchmarks/window-bootstrap/README.md)
separates data-path, synthetic-DOM and real desktop measurements. The real desktop
probe uses a fresh profile, the current React renderer, an existing bundled CLI
0.93.3 and a synthetic 3,000-entry conversation. It records native show, captures
the surface, and checks actual stream visibility. Every preinitialized spare had
its Repo and Session metadata before claim, with no runtime recreation at claim.

The sequential comparison measured 820.30 ms median before runtime preinitialization
(five samples), 1,057.22 ms afterward (ten), and 1,139.32 ms with the visible-stream
fix in the reproducible runner (five). These timings start at target IPC dispatch,
not physical input. They do not demonstrate faster opening. A prior corrected run
included a 2,708.94 ms outlier; samples are too small for stable tail estimates.
The initial baseline probe crashed; the replacement run completed.

The preinitialization-only capture had chrome but no visible message body despite
hydrated history. The corrected first-show captures contain the synthetic answer;
all eight captures per corrected run passed, including three discarded warmups.
This validates the previously omitted React/scroll boundary; the earlier 152.39 ms
synthetic-DOM measurement did not exercise it. Remaining opening latency is unresolved.
The CLI artifact was reused rather than rebuilt from this checkout. Root `pnpm check`
still stops at missing `packages/ignore` dependencies; `docs check` reports existing
links into absent ACP submodules. The PR remains draft.
